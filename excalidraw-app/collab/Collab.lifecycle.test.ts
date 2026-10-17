import { afterEach, describe, expect, it, vi } from "vitest";
import { toBrandedType } from "@excalidraw/common";

import { encryptData } from "@excalidraw/excalidraw/data/encryption";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";
import { loadFromFirebase, saveToFirebase } from "../data/firebase";
import { WS_SUBTYPES } from "../app_constants";

import Collab, { isCollaboratingAtom } from "./Collab";
import Portal from "./Portal";
import { createSupabaseSocket } from "./SupabaseSocket";

import type { SocketUpdateData } from "../data";
import type { CollaborationSocket } from "./CollaborationSocket";

vi.mock("../data/firebase", () => ({
  saveToFirebase: vi.fn(),
  loadFromFirebase: vi.fn(),
  loadFilesFromFirebase: vi.fn(),
  saveFilesToFirebase: vi.fn(),
  isSavedToFirebase: vi.fn(() => true),
}));
vi.mock("./SupabaseSocket", () => ({ createSupabaseSocket: vi.fn() }));
vi.mock("@excalidraw/excalidraw/data/encryption", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@excalidraw/excalidraw/data/encryption")
  >()),
  encryptData: vi.fn(),
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};
const socket = () =>
  ({ connected: true, emit: vi.fn() } as unknown as CollaborationSocket);
const activeCollabs: Collab[] = [];

const startRoom = async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, Set<(...args: any[]) => any>>();
  const connection = {
    id: "a".repeat(32) as CollaborationSocket["id"],
    connected: true,
    connect: vi.fn(),
    close: vi.fn(),
    emit: vi.fn(),
    on(event: string, listener: (...args: any[]) => any) {
      const entries = listeners.get(event) ?? new Set();
      entries.add(listener);
      listeners.set(event, entries);
      return this;
    },
    once(event: string, listener: (...args: any[]) => any) {
      const once = (...args: any[]) => {
        this.off(event, once);
        return listener(...args);
      };
      return this.on(event, once);
    },
    off(event: string, listener?: (...args: any[]) => any) {
      if (listener) {
        listeners.get(event)?.delete(listener);
      } else {
        listeners.delete(event);
      }
      return this;
    },
  };
  vi.mocked(createSupabaseSocket).mockResolvedValueOnce(
    connection as CollaborationSocket,
  );
  let elements: any[] = [];
  const collab = new Collab({
    excalidrawAPI: {
      getAppState: () => ({}),
      getSceneElementsIncludingDeleted: () => elements,
      resetScene: vi.fn(),
      updateScene: vi.fn(),
    } as unknown as ExcalidrawImperativeAPI,
  });
  activeCollabs.push(collab);
  collab.state = { ...collab.state, username: "Test" };
  (collab as any).ownerNode.current = document.createElement("span");
  vi.spyOn(collab, "setState").mockImplementation(() => {});
  vi.spyOn(collab as any, "initializeIdleDetector").mockImplementation(
    () => {},
  );
  vi.spyOn(collab as any, "_reconcileElements").mockImplementation(
    (remote) => remote,
  );
  const applyScene = vi
    .spyOn(collab as any, "handleRemoteSceneUpdate")
    .mockImplementation((remote) => {
      elements = remote as any[];
    });
  vi.spyOn(collab.portal, "broadcastScene").mockResolvedValue(undefined);
  const joined = collab.startCollaboration({
    roomId: "a".repeat(20),
    roomKey: "b".repeat(22),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.connect).toHaveBeenCalledOnce();
  const dispatch = (event: string, ...args: any[]) =>
    Promise.all(
      [...(listeners.get(event) ?? [])].map((listener) => listener(...args)),
    );
  return { collab, connection, dispatch, joined, applyScene };
};

describe("collaboration room lifecycle", () => {
  afterEach(() => {
    for (const collab of activeCollabs.splice(0)) {
      (collab as any).destroySocketClient();
      collab.queueSaveToFirebase.cancel();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    appJotaiStore.set(isCollaboratingAtom, false);
  });

  it("never broadcasts old-room ciphertext into a replacement room", async () => {
    const encrypted = deferred<{
      encryptedBuffer: ArrayBuffer;
      iv: Uint8Array<ArrayBuffer>;
    }>();
    vi.mocked(encryptData).mockReturnValueOnce(encrypted.promise);
    const portal = new Portal({} as Collab);
    const first = socket();
    const second = socket();
    portal.socket = first;
    portal.roomId = "first";
    portal.roomKey = "first-key";
    portal.socketInitialized = true;
    const send = portal._broadcastSocketData(
      toBrandedType<SocketUpdateData>({
        type: WS_SUBTYPES.UPDATE,
        payload: { elements: [] },
      }),
    );
    portal.socket = second;
    portal.roomId = "second";
    portal.roomKey = "second-key";
    encrypted.resolve({
      encryptedBuffer: new ArrayBuffer(16),
      iv: new Uint8Array(12),
    });
    await send;
    expect(first.emit).not.toHaveBeenCalled();
    expect(second.emit).not.toHaveBeenCalled();
  });

  it("never merges a delayed save response from a departed room into a new room", async () => {
    const saved = deferred<Awaited<ReturnType<typeof saveToFirebase>>>();
    vi.mocked(saveToFirebase).mockReturnValueOnce(saved.promise);
    const updateScene = vi.fn();
    const collab = new Collab({
      excalidrawAPI: {
        getAppState: () => ({}),
        updateScene,
        getSceneElementsIncludingDeleted: () => [],
      } as unknown as ExcalidrawImperativeAPI,
    });
    appJotaiStore.set(isCollaboratingAtom, true);
    collab.portal.socket = socket();
    collab.portal.roomId = "first";
    collab.portal.roomKey = "first-key";
    const save = collab.saveCollabRoomToFirebase([]);
    collab.portal.socket = socket();
    collab.portal.roomId = "second";
    collab.portal.roomKey = "second-key";
    saved.resolve([]);
    await save;
    expect(updateScene).not.toHaveBeenCalled();
  });

  it("does not settle initialization with a stale load while a newer load is pending", async () => {
    const stale = deferred<Awaited<ReturnType<typeof loadFromFirebase>>>();
    const current = deferred<Awaited<ReturnType<typeof loadFromFirebase>>>();
    vi.mocked(loadFromFirebase)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    const { collab, dispatch, joined } = await startRoom();
    let settled = false;
    void joined.then(() => {
      settled = true;
    });
    (collab as any).fallbackInitializationHandler();
    await dispatch("first-in-room");
    stale.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    current.resolve([]);
    await expect(joined).resolves.toMatchObject({
      elements: [],
      scrollToContent: true,
    });
  });

  it("ignores a previous reconnect load and finally after the same socket reconnects again", async () => {
    const stale = deferred<Awaited<ReturnType<typeof loadFromFirebase>>>();
    const current = deferred<Awaited<ReturnType<typeof loadFromFirebase>>>();
    vi.mocked(loadFromFirebase)
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(current.promise);
    const { collab, connection, dispatch, joined, applyScene } =
      await startRoom();
    const firstReconnect = dispatch("reconnect");
    connection.connected = false;
    await dispatch("disconnect", new Error("offline"));
    connection.connected = true;
    const secondReconnect = dispatch("reconnect");
    stale.resolve([]);
    await firstReconnect;
    expect(applyScene).not.toHaveBeenCalled();
    expect(collab.portal.socketInitialized).toBe(false);
    expect(collab.portal.broadcastScene).not.toHaveBeenCalled();
    current.resolve([]);
    await secondReconnect;
    expect(applyScene).toHaveBeenCalledOnce();
    expect(collab.portal.socketInitialized).toBe(true);
    expect(collab.portal.broadcastScene).toHaveBeenCalledOnce();
    await expect(joined).resolves.toMatchObject({ elements: [] });
  });

  it("resolves pending first initialization when a reconnect supersedes it", async () => {
    const initial = deferred<Awaited<ReturnType<typeof loadFromFirebase>>>();
    const reconnected =
      deferred<Awaited<ReturnType<typeof loadFromFirebase>>>();
    vi.mocked(loadFromFirebase)
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(reconnected.promise);
    const { collab, dispatch, joined } = await startRoom();
    (collab as any).fallbackInitializationHandler();
    const reconnect = dispatch("reconnect");
    reconnected.resolve([]);
    await reconnect;
    await expect(joined).resolves.toMatchObject({ elements: [] });
    initial.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
  });
});
