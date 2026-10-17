import { createClient } from "@supabase/supabase-js";

import type { SupabaseClient } from "@supabase/supabase-js";

const cloudUrl = import.meta.env.VITE_APP_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_APP_SUPABASE_PUBLISHABLE_KEY;

export const isCloudEnabled = !!(cloudUrl && publishableKey);

let client: SupabaseClient | null = null;

export const getSupabaseClient = () => {
  if (!isCloudEnabled) {
    throw new Error("Cloud collaboration is not configured.");
  }
  if (!client) {
    client = createClient(cloudUrl, publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return client;
};

export type CloudScene = {
  revision: number;
  sceneVersion: number;
  iv: string;
  ciphertext: string;
};

export class CloudRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "CloudRequestError";
  }
}

export const getRoomAccessToken = async (
  kind: "rooms" | "shareLinks",
  id: string,
  encryptionKey: string,
) => {
  const bytes = new TextEncoder().encode(
    `excalidraw-cloud:v1:${kind}:${id}:${encryptionKey}`,
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
};

export const getRealtimeTopic = async (id: string, encryptionKey: string) => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `excalidraw-realtime:v1:rooms:${id}:${encryptionKey}`,
    ),
  );
  return `room:${Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("")}`;
};

export const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
};

export const base64ToBytes = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

export const cloudRequest = async (
  kind: "rooms" | "shareLinks",
  id: string,
  encryptionKey: string,
  path: string,
  init: RequestInit = {},
) => {
  if (!isCloudEnabled) {
    throw new Error("Cloud storage is not configured.");
  }
  const token = await getRoomAccessToken(kind, id, encryptionKey);
  const headers = new Headers(init.headers);
  headers.set("apikey", publishableKey);
  headers.set("x-excalidraw-token", token);
  const response = await fetch(
    `${cloudUrl}/functions/v1/excalidraw-cloud${path}`,
    {
      ...init,
      headers,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    },
  );
  if (!response.ok) {
    throw new CloudRequestError(
      response.status,
      response.status === 429
        ? "Cloud storage is busy or its free quota was reached. Your drawing has not been saved yet."
        : response.status === 403
        ? "This cloud drawing could not be opened. Check the complete sharing link."
        : `Cloud storage request failed (${response.status}).`,
    );
  }
  return response;
};

export const readCloudScene = async (id: string, key: string) => {
  try {
    const response = await cloudRequest("rooms", id, key, `/rooms/${id}`);
    return (await response.json()) as CloudScene;
  } catch (error) {
    if (error instanceof CloudRequestError && error.status === 404) {
      return null;
    }
    throw error;
  }
};

export const writeCloudScene = async (
  id: string,
  key: string,
  scene: Omit<CloudScene, "revision">,
  expectedRevision: number | null,
) => {
  const response = await cloudRequest("rooms", id, key, `/rooms/${id}`, {
    method: expectedRevision === null ? "POST" : "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      expectedRevision === null ? scene : { ...scene, expectedRevision },
    ),
  });
  return (await response.json()) as CloudScene;
};

export const createCloudSnapshot = async (
  id: string,
  key: string,
  encryptedPayload: Uint8Array<ArrayBuffer>,
) => {
  await cloudRequest("shareLinks", id, key, `/snapshots/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: encryptedPayload,
  });
};

export const loadCloudSnapshot = async (id: string, key: string) => {
  const response = await cloudRequest(
    "shareLinks",
    id,
    key,
    `/snapshots/${id}`,
  );
  return response.arrayBuffer();
};

export const parseCloudFilePrefix = (prefix: string) => {
  const match = /^\/?files\/(rooms|shareLinks)\/([a-f0-9]{20})$/.exec(prefix);
  if (!match) {
    throw new Error("Invalid cloud file location.");
  }
  return { kind: match[1] as "rooms" | "shareLinks", id: match[2] };
};
