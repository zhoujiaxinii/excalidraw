import { describe, expect, it, vi } from "vitest";

import type { FileId, ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { FileManager } from "./FileManager";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
};
const file = {
  id: "synthetic-image" as FileId,
  dataURL: "data:image/png;base64,AA==",
  mimeType: "image/png",
  created: 1,
} as BinaryFileData;
const element = {
  type: "image",
  fileId: file.id,
  status: "pending",
  isDeleted: false,
} as ExcalidrawElement;
const emptySave = async () => ({
  savedFiles: new Map<FileId, BinaryFileData>(),
  erroredFiles: new Map<FileId, BinaryFileData>(),
});

describe("cloud file room isolation", () => {
  it("does not publish an old room's fetched files or status after reset", async () => {
    const pending = deferred<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }>();
    const statuses = vi.fn();
    const manager = new FileManager({
      getFiles: () => pending.promise,
      saveFiles: emptySave,
      onFileStatusChange: statuses,
    });
    const result = manager.getFiles([file.id]);
    manager.reset();
    statuses.mockClear();
    pending.resolve({ loadedFiles: [file], erroredFiles: new Map() });
    expect(await result).toEqual({ loadedFiles: [], erroredFiles: new Map() });
    expect(statuses).not.toHaveBeenCalled();
    expect(manager.isFileTracked(file.id)).toBe(false);
  });

  it("does not clear a new room's in-flight fetch when an old fetch finishes", async () => {
    const oldFetch = deferred<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }>();
    const newFetch = deferred<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }>();
    const getFiles = vi
      .fn()
      .mockReturnValueOnce(oldFetch.promise)
      .mockReturnValueOnce(newFetch.promise);
    const manager = new FileManager({ getFiles, saveFiles: emptySave });
    const oldResult = manager.getFiles([file.id]);
    manager.reset();
    const newResult = manager.getFiles([file.id]);
    oldFetch.resolve({
      loadedFiles: [],
      erroredFiles: new Map([[file.id, true]]),
    });
    await oldResult;
    expect(manager.isFileTracked(file.id)).toBe(true);
    newFetch.resolve({ loadedFiles: [file], erroredFiles: new Map() });
    expect((await newResult).loadedFiles).toEqual([file]);
    expect(manager.shouldUpdateImageElementStatus(element)).toBe(true);
  });

  it("never marks a new room's image saved from an old upload completion", async () => {
    const pending = deferred<{
      savedFiles: Map<FileId, BinaryFileData>;
      erroredFiles: Map<FileId, BinaryFileData>;
    }>();
    const manager = new FileManager({
      getFiles: async () => ({ loadedFiles: [], erroredFiles: new Map() }),
      saveFiles: () => pending.promise,
    });
    const result = manager.saveFiles({
      elements: [element],
      files: { [file.id]: file },
    });
    expect(manager.shouldPreventUnload([element])).toBe(true);
    manager.reset();
    pending.resolve({
      savedFiles: new Map([[file.id, file]]),
      erroredFiles: new Map(),
    });
    expect((await result).savedFiles.size).toBe(0);
    expect(manager.shouldUpdateImageElementStatus(element)).toBe(false);
    expect(manager.isFileSavedOrBeingSaved(file)).toBe(false);
  });
});
