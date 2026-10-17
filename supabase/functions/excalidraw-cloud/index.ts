/**
 * Deploy as `excalidraw-cloud` with verify_jwt=false. This is deliberately NOT
 * unauthenticated storage: every data operation is gated by a 256-bit capability.
 *
 * Browser capability = hex(SHA-256("excalidraw-cloud:v1:" + kind + ":" + id +
 * ":" + encryptionKey)), where kind is rooms or shareLinks. Send ONLY that
 * capability in x-excalidraw-token. The encryption key never reaches this API.
 * PostgreSQL receives only hex(SHA-256(capability)) and verifies it atomically.
 *
 * Secrets are read only from the Edge runtime, never accepted from requests.
 * No SDK/import dependencies. No drawing/file deletion endpoints or expiry.
 */

export const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * Math.ceil(MAX_BINARY_BYTES / 3) + 1024;
const BUCKET = "excalidraw-encrypted";
const ID_PATTERN = /^[a-f0-9]{20}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const ALLOWED_ORIGINS = new Set([
  "https://excalidraw-wheat-theta.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);

export type Kind = "rooms" | "shareLinks";
export type Route =
  | { type: "scene"; kind: Kind; id: string }
  | { type: "file"; kind: Kind; id: string; fileId: string };
export type SceneRecord = {
  revision: number;
  sceneVersion: number;
  iv: string | null;
  ciphertext: string;
};
type RpcResult = {
  status: number;
  record?: SceneRecord;
  writeAck?: { revision: number; sceneVersion: number };
  retryAfter?: number;
  byteSize?: number;
};
export type Backend = {
  rpc: (name: string, body: Record<string, unknown>) => Promise<RpcResult>;
  storage: (path: string, init?: RequestInit) => Promise<Response>;
  rateKey: (request: Request) => Promise<string>;
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function parseRoute(pathname: string): Route | null {
  // Accept both the gateway's full URL and function-local URLs. Encoded path
  // separators, dot segments, extra slashes and trailing path material fail.
  const path = pathname.replace(
    /^\/(?:functions\/v1\/)?excalidraw-cloud(?=\/)/,
    "",
  );
  const parts = path.split("/");
  if (
    parts.length === 3 && (parts[1] === "rooms" || parts[1] === "snapshots") &&
    ID_PATTERN.test(parts[2])
  ) {
    return {
      type: "scene",
      kind: parts[1] === "rooms" ? "rooms" : "shareLinks",
      id: parts[2],
    };
  }
  if (
    parts.length === 5 && parts[1] === "files" &&
    (parts[2] === "rooms" || parts[2] === "shareLinks") &&
    ID_PATTERN.test(parts[3]) && FILE_ID_PATTERN.test(parts[4])
  ) {
    return { type: "file", kind: parts[2], id: parts[3], fileId: parts[4] };
  }
  return null;
}

export async function sha256Hex(value: string): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  // Avoid spreading a multi-megabyte buffer onto the JavaScript call stack.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(text);
}

export function base64ToBytes(
  value: unknown,
  min: number,
  max: number,
): Uint8Array {
  if (
    typeof value !== "string" || value.length > 4 * Math.ceil(max / 3) ||
    (value.length % 4 !== 0 || !BASE64_PATTERN.test(value))
  ) {
    throw new HttpError(400, "Invalid encrypted payload");
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new HttpError(400, "Invalid encrypted payload");
  }
  // Canonical encoding prevents aliases, malformed padding and spare-bit data.
  if (decoded.length < min || decoded.length > max || btoa(decoded) !== value) {
    throw new HttpError(400, "Invalid encrypted payload");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return bytes;
}

export function validateRoomPayload(value: unknown, update: boolean): {
  sceneVersion: number;
  iv: string;
  ciphertext: string;
  expectedRevision?: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Invalid encrypted payload");
  }
  const input = value as Record<string, unknown>;
  const keys = update
    ? ["sceneVersion", "iv", "ciphertext", "expectedRevision"]
    : ["sceneVersion", "iv", "ciphertext"];
  if (
    Object.keys(input).length !== keys.length ||
    !keys.every((key) => Object.prototype.hasOwnProperty.call(input, key)) ||
    !Number.isSafeInteger(input.sceneVersion) ||
    (input.sceneVersion as number) < 0
  ) {
    throw new HttpError(400, "Invalid encrypted payload");
  }
  if (
    update &&
    (!Number.isSafeInteger(input.expectedRevision) ||
      (input.expectedRevision as number) < 1)
  ) {
    throw new HttpError(400, "Invalid revision");
  }
  base64ToBytes(input.iv, 12, 12);
  base64ToBytes(input.ciphertext, 16, MAX_BINARY_BYTES);
  return input as ReturnType<typeof validateRoomPayload>;
}

export async function readLimitedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > limit)
  ) {
    throw new HttpError(413, "Encrypted payload exceeds the 4 MiB limit");
  }
  if (!request.body) {
    throw new HttpError(400, "Missing encrypted payload");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new HttpError(408, "Upload timed out")),
      20_000,
    );
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        throw new HttpError(413, "Encrypted payload exceeds the 4 MiB limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    // Cancellation is best effort; never wait for an attacker-controlled stream.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  if (size === 0) throw new HttpError(400, "Missing encrypted payload");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function checkContentType(request: Request, expected: string): void {
  if (
    request.headers.get("content-type")?.split(";", 1)[0].trim()
      .toLowerCase() !== expected
  ) {
    throw new HttpError(415, `Content-Type must be ${expected}`);
  }
  if (
    request.headers.get("content-encoding") &&
    request.headers.get("content-encoding") !== "identity"
  ) {
    throw new HttpError(415, "Encoded request bodies are not supported");
  }
}

function errorText(status: number): string {
  switch (status) {
    case 403:
      return "Access denied";
    case 404:
      return "Encrypted file not found";
    case 409:
      return "Encrypted record already exists or was changed";
    case 429:
      return "Creation limit reached; try again later";
    case 507:
      return "Cloud storage limit reached. Existing drawings are preserved; export a local backup";
    default:
      return "Cloud storage temporarily unavailable";
  }
}

export function createHandler(
  backend: Backend,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const origin = request.headers.get("origin");
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "content-type, x-excalidraw-token, apikey",
      );
      headers.set("Access-Control-Expose-Headers", "Retry-After");
      headers.set("Access-Control-Max-Age", "600");
    }
    const json = (body: unknown, status = 200): Response => {
      const responseHeaders = new Headers(headers);
      responseHeaders.set("Content-Type", "application/json; charset=utf-8");
      return new Response(JSON.stringify(body), {
        status,
        headers: responseHeaders,
      });
    };
    const failure = (result: RpcResult): Response => {
      if (result.retryAfter) {
        headers.set("Retry-After", String(result.retryAfter));
      }
      return json({ error: errorText(result.status) }, result.status);
    };
    try {
      if (origin !== null && !ALLOWED_ORIGINS.has(origin)) {
        return json({ error: "Access denied" }, 403);
      }
      const url = new URL(request.url);
      const route = parseRoute(url.pathname);
      if (!route || url.search) return json({ error: "Not found" }, 404);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers });
      }
      const methodAllowed = request.method === "GET" ||
        request.method === "POST" ||
        (request.method === "PUT" && route.type === "scene" &&
          route.kind === "rooms");
      if (!methodAllowed) return json({ error: "Method not allowed" }, 405);
      const token = request.headers.get("x-excalidraw-token");
      if (!token || !TOKEN_PATTERN.test(token)) {
        return json({ error: "Access denied" }, 403);
      }
      const tokenHash = await sha256Hex(token);
      const scope = {
        p_kind: route.kind,
        p_id: route.id,
        p_token_hash: tokenHash,
      };

      if (route.type === "file") {
        const path = `${route.kind}/${route.id}/${route.fileId}`;
        if (request.method === "GET") {
          const authorization = await backend.rpc("excalidraw_authorize_file", {
            ...scope,
            p_file_id: route.fileId,
          });
          if (authorization.status !== 200) return failure(authorization);
          const upstream = await backend.storage(path);
          if (!upstream.ok) {
            await upstream.body?.cancel();
            return failure({ status: upstream.status === 404 ? 404 : 503 });
          }
          headers.set("Content-Type", "application/octet-stream");
          return new Response(upstream.body, { status: 200, headers });
        }
        checkContentType(request, "application/octet-stream");
        const body = await readLimitedBody(request, MAX_BINARY_BYTES);
        const reservation = await backend.rpc("excalidraw_reserve_file", {
          ...scope,
          p_file_id: route.fileId,
          p_byte_size: body.byteLength,
        });
        if (reservation.status !== 200 && reservation.status !== 201) {
          return failure(reservation);
        }
        const stored = await backend.storage(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-upsert": "false",
            "Cache-Control": "private, no-store",
          },
          body: body as BodyInit,
        });
        if (stored.ok) {
          await stored.body?.cancel();
          return json({ id: route.fileId }, 201);
        }
        await stored.body?.cancel();
        // Storage enforces first-write-wins atomically. If the first upload's
        // response was lost (or another client uploaded the same file), verify
        // the stored size before acknowledging this retry. Never overwrite it.
        const existing = await backend.storage(path);
        if (existing.ok) {
          const existingBody = await readLimitedBody(
            new Request(
              "https://internal.invalid",
              {
                method: "POST",
                body: existing.body,
                duplex: "half",
              } as RequestInit,
            ),
            MAX_BINARY_BYTES,
          );
          if (existingBody.length === body.length) {
            return json({ id: route.fileId }, 200);
          }
        } else {
          await existing.body?.cancel();
        }
        // Keep reservation: retries can recover safely; no compensating delete
        // can race and remove another client's already successful upload.
        return failure({ status: 503 });
      }

      if (request.method === "GET") {
        const result = await backend.rpc("excalidraw_get_scene", scope);
        if (result.status !== 200 || !result.record) return failure(result);
        if (route.kind === "shareLinks") {
          headers.set("Content-Type", "application/octet-stream");
          return new Response(
            base64ToBytes(
              result.record.ciphertext,
              1,
              MAX_BINARY_BYTES,
            ) as BodyInit,
            { headers },
          );
        }
        return json(result.record);
      }

      let payload: {
        sceneVersion: number;
        iv: string | null;
        ciphertext: string;
        expectedRevision?: number;
      };
      if (route.kind === "shareLinks") {
        checkContentType(request, "application/octet-stream");
        payload = {
          sceneVersion: 0,
          iv: null,
          ciphertext: bytesToBase64(
            await readLimitedBody(request, MAX_BINARY_BYTES),
          ),
        };
      } else {
        checkContentType(request, "application/json");
        const body = await readLimitedBody(request, MAX_JSON_BYTES);
        let input: unknown;
        try {
          input = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
        } catch {
          throw new HttpError(400, "Invalid JSON");
        }
        payload = validateRoomPayload(input, request.method === "PUT");
      }
      const values = {
        p_id: route.id,
        p_token_hash: tokenHash,
        p_scene_version: payload.sceneVersion,
        p_iv: payload.iv,
        p_ciphertext: payload.ciphertext,
      };
      const result = request.method === "POST"
        ? await backend.rpc("excalidraw_create_scene", {
          ...values,
          p_kind: route.kind,
          p_ip_hash: await backend.rateKey(request),
        })
        : await backend.rpc("excalidraw_update_room", {
          ...values,
          p_expected_revision: payload.expectedRevision,
        });
      if (result.status === 409 && route.kind === "rooms" && result.record) {
        return json(result.record, 409);
      }
      if (result.status !== 200 && result.status !== 201) {
        return failure(result);
      }
      if (route.kind === "shareLinks") {
        return json({ id: route.id }, result.status);
      }
      // Successful writes need not echo megabytes through PostgREST while its
      // transaction still owns the global budget lock. Rebuild the unchanged
      // browser response only after the small committed acknowledgement arrives.
      // Full records remain accepted for a safe rolling backend migration.
      const stored = result.writeAck
        ? {
          revision: result.writeAck.revision,
          sceneVersion: result.writeAck.sceneVersion,
          iv: payload.iv,
          ciphertext: payload.ciphertext,
        }
        : result.record;
      if (
        !stored || !Number.isSafeInteger(stored.revision) ||
        stored.revision < 1 ||
        stored.sceneVersion !== payload.sceneVersion
      ) throw new Error("Invalid write acknowledgement");
      return json(stored, result.status);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status);
      }
      // Never log/return request headers, capabilities, ciphertext, upstream
      // bodies or environment values. An opaque fixed response is intentional.
      console.error("Excalidraw encrypted storage operation failed");
      return failure({ status: 503 });
    }
  };
}

/** Runtime-only service access; these values must never be bundled in the app. */
export function createBackend(
  supabaseUrl: string,
  serviceRoleKey: string,
): Backend {
  const base = new URL(supabaseUrl);
  if (
    !serviceRoleKey ||
    (base.protocol !== "https:" && base.hostname !== "127.0.0.1" &&
      base.hostname !== "localhost")
  ) {
    throw new Error("Missing or invalid Edge runtime configuration");
  }
  const hmacKey = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(serviceRoleKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const authenticatedFetch = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("apikey", serviceRoleKey);
    headers.set("Authorization", `Bearer ${serviceRoleKey}`);
    return fetch(`${base.origin}${path}`, {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  };
  return {
    async rpc(name, body) {
      const response = await authenticatedFetch(`/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Database unavailable");
      }
      const result = await response.json() as RpcResult;
      if (
        !result || ![200, 201, 403, 404, 409, 429, 507].includes(result.status)
      ) throw new Error("Invalid database response");
      return result;
    },
    storage(path, init) {
      return authenticatedFetch(`/storage/v1/object/${BUCKET}/${path}`, init);
    },
    async rateKey(request) {
      // Forwarding headers are best-effort abuse signals, not authorization.
      // Global durable daily and byte caps still hold even if a proxy permits
      // forged forwarding headers. Never persist/log the raw address.
      const candidate = request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for")?.split(",", 1)[0].trim() ||
        "unknown";
      const ip = /^[a-fA-F0-9:.]{3,64}$/.test(candidate)
        ? candidate
        : "unknown";
      const day = new Date().toISOString().slice(0, 10);
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          await hmacKey,
          new TextEncoder().encode(`excalidraw-rate:v1:${day}:${ip}`),
        ),
      );
      return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
  };
}

// The import guard permits focused Node/Deno tests without starting a server.
declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): unknown;
};
if (typeof Deno !== "undefined" && import.meta.main) {
  Deno.serve(
    createHandler(
      createBackend(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      ),
    ),
  );
}
