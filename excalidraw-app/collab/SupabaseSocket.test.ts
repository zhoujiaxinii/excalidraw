import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SupabaseSocket } from "./SupabaseSocket";

import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("../data/cloud", () => ({
  getSupabaseClient: vi.fn(),
  getRealtimeTopic: vi.fn(),
}));

const ROOM = "a".repeat(20);
const TOPIC = `room:${"b".repeat(64)}`;
const PEER = "c".repeat(32);
const IV = new Uint8Array(12).fill(7);
let nextId = 0;

class MockChannel {
  callbacks = new Map<string, (payload?: any) => void>();
  state: Record<string, { id: string }[]> = {};
  subscription?: (status: any, error?: Error) => void;
  track = vi.fn(async ({ id }: { id: string }) => {
    this.state[id] = [{ id }];
    this.callbacks.get("presence:sync")?.();
    return "ok";
  });
  send = vi.fn(async (_message: any) => "ok");
  on(
    type: string,
    { event }: { event: string },
    callback: (payload?: any) => void,
  ) {
    this.callbacks.set(`${type}:${event}`, callback);
    return this;
  }
  subscribe(callback: (status: any, error?: Error) => void) {
    this.subscription = callback;
    return this;
  }
  presenceState() {
    return this.state;
  }
  receive(payload: unknown) {
    this.callbacks.get("broadcast:excalidraw-v1")?.({ payload });
  }
  presence(ids: string[]) {
    this.state = Object.fromEntries(ids.map((id) => [id, [{ id }]]));
    this.callbacks.get("presence:sync")?.();
  }
}

const createSocket = () => {
  const channel = new MockChannel();
  const client = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(async () => "ok"),
  };
  const ownerWindow = {
    crypto: {
      getRandomValues: (array: Uint8Array) => {
        array.fill(++nextId);
        return array;
      },
    },
    btoa: window.btoa.bind(window),
    atob: window.atob.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
  } as unknown as Window;
  const socket = new SupabaseSocket(
    client as unknown as SupabaseClient,
    TOPIC,
    ROOM,
    ownerWindow,
  );
  socket.on("init-room", () => socket.emit("join-room", ROOM));
  return { socket, channel, client };
};

const connect = async (socket: SupabaseSocket, channel: MockChannel) => {
  socket.connect();
  channel.subscription?.("SUBSCRIBED");
  await vi.advanceTimersByTimeAsync(0);
};

const chunk = (overrides: Record<string, unknown> = {}) => ({
  kind: "chunk",
  sender: PEER,
  id: "d".repeat(32),
  index: 0,
  total: 1,
  iv: btoa(String.fromCharCode(...IV)),
  data: btoa("encrypted"),
  target: null,
  ...overrides,
});

describe("Supabase collaboration transport", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports connected only after Presence succeeds and implements once/off", async () => {
    const { socket, channel, client } = createSocket();
    const first = vi.fn();
    const removed = vi.fn();
    socket.once("first-in-room", first);
    socket.on("connect", removed).off("connect", removed);
    expect(socket.connected).toBe(false);
    await connect(socket, channel);
    expect(socket.connected).toBe(true);
    expect(channel.track).toHaveBeenCalledWith({ id: socket.id });
    expect(client.channel).toHaveBeenCalledWith(TOPIC, {
      config: {
        private: false,
        broadcast: { self: false, ack: true },
        presence: { key: socket.id },
      },
    });
    channel.presence([socket.id]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
    socket.close();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
    expect(socket.connected).toBe(false);
  });

  it("does not falsely connect when Presence fails", async () => {
    const { socket, channel } = createSocket();
    channel.track.mockResolvedValue("error");
    const errors = vi.fn();
    socket.on("connect_error", errors);
    await connect(socket, channel);
    expect(socket.connected).toBe(false);
    expect(errors).toHaveBeenCalledTimes(1);
    socket.close();
  });

  it("retracks Presence after reconnect and retains the browser session identity", async () => {
    const { socket, channel } = createSocket();
    const reconnect = vi.fn();
    socket.on("reconnect", reconnect);
    await connect(socket, channel);
    const id = socket.id;
    channel.subscription?.("CHANNEL_ERROR", new Error("offline"));
    expect(socket.connected).toBe(false);
    channel.subscription?.("SUBSCRIBED");
    await vi.advanceTimersByTimeAsync(6999);
    expect(channel.track).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(channel.track).toHaveBeenCalledTimes(2);
    expect(socket.connected).toBe(true);
    expect(socket.id).toBe(id);
    expect(reconnect).toHaveBeenCalledTimes(1);
    socket.close();
  });

  it("chunks encrypted scenes below 256 KB and reassembles out of order once", async () => {
    const { socket, channel } = createSocket();
    await connect(socket, channel);
    channel.presence([socket.id, PEER]);
    const received = vi.fn();
    socket.on("client-broadcast", received);
    const bytes = new Uint8Array(300_000).map((_, index) => index % 256);
    socket.emit("server-broadcast", ROOM, bytes.buffer, IV);
    await vi.advanceTimersByTimeAsync(1000);
    const frames = channel.send.mock.calls
      .map(([message]) => message.payload)
      .filter((payload) => payload.kind === "chunk");
    expect(frames).toHaveLength(4);
    for (const frame of frames.reverse()) {
      expect(
        new TextEncoder().encode(JSON.stringify(frame)).length,
      ).toBeLessThan(256 * 1024);
      channel.receive({ ...frame, sender: PEER });
    }
    expect(received).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(received.mock.calls[0][0])).toEqual(bytes);
    expect(received.mock.calls[0][1]).toEqual(IV);
    channel.receive({ ...frames[0], sender: PEER });
    expect(received).toHaveBeenCalledTimes(1);
    socket.close();
  });

  it("ignores oversized, invalid, unknown-peer and expired partial messages", async () => {
    const { socket, channel } = createSocket();
    await connect(socket, channel);
    channel.presence([socket.id, PEER]);
    const received = vi.fn();
    socket.on("client-broadcast", received);
    channel.receive(chunk({ total: 1_000_000 }));
    channel.receive(chunk({ data: "x".repeat(256 * 1024) }));
    channel.receive(chunk({ data: "%%%" }));
    channel.receive(chunk({ sender: "e".repeat(32) }));
    channel.receive(chunk({ total: 2, index: 0 }));
    await vi.advanceTimersByTimeAsync(31_000);
    channel.receive(chunk({ total: 2, index: 1 }));
    expect(received).not.toHaveBeenCalled();
    channel.receive(chunk({ id: "f".repeat(32) }));
    expect(received).toHaveBeenCalledTimes(1);
    socket.close();
  });

  it("routes follow control and encrypted viewport traffic without extra Presence writes", async () => {
    const { socket, channel } = createSocket();
    await connect(socket, channel);
    channel.presence([socket.id, PEER]);
    const followers = vi.fn();
    const received = vi.fn();
    socket.on("user-follow-room-change", followers);
    socket.on("client-broadcast", received);
    channel.receive({ kind: "follow", sender: PEER, following: socket.id });
    expect(followers).toHaveBeenLastCalledWith([PEER]);
    channel.receive(chunk({ target: PEER }));
    expect(received).not.toHaveBeenCalled();
    socket.emit("user-follow", {
      action: "FOLLOW",
      userToFollow: { socketId: PEER as typeof socket.id, username: "Peer" },
    });
    channel.receive(chunk({ target: PEER }));
    expect(received).toHaveBeenCalledTimes(1);
    expect(channel.track).toHaveBeenCalledTimes(1);
    channel.presence([socket.id]);
    expect(followers).toHaveBeenLastCalledWith([]);
    socket.close();
  });

  it("stops queued sends after close and reports failed acknowledgements", async () => {
    const { socket, channel } = createSocket();
    await connect(socket, channel);
    const disconnected = vi.fn();
    socket.on("disconnect", disconnected);
    channel.send.mockResolvedValue("error");
    socket.emit("server-broadcast", ROOM, new Uint8Array(16).buffer, IV);
    await vi.advanceTimersByTimeAsync(200);
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(socket.connected).toBe(false);
    const beforeClose = channel.send.mock.calls.length;
    socket.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channel.send).toHaveBeenCalledTimes(beforeClose);
  });
});
