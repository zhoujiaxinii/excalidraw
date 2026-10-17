import {
  base64ToBytes,
  bytesToBase64,
  createHandler,
  HttpError,
  MAX_BINARY_BYTES,
  parseRoute,
  readLimitedBody,
  sha256Hex,
  validateRoomPayload,
} from "./index.ts";
import type { Backend, SceneRecord } from "./index.ts";

const id = "0123456789abcdef0123";
const token = "a".repeat(64);
const origin = "https://excalidraw-wheat-theta.vercel.app";
const payload = {
  sceneVersion: 4,
  iv: bytesToBase64(new Uint8Array(12)),
  ciphertext: bytesToBase64(new Uint8Array(16)),
};
const record: SceneRecord = { revision: 1, ...payload };
function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `Expected ${JSON.stringify(expected)}; got ${JSON.stringify(actual)}`,
  );
}
function rejects(callback: () => unknown): void {
  let threw = false;
  try {
    callback();
  } catch (error) {
    assert(error instanceof HttpError);
    threw = true;
  }
  assert(threw, "Expected validation failure");
}
function request(
  path = `/rooms/${id}`,
  method = "GET",
  body?: BodyInit,
  contentType = "application/json",
): Request {
  return new Request(
    `https://example.supabase.co/functions/v1/excalidraw-cloud${path}`,
    {
      method,
      body,
      headers: {
        origin,
        "x-excalidraw-token": token,
        "content-type": contentType,
        apikey: "test-public-key",
      },
    },
  );
}
function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    rpc: () => Promise.resolve({ status: 200, record }),
    storage: () => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))),
    rateKey: () => Promise.resolve("b".repeat(64)),
    ...overrides,
  };
}

Deno.test("routes require exact scope, 20-hex id and safe file id", () => {
  equal(parseRoute(`/rooms/${id}`), { type: "scene", kind: "rooms", id });
  equal(parseRoute(`/excalidraw-cloud/snapshots/${id}`), {
    type: "scene",
    kind: "shareLinks",
    id,
  });
  equal(
    parseRoute(
      `/functions/v1/excalidraw-cloud/files/shareLinks/${id}/file_ABC-123`,
    ),
    { type: "file", kind: "shareLinks", id, fileId: "file_ABC-123" },
  );
  for (
    const path of [
      `/rooms/${id}/extra`,
      `/rooms/${id}/`,
      `/rooms/${id.toUpperCase()}`,
      `/rooms/${id}0`,
      `/files/rooms/${id}/..`,
      `/files/rooms/${id}/a%2fb`,
      `/files/invalid/${id}/a`,
      `/files/rooms/${id}/${"a".repeat(129)}`,
    ]
  ) equal(parseRoute(path), null);
});

Deno.test("base64 handles the full 4 MiB boundary without regexp recursion", () => {
  const bytes = new Uint8Array(MAX_BINARY_BYTES).fill(255);
  const encoded = bytesToBase64(bytes);
  const decoded = base64ToBytes(encoded, 1, MAX_BINARY_BYTES);
  equal(decoded.length, MAX_BINARY_BYTES);
  equal(decoded.at(-1), 255);
  rejects(() =>
    base64ToBytes(
      bytesToBase64(new Uint8Array(MAX_BINARY_BYTES + 1)),
      1,
      MAX_BINARY_BYTES,
    )
  );
});

Deno.test("base64 rejects whitespace, spare bits, missing and malformed padding", () => {
  for (
    const value of [
      "a",
      "abc",
      "ab==",
      "AAA===",
      "AA==AA==",
      "AA==\n",
      "_AAA",
      "",
      null,
      4,
    ]
  ) rejects(() => base64ToBytes(value, 1, 16));
  equal(Array.from(base64ToBytes("AA==", 1, 16)), [0]);
});

Deno.test("room input requires exact fields, IV and safe integer versions", () => {
  equal(validateRoomPayload(payload, false), payload);
  equal(
    validateRoomPayload({ ...payload, expectedRevision: 1 }, true)
      .expectedRevision,
    1,
  );
  for (
    const value of [
      null,
      [],
      { ...payload, encryptionKey: "never-send" },
      { ...payload, expectedRevision: null },
      { ...payload, iv: "AA==" },
      { ...payload, sceneVersion: -1 },
      { ...payload, sceneVersion: 1.1 },
      { ...payload, sceneVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...payload, ciphertext: "AA==" },
    ]
  ) rejects(() => validateRoomPayload(value, false));
  for (
    const expectedRevision of [0, -1, null, 1.2, Number.MAX_SAFE_INTEGER + 1]
  ) rejects(() => validateRoomPayload({ ...payload, expectedRevision }, true));
});

Deno.test("streaming limit applies without a Content-Length header", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4));
      controller.enqueue(new Uint8Array(5));
      controller.close();
    },
  });
  const req = new Request("https://example.test", {
    method: "POST",
    body: stream,
  });
  try {
    await readLimitedBody(req, 8);
    throw new Error("Expected failure");
  } catch (error) {
    assert(error instanceof HttpError && error.status === 413);
  }
  equal(
    Array.from(
      await readLimitedBody(
        new Request("https://example.test", {
          method: "POST",
          body: new Uint8Array([1, 2]),
        }),
        2,
      ),
    ),
    [1, 2],
  );
});

Deno.test("declared oversized body rejected before reading", async () => {
  const req = new Request("https://example.test", {
    method: "POST",
    body: "x",
    headers: { "content-length": "100" },
  });
  try {
    await readLimitedBody(req, 10);
    throw new Error("Expected failure");
  } catch (error) {
    assert(error instanceof HttpError && error.status === 413);
  }
});

Deno.test("CORS permits exact production/local origins and apikey preflight", async () => {
  const handle = createHandler(backend({
    rpc: () => {
      throw new Error("Must not call database");
    },
  }));
  for (
    const allowed of [origin, "http://localhost:5173", "http://127.0.0.1:5173"]
  ) {
    const req = request(`/rooms/${id}`, "OPTIONS");
    req.headers.set("origin", allowed);
    req.headers.set(
      "access-control-request-headers",
      "apikey,x-excalidraw-token,content-type",
    );
    const response = await handle(req);
    equal(response.status, 204);
    equal(response.headers.get("access-control-allow-origin"), allowed);
    assert(
      response.headers.get("access-control-allow-headers")?.includes("apikey"),
    );
  }
  for (
    const denied of [
      "https://attacker.example",
      "null",
      "https://excalidraw-wheat-theta.vercel.app.attacker.test",
    ]
  ) {
    const req = request();
    req.headers.set("origin", denied);
    const response = await handle(req);
    equal(response.status, 403);
    equal(response.headers.get("access-control-allow-origin"), null);
  }
});

Deno.test("bad tokens fail before database access", async () => {
  const handle = createHandler(backend({
    rpc: () => {
      throw new Error("Must not call database");
    },
  }));
  for (const invalid of ["", "abc", "A".repeat(64), "a".repeat(65)]) {
    const req = request();
    req.headers.set("x-excalidraw-token", invalid);
    equal((await handle(req)).status, 403);
  }
});

Deno.test("room create forwards only hashed capability and encrypted payload", async () => {
  const handle = createHandler(backend({
    rpc: async (name, body) => {
      equal(name, "excalidraw_create_scene");
      equal(body, {
        p_id: id,
        p_token_hash: await sha256Hex(token),
        p_scene_version: 4,
        p_iv: payload.iv,
        p_ciphertext: payload.ciphertext,
        p_kind: "rooms",
        p_ip_hash: "b".repeat(64),
      });
      assert(!JSON.stringify(body).includes(token));
      return { status: 201, record };
    },
  }));
  const response = await handle(
    request(`/rooms/${id}`, "POST", JSON.stringify(payload)),
  );
  equal(response.status, 201);
  equal(await response.json(), record);
});

Deno.test("room conflict returns current record without dropping revisions", async () => {
  const handle = createHandler(backend({
    rpc: (name, body) => {
      equal(name, "excalidraw_update_room");
      equal(body.p_expected_revision, 1);
      return Promise.resolve({
        status: 409,
        record: { ...record, revision: 2 },
      });
    },
  }));
  const response = await handle(
    request(
      `/rooms/${id}`,
      "PUT",
      JSON.stringify({ ...payload, expectedRevision: 1 }),
    ),
  );
  equal(response.status, 409);
  equal((await response.json()).revision, 2);
});

Deno.test("snapshot POST/GET preserve opaque binary and never enable PUT", async () => {
  const bytes = new Uint8Array([1, 2, 3, 255]);
  let stored = "";
  const handle = createHandler(backend({
    rpc: (name, body) => {
      equal(body.p_kind, "shareLinks");
      if (name === "excalidraw_create_scene") {
        equal(body.p_iv, null);
        equal(body.p_scene_version, 0);
        stored = body.p_ciphertext as string;
        return Promise.resolve({ status: 201 });
      }
      return Promise.resolve({
        status: 200,
        record: { revision: 1, sceneVersion: 0, iv: null, ciphertext: stored },
      });
    },
  }));
  equal(
    (await handle(
      request(`/snapshots/${id}`, "POST", bytes, "application/octet-stream"),
    )).status,
    201,
  );
  const response = await handle(request(`/snapshots/${id}`));
  equal(response.headers.get("content-type"), "application/octet-stream");
  equal(
    Array.from(new Uint8Array(await response.arrayBuffer())),
    Array.from(bytes),
  );
  equal(
    (await handle(
      request(`/snapshots/${id}`, "PUT", bytes, "application/octet-stream"),
    )).status,
    405,
  );
});

Deno.test("missing scope and incorrect capability share 403 behavior", async () => {
  const handle = createHandler(
    backend({ rpc: () => Promise.resolve({ status: 403 }) }),
  );
  const response = await handle(request());
  equal(response.status, 403);
  equal(await response.json(), { error: "Access denied" });
});

Deno.test("file GET authorizes capability before calling storage", async () => {
  const handle = createHandler(
    backend({
      rpc: () => Promise.resolve({ status: 403 }),
      storage: () => {
        throw new Error("Must not call storage");
      },
    }),
  );
  equal((await handle(request(`/files/rooms/${id}/file`))).status, 403);
});

Deno.test("file POST is immutable, retries acknowledge existing matching size", async () => {
  let stored: Uint8Array | null = null;
  const handle = createHandler(backend({
    rpc: () => Promise.resolve({ status: stored ? 200 : 201 }),
    storage: async (_path, init) => {
      if (init?.method === "POST") {
        equal(new Headers(init.headers).get("x-upsert"), "false");
        if (stored) return new Response(null, { status: 409 });
        stored = new Uint8Array(await new Response(init.body).arrayBuffer());
        return new Response("ok", { status: 200 });
      }
      return new Response(stored as BodyInit | null);
    },
  }));
  equal(
    (await handle(
      request(
        `/files/rooms/${id}/file`,
        "POST",
        new Uint8Array([1, 2]),
        "application/octet-stream",
      ),
    )).status,
    201,
  );
  equal(
    (await handle(
      request(
        `/files/rooms/${id}/file`,
        "POST",
        new Uint8Array([3, 4]),
        "application/octet-stream",
      ),
    )).status,
    200,
  );
  equal(Array.from(stored!), [1, 2]);
});

Deno.test("quota/throttle errors are explicit and never indicate successful save", async () => {
  for (const status of [429, 507]) {
    const handle = createHandler(
      backend({
        rpc: () =>
          Promise.resolve({
            status,
            retryAfter: status === 429 ? 3600 : undefined,
          }),
      }),
    );
    const response = await handle(
      request(`/rooms/${id}`, "POST", JSON.stringify(payload)),
    );
    equal(response.status, status);
    assert((await response.json()).error);
    if (status === 429) equal(response.headers.get("retry-after"), "3600");
  }
});

Deno.test("unknown fields, query strings, encodings and MIME types fail closed", async () => {
  const handle = createHandler(backend({
    rpc: () => {
      throw new Error("Must not call database");
    },
  }));
  equal((await handle(request(`/rooms/${id}?key=bad`))).status, 404);
  equal(
    (await handle(
      request(`/rooms/${id}`, "POST", JSON.stringify(payload), "text/plain"),
    )).status,
    415,
  );
  const encoded = request(`/rooms/${id}`, "POST", JSON.stringify(payload));
  encoded.headers.set("content-encoding", "gzip");
  equal((await handle(encoded)).status, 415);
  equal(
    (await handle(request(`/rooms/${id}`, "POST", "{not json}"))).status,
    400,
  );
  equal(
    (await handle(
      request(
        `/rooms/${id}`,
        "POST",
        JSON.stringify({ ...payload, encryptionKey: "never-send" }),
      ),
    )).status,
    400,
  );
});
