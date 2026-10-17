import type { SocketId } from "@excalidraw/excalidraw/types";

import { getRealtimeTopic, getSupabaseClient } from "../data/cloud";

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import type {
  CollaborationSocket,
  CollaborationSocketEmits,
  CollaborationSocketEvents,
} from "./CollaborationSocket";

// Base64 expansion plus the envelope stays comfortably below the 256 KB
// free-plan Broadcast limit. The scene and cursor bytes are already encrypted.
const CHUNK_BYTES = 96 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_MESSAGE_BYTES / CHUNK_BYTES);
const MAX_ASSEMBLIES = 8;
const MAX_BUFFERED_BYTES = 24 * 1024 * 1024;
const ASSEMBLY_TTL_MS = 30_000;
const MIN_REJOIN_MS = 7_000;
const MIN_BROADCAST_INTERVAL_MS = 80;
const MAX_MEMBERS = 200;
const WIRE_EVENT = "excalidraw-v1";
const sessionIds = new WeakMap<Window, SocketId>();

type Chunk = {
  kind: "chunk";
  sender: string;
  id: string;
  index: number;
  total: number;
  data: string;
  iv: string;
  target: string | null;
};

type Control = {
  kind: "hello" | "follow";
  sender: string;
  following: string | null;
};

type Assembly = {
  chunks: Map<number, Uint8Array<ArrayBuffer>>;
  total: number;
  iv: string;
  target: string | null;
  size: number;
  expiresAt: number;
};

type Listener = (...args: never[]) => void;

const randomId = (ownerWindow: Window) =>
  Array.from(ownerWindow.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

const isId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

/** Maps the small Excalidraw protocol to one capability-addressed channel. */
export class SupabaseSocket implements CollaborationSocket {
  readonly id: SocketId;
  connected = false;
  private channel: RealtimeChannel | null = null;
  private subscribed = false;
  private closed = false;
  private everConnected = false;
  private generation = 0;
  private trackedGeneration = -1;
  private lastTrackAt = 0;
  private retryTimer?: number;
  private assemblyTimer?: number;
  private listeners = new Map<string, Set<Listener>>();
  private members = new Set<SocketId>();
  private following: SocketId | null = null;
  private followers = new Set<SocketId>();
  private assemblies = new Map<string, Assembly>();
  private completed = new Map<string, number>();
  private bufferedBytes = 0;
  private pendingSends = 0;
  private nextBroadcastAt = 0;
  private controlPending = false;
  private queuedControl: Control["kind"] | null = null;
  private lastHello = new Map<string, number>();
  private sendChain = Promise.resolve();

  constructor(
    private readonly client: SupabaseClient,
    private readonly topic: string,
    private readonly roomId: string,
    private readonly ownerWindow: Window,
  ) {
    let id = sessionIds.get(ownerWindow);
    if (!id) {
      id = randomId(ownerWindow) as SocketId;
      sessionIds.set(ownerWindow, id);
    }
    this.id = id;
  }

  on<K extends keyof CollaborationSocketEvents>(
    event: K,
    listener: (...args: CollaborationSocketEvents[K]) => void,
  ): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once<K extends keyof CollaborationSocketEvents>(
    event: K,
    listener: (...args: CollaborationSocketEvents[K]) => void,
  ): this {
    const once = (...args: CollaborationSocketEvents[K]) => {
      this.off(event, once);
      listener(...args);
    };
    return this.on(event, once);
  }

  off<K extends keyof CollaborationSocketEvents>(
    event: K,
    listener?: (...args: CollaborationSocketEvents[K]) => void,
  ): this {
    if (listener) {
      this.listeners.get(event)?.delete(listener as Listener);
    } else {
      this.listeners.delete(event);
    }
    return this;
  }

  private dispatch<K extends keyof CollaborationSocketEvents>(
    event: K,
    ...args: CollaborationSocketEvents[K]
  ) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      (listener as (...args: CollaborationSocketEvents[K]) => void)(...args);
    }
  }

  connect() {
    if (this.closed || this.channel) {
      return;
    }
    const channel = this.client.channel(this.topic, {
      config: {
        private: false,
        broadcast: { self: false, ack: true },
        presence: { key: this.id },
      },
    });
    this.channel = channel;
    channel
      .on("broadcast", { event: WIRE_EVENT }, ({ payload }) => {
        if (this.channel === channel && !this.closed) {
          this.receive(payload);
        }
      })
      .on("presence", { event: "sync" }, () => this.syncPresence())
      .subscribe((status, error) => {
        if (this.closed || this.channel !== channel) {
          return;
        }
        if (status === "SUBSCRIBED") {
          this.subscribed = true;
          this.generation++;
          this.dispatch("init-room");
        } else {
          this.fail(
            new Error(
              error?.message ||
                "Live collaboration disconnected. Reconnecting…",
            ),
          );
          // The SDK automatically rejoins CHANNEL_ERROR / TIMED_OUT channels.
          // CLOSED and a failed Presence track need a fresh channel.
          if (status === "CLOSED") {
            this.scheduleRejoin();
          }
        }
      }, 10_000);
    this.assemblyTimer = this.ownerWindow.setInterval(
      () => this.pruneAssemblies(),
      ASSEMBLY_TTL_MS,
    );
  }

  emit<K extends keyof CollaborationSocketEmits>(
    event: K,
    ...args: CollaborationSocketEmits[K]
  ) {
    if (event === "join-room") {
      if (args[0] === this.roomId) {
        void this.joinRoom();
      }
    } else if (event === "user-follow") {
      const [payload] = args as CollaborationSocketEmits["user-follow"];
      if (payload.action === "FOLLOW") {
        this.following = payload.userToFollow.socketId;
      } else if (this.following === payload.userToFollow.socketId) {
        this.following = null;
      }
      this.sendControl("follow");
    } else {
      const [target, data, iv] =
        args as CollaborationSocketEmits["server-broadcast"];
      const followTarget = target === `follow@${this.id}` ? this.id : null;
      if (target !== this.roomId && !followTarget) {
        return;
      }
      this.broadcast(
        data,
        iv,
        followTarget,
        event === "server-volatile-broadcast",
      );
    }
  }

  private async joinRoom() {
    const channel = this.channel;
    const generation = this.generation;
    if (!channel || !this.subscribed || this.trackedGeneration === generation) {
      return;
    }
    this.trackedGeneration = generation;
    // Presence is intentionally low-frequency. Cursor and follow updates use
    // Broadcast, avoiding the five Presence calls / client / 30 seconds quota.
    const delay = Math.max(0, this.lastTrackAt + MIN_REJOIN_MS - Date.now());
    if (delay) {
      await new Promise<void>((resolve) =>
        this.ownerWindow.setTimeout(resolve, delay),
      );
    }
    if (
      this.closed ||
      channel !== this.channel ||
      generation !== this.generation ||
      !this.subscribed
    ) {
      return;
    }
    this.lastTrackAt = Date.now();
    try {
      const status = await channel.track({ id: this.id });
      if (
        this.closed ||
        channel !== this.channel ||
        generation !== this.generation ||
        !this.subscribed
      ) {
        return;
      }
      if (status !== "ok") {
        throw new Error("Unable to join live collaboration. Reconnecting…");
      }
      this.connected = true;
      this.ownerWindow.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      const reconnecting = this.everConnected;
      this.everConnected = true;
      this.dispatch(reconnecting ? "reconnect" : "connect");
      this.syncPresence();
      this.sendControl("hello");
    } catch (error) {
      if (channel === this.channel && !this.closed) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        this.scheduleRejoin();
      }
    }
  }

  private syncPresence() {
    if (!this.connected || !this.channel) {
      return;
    }
    const members = new Set<SocketId>();
    for (const [key, presences] of Object.entries(
      this.channel.presenceState<{ id: string }>(),
    )) {
      if (members.size >= MAX_MEMBERS) {
        break;
      }
      if (isId(key) && presences.some((presence) => presence.id === key)) {
        members.add(key as SocketId);
      }
    }
    // Wait for our own acknowledged Presence before electing the first peer.
    if (!members.has(this.id)) {
      return;
    }
    const previous = this.members;
    this.members = members;
    this.dispatch("room-user-change", [...members]);
    for (const member of members) {
      if (member !== this.id && !previous.has(member)) {
        this.dispatch("new-user", member);
      }
    }
    for (const follower of this.followers) {
      if (!members.has(follower)) {
        this.followers.delete(follower);
      }
    }
    for (const member of this.lastHello.keys()) {
      if (!members.has(member as SocketId)) {
        this.lastHello.delete(member);
      }
    }
    this.dispatch("user-follow-room-change", [...this.followers]);
    if (members.size === 1) {
      this.dispatch("first-in-room");
    }
  }

  private fail(error: Error) {
    const wasConnected = this.connected;
    this.connected = false;
    this.subscribed = false;
    this.members.clear();
    this.followers.clear();
    this.clearAssemblies();
    this.dispatch("room-user-change", []);
    this.dispatch("user-follow-room-change", []);
    this.dispatch(
      wasConnected || this.everConnected ? "disconnect" : "connect_error",
      error,
    );
  }

  private scheduleRejoin() {
    if (this.closed || this.retryTimer !== undefined) {
      return;
    }
    this.retryTimer = this.ownerWindow.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.closed) {
        return;
      }
      const channel = this.channel;
      this.channel = null;
      if (channel) {
        void this.client.removeChannel(channel);
      }
      this.ownerWindow.clearInterval(this.assemblyTimer);
      this.connect();
    }, MIN_REJOIN_MS);
  }

  private sendControl(kind: Control["kind"]) {
    if (!this.connected) {
      return;
    }
    if (this.controlPending) {
      this.queuedControl = this.queuedControl === "hello" ? "hello" : kind;
      return;
    }
    this.controlPending = true;
    void this.send({ kind, sender: this.id, following: this.following })
      .catch((error) => this.reportSendError(error))
      .finally(() => {
        this.controlPending = false;
        const queued = this.queuedControl;
        this.queuedControl = null;
        if (queued) {
          this.sendControl(queued);
        }
      });
  }

  private async send(payload: Chunk | Control) {
    const channel = this.channel;
    if (!this.connected || !channel) {
      return;
    }
    const generation = this.generation;
    const sendAt = Math.max(Date.now(), this.nextBroadcastAt);
    this.nextBroadcastAt = sendAt + MIN_BROADCAST_INTERVAL_MS;
    if (sendAt > Date.now()) {
      await new Promise<void>((resolve) =>
        this.ownerWindow.setTimeout(resolve, sendAt - Date.now()),
      );
    }
    if (
      !this.connected ||
      this.closed ||
      channel !== this.channel ||
      generation !== this.generation
    ) {
      return;
    }
    const status = await channel.send({
      type: "broadcast",
      event: WIRE_EVENT,
      payload,
    });
    if (channel === this.channel && !this.closed && status !== "ok") {
      throw new Error(
        "Live collaboration could not send an update. Reconnecting…",
      );
    }
  }

  private reportSendError(error: unknown) {
    if (!this.closed) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      this.scheduleRejoin();
    }
  }

  private encode(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return this.ownerWindow.btoa(binary);
  }

  private decode(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(this.ownerWindow.atob(value), (char) =>
      char.charCodeAt(0),
    );
  }

  private broadcast(
    data: ArrayBuffer,
    iv: Uint8Array<ArrayBuffer>,
    target: string | null,
    volatile: boolean,
  ) {
    if (!this.connected || (volatile && this.pendingSends > 0)) {
      return;
    }
    if (data.byteLength > MAX_MESSAGE_BYTES || iv.byteLength !== 12) {
      this.dispatch(
        "error",
        new Error("This scene is too large for live collaboration."),
      );
      return;
    }
    // Never retain an unbounded queue when the network is slower than editing.
    // The existing full-scene rebroadcast and durable snapshot repair a drop.
    if (this.pendingSends >= 4) {
      return;
    }
    this.pendingSends++;
    const generation = this.generation;
    this.sendChain = this.sendChain.then(async () => {
      try {
        const bytes = new Uint8Array(data);
        const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
        const id = randomId(this.ownerWindow);
        const encodedIV = this.encode(iv);
        for (let index = 0; index < total; index++) {
          if (
            !this.connected ||
            generation !== this.generation ||
            this.closed
          ) {
            return;
          }
          await this.send({
            kind: "chunk",
            sender: this.id,
            id,
            index,
            total,
            data: this.encode(
              bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES),
            ),
            iv: encodedIV,
            target,
          });
        }
      } catch (error) {
        this.reportSendError(error);
      } finally {
        this.pendingSends--;
      }
    });
  }

  private receive(payload: unknown) {
    if (!this.connected || !payload || typeof payload !== "object") {
      return;
    }
    const value = payload as Partial<{
      kind: string;
      sender: string;
      id: string;
      index: number;
      total: number;
      data: string;
      iv: string;
      target: string | null;
      following: string | null;
    }>;
    if (
      !isId(value.sender) ||
      value.sender === this.id ||
      !this.members.has(value.sender as SocketId)
    ) {
      return;
    }
    if (value.kind === "hello" || value.kind === "follow") {
      if (value.following !== null && !isId(value.following)) {
        return;
      }
      const wasFollowing = this.followers.has(value.sender as SocketId);
      if (value.following === this.id) {
        this.followers.add(value.sender as SocketId);
      } else {
        this.followers.delete(value.sender as SocketId);
      }
      if (wasFollowing !== this.followers.has(value.sender as SocketId)) {
        this.dispatch("user-follow-room-change", [...this.followers]);
      }
      if (
        value.kind === "hello" &&
        Date.now() - (this.lastHello.get(value.sender) ?? 0) > 10_000
      ) {
        this.lastHello.set(value.sender, Date.now());
        this.dispatch("new-user", value.sender as SocketId);
        // Rejoining peers recover follow subscriptions without Presence writes.
        this.sendControl("follow");
      }
      return;
    }
    if (
      value.kind !== "chunk" ||
      !isId(value.id) ||
      !Number.isInteger(value.index) ||
      !Number.isInteger(value.total) ||
      value.total! < 1 ||
      value.total! > MAX_CHUNKS ||
      value.index! < 0 ||
      value.index! >= value.total! ||
      typeof value.data !== "string" ||
      value.data.length > (CHUNK_BYTES * 4) / 3 ||
      typeof value.iv !== "string" ||
      value.iv.length !== 16 ||
      (value.target !== null && value.target !== value.sender) ||
      (value.target !== null && value.target !== this.following)
    ) {
      return;
    }
    this.pruneAssemblies();
    const key = `${value.sender}:${value.id}`;
    if (this.completed.has(key)) {
      return;
    }
    let assembly = this.assemblies.get(key);
    if (!assembly) {
      if (this.assemblies.size >= MAX_ASSEMBLIES) {
        return;
      }
      assembly = {
        chunks: new Map(),
        total: value.total!,
        iv: value.iv,
        target: value.target,
        size: 0,
        expiresAt: Date.now() + ASSEMBLY_TTL_MS,
      };
      this.assemblies.set(key, assembly);
    }
    if (
      assembly.total !== value.total ||
      assembly.iv !== value.iv ||
      assembly.target !== value.target ||
      assembly.chunks.has(value.index!)
    ) {
      return;
    }
    try {
      const chunk = this.decode(value.data);
      if (
        chunk.byteLength > CHUNK_BYTES ||
        assembly.size + chunk.byteLength > MAX_MESSAGE_BYTES ||
        this.bufferedBytes + chunk.byteLength > MAX_BUFFERED_BYTES
      ) {
        this.removeAssembly(key);
        return;
      }
      assembly.chunks.set(value.index!, chunk);
      assembly.size += chunk.byteLength;
      this.bufferedBytes += chunk.byteLength;
      if (assembly.chunks.size === assembly.total) {
        const iv = this.decode(assembly.iv);
        if (iv.byteLength !== 12) {
          this.removeAssembly(key);
          return;
        }
        const bytes = new Uint8Array(assembly.size);
        let offset = 0;
        for (let index = 0; index < assembly.total; index++) {
          const part = assembly.chunks.get(index)!;
          bytes.set(part, offset);
          offset += part.length;
        }
        this.removeAssembly(key);
        // Bound duplicate detection independently from incomplete assemblies.
        if (this.completed.size >= 256) {
          this.completed.delete(this.completed.keys().next().value!);
        }
        this.completed.set(key, Date.now() + ASSEMBLY_TTL_MS);
        this.dispatch("client-broadcast", bytes.buffer, iv);
      }
    } catch {
      this.removeAssembly(key);
    }
  }

  private removeAssembly(key: string) {
    const assembly = this.assemblies.get(key);
    if (assembly) {
      this.bufferedBytes -= assembly.size;
      this.assemblies.delete(key);
    }
  }

  private pruneAssemblies() {
    const now = Date.now();
    for (const [key, assembly] of this.assemblies) {
      if (assembly.expiresAt <= now) {
        this.removeAssembly(key);
      }
    }
    for (const [key, expiresAt] of this.completed) {
      if (expiresAt <= now) {
        this.completed.delete(key);
      }
    }
  }

  private clearAssemblies() {
    this.assemblies.clear();
    this.completed.clear();
    this.lastHello.clear();
    this.bufferedBytes = 0;
  }

  close() {
    this.closed = true;
    this.queuedControl = null;
    this.connected = false;
    this.subscribed = false;
    this.generation++;
    this.ownerWindow.clearTimeout(this.retryTimer);
    this.ownerWindow.clearInterval(this.assemblyTimer);
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      void this.client.removeChannel(channel);
    }
    this.clearAssemblies();
    this.listeners.clear();
  }
}

export const createSupabaseSocket = async (
  roomId: string,
  roomKey: string,
  ownerWindow: Window,
): Promise<CollaborationSocket> => {
  const client = await getSupabaseClient();
  const topic = await getRealtimeTopic(roomId, roomKey);
  return new SupabaseSocket(client, topic, roomId, ownerWindow);
};
