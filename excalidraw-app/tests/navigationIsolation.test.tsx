import { act, cleanup, render, waitFor } from "@testing-library/react";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { vi } from "vitest";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import ExcalidrawApp from "../App";
import { appJotaiStore } from "../app-jotai";
import { collabAPIAtom, isCollaboratingAtom } from "../collab/Collab";
import { importFromBackend } from "../data";
import { loadFilesFromFirebase } from "../data/firebase";
import { LocalData } from "../data/LocalData";
import { STORAGE_KEYS } from "../app_constants";

import type { CollabAPI } from "../collab/Collab";

vi.mock("../collab/Collab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../collab/Collab")>()),
  default: () => null,
}));
vi.mock("../data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data")>()),
  importFromBackend: vi.fn(),
}));
vi.mock("../data/firebase", () => ({
  saveToFirebase: vi.fn(),
  loadFromFirebase: vi.fn(),
  loadFilesFromFirebase: vi.fn(),
  saveFilesToFirebase: vi.fn(),
  isSavedToFirebase: vi.fn(() => true),
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};
const keyA = "aaaaaaaaaaaaaaaaaaaaaa";
const keyB = "bbbbbbbbbbbbbbbbbbbbbb";
const scene = (id: string) => ({
  elements: [API.createElement({ type: "rectangle", id })],
});
const privateFile = {
  id: "private-file",
  dataURL: "data:image/png;base64,private",
  mimeType: "image/png",
  created: 1,
} as BinaryFileData;
const navigate = async (hash: string) => {
  await act(async () => {
    window.history.pushState({}, "", hash || window.location.pathname);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
};

let collaborating = false;
let activeRoomLink: string | null = null;
let collabAPI: CollabAPI;

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  localStorage.clear();
  collaborating = false;
  activeRoomLink = null;
  collabAPI = {
    isCollaborating: () => collaborating,
    getActiveRoomLink: () => activeRoomLink,
    startCollaboration: vi.fn(async ({ roomId, roomKey }) => {
      collaborating = true;
      activeRoomLink = `${window.location.origin}/#room=${roomId},${roomKey}`;
      // Exercise the same reset used by the real imperative collaboration API.
      // eslint-disable-next-line dot-notation
      window.h.app["resetScene"]();
      return scene(roomId);
    }),
    stopCollaboration: vi.fn(() => {
      collaborating = false;
      activeRoomLink = null;
    }),
    fetchImageFilesFromFirebase: vi.fn(async () => ({
      loadedFiles: [],
      erroredFiles: new Map(),
    })),
    syncElements: vi.fn(),
    getUsername: () => "test",
    setUsername: vi.fn(),
    setUserToFollow: vi.fn(),
    setCollabError: vi.fn(),
    onPointerUpdate: vi.fn(),
  } as unknown as CollabAPI;
  appJotaiStore.set(collabAPIAtom, collabAPI);
  appJotaiStore.set(isCollaboratingAtom, false);
  vi.mocked(loadFilesFromFirebase).mockResolvedValue({
    loadedFiles: [],
    erroredFiles: new Map(),
  });
});

afterEach(() => {
  cleanup();
  LocalData.flushSave();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  appJotaiStore.set(collabAPIAtom, null);
  appJotaiStore.set(isCollaboratingAtom, false);
  window.history.replaceState({}, "", "/");
  localStorage.clear();
});

describe("scene navigation isolation", () => {
  it("discards a delayed initial snapshot after entering a room, including its URL rewrite", async () => {
    const imported = deferred<Awaited<ReturnType<typeof importFromBackend>>>();
    vi.mocked(importFromBackend).mockReturnValueOnce(imported.promise);
    window.history.replaceState({}, "", `/#json=snapshot,${keyA}`);
    render(<ExcalidrawApp />);
    await waitFor(() => expect(importFromBackend).toHaveBeenCalled());

    await navigate(`#room=roomB,${keyB}`);
    await waitFor(() =>
      expect(window.h.elements.map((el) => el.id)).toEqual(["roomB"]),
    );
    await act(async () => imported.resolve(scene("private-snapshot")));

    expect(window.location.hash).toBe(`#room=roomB,${keyB}`);
    expect(window.h.elements.map((el) => el.id)).toEqual(["roomB"]);
    expect(collabAPI.syncElements).not.toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: "private-snapshot" }),
      ]),
    );
  });

  it("rejects a stale completion even before the hashchange event is delivered", async () => {
    const imported = deferred<Awaited<ReturnType<typeof importFromBackend>>>();
    vi.mocked(importFromBackend).mockReturnValueOnce(imported.promise);
    window.history.replaceState({}, "", `/#json=snapshot,${keyA}`);
    render(<ExcalidrawApp />);
    await waitFor(() => expect(importFromBackend).toHaveBeenCalled());
    await act(async () => {
      window.history.pushState({}, "", `/#room=roomB,${keyB}`);
      imported.resolve(scene("private-snapshot"));
    });
    expect(window.location.hash).toBe(`#room=roomB,${keyB}`);
    expect(window.h.elements).toHaveLength(0);
  });

  it("does not rewrite the URL when a pending snapshot resolves after unmount", async () => {
    const imported = deferred<Awaited<ReturnType<typeof importFromBackend>>>();
    vi.mocked(importFromBackend).mockReturnValueOnce(imported.promise);
    window.history.replaceState({}, "", `/#json=snapshot,${keyA}`);
    const rendered = render(<ExcalidrawApp />);
    await waitFor(() => expect(importFromBackend).toHaveBeenCalled());
    rendered.unmount();
    await act(async () => imported.resolve(scene("private-snapshot")));
    expect(window.location.hash).toBe(`#json=snapshot,${keyA}`);
  });

  it.each([
    ["roomB", keyB],
    ["roomA", keyB],
  ])(
    "stops the old room before joining %s with a changed identity",
    async (roomId, roomKey) => {
      render(<ExcalidrawApp />);
      await waitFor(() => expect(window.h.state.isLoading).toBe(false));
      await navigate(`#room=roomA,${keyA}`);
      await waitFor(() =>
        expect(window.h.elements.map((el) => el.id)).toEqual(["roomA"]),
      );
      await navigate(`#room=${roomId},${roomKey}`);
      await waitFor(() =>
        expect(collabAPI.startCollaboration).toHaveBeenCalledTimes(2),
      );
      expect(collabAPI.stopCollaboration).toHaveBeenCalledTimes(1);
      expect(collabAPI.stopCollaboration).toHaveBeenCalledWith(false);
      expect(
        vi.mocked(collabAPI.stopCollaboration).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(collabAPI.startCollaboration).mock.invocationCallOrder[1],
      );
      expect(collabAPI.startCollaboration).toHaveBeenLastCalledWith({
        roomId,
        roomKey,
      });
    },
  );

  it("cancels an in-progress room start before joining the next room", async () => {
    const firstRoom =
      deferred<Awaited<ReturnType<CollabAPI["startCollaboration"]>>>();
    vi.mocked(collabAPI.startCollaboration).mockImplementationOnce(() => {
      collaborating = true;
      return firstRoom.promise;
    });
    window.history.replaceState({}, "", `/#room=roomA,${keyA}`);
    render(<ExcalidrawApp />);
    await waitFor(() =>
      expect(collabAPI.startCollaboration).toHaveBeenCalledTimes(1),
    );
    await navigate(`#room=roomB,${keyB}`);
    await waitFor(() =>
      expect(window.h.elements.map((el) => el.id)).toEqual(["roomB"]),
    );
    await act(async () =>
      firstRoom.resolve(
        scene("private-roomA") as Awaited<
          ReturnType<CollabAPI["startCollaboration"]>
        >,
      ),
    );
    expect(collabAPI.stopCollaboration).toHaveBeenCalledTimes(1);
    expect(collabAPI.stopCollaboration).toHaveBeenCalledWith(false);
    expect(window.h.elements.map((el) => el.id)).toEqual(["roomB"]);
  });

  it.each(["navigate", "unmount"])(
    "ignores delayed snapshot images after %s",
    async (action) => {
      const files =
        deferred<Awaited<ReturnType<typeof loadFilesFromFirebase>>>();
      vi.mocked(loadFilesFromFirebase).mockReturnValueOnce(files.promise);
      const image = API.createElement({
        type: "image",
        fileId: "private-file",
        status: "saved",
      });
      vi.mocked(importFromBackend).mockResolvedValueOnce({ elements: [image] });
      window.history.replaceState({}, "", `/#json=snapshot,${keyA}`);
      const rendered = render(<ExcalidrawApp />);
      await waitFor(() => expect(loadFilesFromFirebase).toHaveBeenCalled());
      const addFiles = vi.spyOn(window.h.app, "addFiles");
      if (action === "navigate") {
        await navigate(`#room=roomB,${keyB}`);
        await waitFor(() =>
          expect(window.h.elements.map((el) => el.id)).toEqual(["roomB"]),
        );
      } else {
        rendered.unmount();
      }
      addFiles.mockClear();
      await act(async () =>
        files.resolve({ loadedFiles: [privateFile], erroredFiles: new Map() }),
      );
      expect(addFiles).not.toHaveBeenCalled();
    },
  );

  it.each(["navigate", "unmount"])(
    "ignores delayed room images after %s",
    async (action) => {
      const files =
        deferred<
          Awaited<ReturnType<CollabAPI["fetchImageFilesFromFirebase"]>>
        >();
      vi.mocked(collabAPI.fetchImageFilesFromFirebase).mockReturnValueOnce(
        files.promise,
      );
      window.history.replaceState({}, "", `/#room=roomA,${keyA}`);
      const rendered = render(<ExcalidrawApp />);
      await waitFor(() =>
        expect(collabAPI.fetchImageFilesFromFirebase).toHaveBeenCalled(),
      );
      const addFiles = vi.spyOn(window.h.app, "addFiles");
      if (action === "navigate") {
        await navigate(`#room=roomB,${keyB}`);
        await waitFor(() =>
          expect(window.h.elements.map((el) => el.id)).toEqual(["roomB"]),
        );
      } else {
        rendered.unmount();
      }
      addFiles.mockClear();
      await act(async () =>
        files.resolve({ loadedFiles: [privateFile], erroredFiles: new Map() }),
      );
      expect(addFiles).not.toHaveBeenCalled();
    },
  );

  it("ignores delayed local image files after entering a room", async () => {
    const files =
      deferred<Awaited<ReturnType<typeof LocalData.fileStorage.getFiles>>>();
    vi.spyOn(LocalData.fileStorage, "getFiles").mockReturnValueOnce(
      files.promise,
    );
    const image = API.createElement({
      type: "image",
      fileId: "private-local-file",
      status: "saved",
    });
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify([image]),
    );
    render(<ExcalidrawApp />);
    await waitFor(() =>
      expect(LocalData.fileStorage.getFiles).toHaveBeenCalled(),
    );
    await navigate(`#room=roomB,${keyB}`);
    await waitFor(() =>
      expect(window.h.elements.map((el) => el.id)).toEqual(["roomB"]),
    );
    const addFiles = vi.spyOn(window.h.app, "addFiles");
    await act(async () =>
      files.resolve({ loadedFiles: [privateFile], erroredFiles: new Map() }),
    );
    expect(addFiles).not.toHaveBeenCalled();
  });
});
