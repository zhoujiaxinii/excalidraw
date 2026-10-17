// Kept under its historical filename so the app's existing storage call sites
// use the owned cloud backend without changing Excalidraw's drawing engine.
import { reconcileElements } from "@excalidraw/excalidraw";
import { cloneJSON, MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";

import {
  base64ToBytes,
  bytesToBase64,
  CloudRequestError,
  cloudRequest,
  parseCloudFilePrefix,
  readCloudScene,
  writeCloudScene,
} from "./cloud";
import {
  cloudSaveStateAtom,
  cloudPendingUploadsAtom,
  cloudFileErrorAtom,
} from "./cloudStatus";
import { CoalescingSaveQueue } from "./CoalescingSaveQueue";

import { getSyncableElements } from ".";

import type { CloudScene } from "./cloud";
import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { CollaborationSocket } from "../collab/CollaborationSocket";

type SavedScene = {
  version: number;
  inputVersion: number;
  elements: readonly SyncableExcalidrawElement[];
};
const savedScenes = new WeakMap<CollaborationSocket, Map<string, SavedScene>>();
const roomScope = (roomId: string, roomKey: string) => `${roomId}:${roomKey}`;

const rememberSavedScene = (
  socket: CollaborationSocket,
  scope: string,
  elements: readonly SyncableExcalidrawElement[],
  inputVersion: number,
) => {
  let rooms = savedScenes.get(socket);
  if (!rooms) {
    rooms = new Map();
    savedScenes.set(socket, rooms);
  }
  rooms.set(scope, {
    version: getSceneVersion(elements),
    inputVersion,
    elements,
  });
};

type SceneSave = {
  roomId: string;
  roomKey: string;
  socket: CollaborationSocket;
  elements: readonly SyncableExcalidrawElement[];
  appState: AppState;
};

// Excalidraw+ is a separate service; this self-hosted deployment does not export
// user documents to the upstream provider's Firebase account.
export const loadFirebaseStorage = async (): Promise<never> => {
  throw new Error("Excalidraw+ export is not enabled on this deployment.");
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<Omit<CloudScene, "revision">> => {
  const { encryptedBuffer, iv } = await encryptData(
    key,
    new TextEncoder().encode(JSON.stringify(elements)),
  );
  return {
    sceneVersion: getSceneVersion(elements),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encryptedBuffer)),
  };
};

const decryptElements = async (scene: CloudScene, key: string) => {
  const plaintext = await decryptData(
    base64ToBytes(scene.iv),
    base64ToBytes(scene.ciphertext),
    key,
  );
  return getSyncableElements(
    restoreElements(JSON.parse(new TextDecoder().decode(plaintext)), null),
  );
};

const saveScene = async ({
  roomId,
  roomKey,
  socket,
  elements,
  appState,
}: SceneSave) => {
  const scope = roomScope(roomId, roomKey);
  const inputVersion = getSceneVersion(elements);
  const saved = savedScenes.get(socket)?.get(scope);
  if (saved?.version === inputVersion || saved?.inputVersion === inputVersion) {
    // A duplicate request queued during the previous save needs its reconciled
    // result, but does not need another GET/encrypt/PUT cycle.
    return toBrandedType<readonly RemoteExcalidrawElement[]>(saved.elements);
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    let previous: CloudScene | null = null;
    try {
      previous = await readCloudScene(roomId, roomKey);
    } catch (error) {
      // Missing and inaccessible rooms intentionally share the same status.
      // A create attempt can initialize a missing room, but never overwrite
      // an existing room owned by another capability.
      if (!(error instanceof CloudRequestError && error.status === 403)) {
        throw error;
      }
    }
    const reconciled = previous
      ? getSyncableElements(
          reconcileElements(
            elements,
            (await decryptElements(
              previous,
              roomKey,
            )) as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
            appState,
          ),
        )
      : elements;
    try {
      const stored = await writeCloudScene(
        roomId,
        roomKey,
        await encryptElements(roomKey, reconciled),
        previous?.revision ?? null,
      );
      const storedElements = await decryptElements(stored, roomKey);
      rememberSavedScene(socket, scope, storedElements, inputVersion);
      return toBrandedType<readonly RemoteExcalidrawElement[]>(storedElements);
    } catch (error) {
      if (!(error instanceof CloudRequestError && error.status === 409)) {
        throw error;
      }
    }
  }
  throw new Error(
    "The drawing changed while saving. Please retry once collaborators finish their current edit.",
  );
};

const sceneSaveQueue = new CoalescingSaveQueue(saveScene);

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
) => {
  const { socket, roomId, roomKey } = portal;
  if (!socket || !roomId || !roomKey) {
    return true;
  }
  const scope = roomScope(roomId, roomKey);
  return (
    !sceneSaveQueue.isBusy(socket, scope) &&
    savedScenes.get(socket)?.get(scope)?.version === getSceneVersion(elements)
  );
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (!roomId || !roomKey || !socket || isSavedToFirebase(portal, elements)) {
    return null;
  }
  const isCurrentRoom = () =>
    portal.socket === socket &&
    portal.roomId === roomId &&
    portal.roomKey === roomKey;
  appJotaiStore.set(cloudSaveStateAtom, "saving");
  try {
    const storedElements = await sceneSaveQueue.enqueue(
      socket,
      roomScope(roomId, roomKey),
      {
        roomId,
        roomKey,
        socket,
        // Image-upload callers can pass live, mutable elements. Capture the
        // requested scene before waiting for an earlier save to finish.
        elements: cloneJSON(elements),
        appState: { ...appState },
      },
    );
    if (!isCurrentRoom()) {
      return null;
    }
    appJotaiStore.set(
      cloudSaveStateAtom,
      isSavedToFirebase(
        portal,
        getSyncableElements(portal.collab.getSceneElementsIncludingDeleted()),
      )
        ? "saved"
        : "saving",
    );
    return storedElements;
  } catch (error) {
    if (!isCurrentRoom()) {
      return null;
    }
    appJotaiStore.set(cloudSaveStateAtom, "error");
    throw error;
  }
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: CollaborationSocket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const scene = await readCloudScene(roomId, roomKey);
  if (!scene) {
    return null;
  }
  const elements = await decryptElements(scene, roomKey);
  if (socket) {
    rememberSavedScene(
      socket,
      roomScope(roomId, roomKey),
      elements,
      getSceneVersion(elements),
    );
  }
  return elements;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
  encryptionKey,
  isCurrentRoom,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
  encryptionKey?: string;
  isCurrentRoom?: () => boolean;
}) => {
  if (!encryptionKey) {
    throw new Error("Cloud file uploads require the drawing's complete link.");
  }
  const { kind, id } = parseCloudFilePrefix(prefix);
  const savedFiles: FileId[] = [];
  const erroredFiles: FileId[] = [];
  if (isCurrentRoom?.()) {
    appJotaiStore.set(cloudPendingUploadsAtom, (count) => count + files.length);
    if (files.length) {
      appJotaiStore.set(cloudFileErrorAtom, false);
    }
  }
  // Sequential uploads avoid unexpectedly exhausting a free project's burst
  // capacity when a large drawing contains many images.
  for (const file of files) {
    try {
      let verifyExisting = false;
      try {
        const response = await cloudRequest(
          kind,
          id,
          encryptionKey,
          `/files/${kind}/${id}/${file.id}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: new Uint8Array(file.buffer),
          },
        );
        verifyExisting = response.status === 200;
      } catch (error) {
        if (!(error instanceof CloudRequestError && error.status === 409)) {
          throw error;
        }
        verifyExisting = true;
      }
      if (verifyExisting) {
        const existing = await cloudRequest(
          kind,
          id,
          encryptionKey,
          `/files/${kind}/${id}/${file.id}`,
        );
        const [actual, expected] = await Promise.all([
          decompressData<BinaryFileMetadata>(
            new Uint8Array(await existing.arrayBuffer()),
            { decryptionKey: encryptionKey },
          ),
          decompressData<BinaryFileMetadata>(new Uint8Array(file.buffer), {
            decryptionKey: encryptionKey,
          }),
        ]);
        if (
          actual.metadata.mimeType !== expected.metadata.mimeType ||
          actual.data.length !== expected.data.length ||
          !actual.data.every((byte, index) => byte === expected.data[index])
        ) {
          throw new Error(
            "The stored image does not match this drawing's image.",
          );
        }
      }
      savedFiles.push(file.id);
    } catch {
      erroredFiles.push(file.id);
      if (isCurrentRoom?.()) {
        appJotaiStore.set(cloudFileErrorAtom, true);
      }
    } finally {
      if (isCurrentRoom?.()) {
        appJotaiStore.set(cloudPendingUploadsAtom, (count) =>
          Math.max(0, count - 1),
        );
      }
    }
  }
  return { savedFiles, erroredFiles };
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  fileIds: readonly FileId[],
) => {
  const { kind, id } = parseCloudFilePrefix(prefix);
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();
  for (const fileId of new Set(fileIds)) {
    try {
      const response = await cloudRequest(
        kind,
        id,
        decryptionKey,
        `/files/${kind}/${id}/${fileId}`,
      );
      const { data, metadata } = await decompressData<BinaryFileMetadata>(
        new Uint8Array(await response.arrayBuffer()),
        { decryptionKey },
      );
      loadedFiles.push({
        id: fileId,
        mimeType: metadata.mimeType || MIME_TYPES.binary,
        dataURL: new TextDecoder().decode(data) as DataURL,
        created: metadata.created || Date.now(),
        lastRetrieved: Date.now(),
      });
    } catch {
      erroredFiles.set(fileId, true);
    }
  }
  return { loadedFiles, erroredFiles };
};
