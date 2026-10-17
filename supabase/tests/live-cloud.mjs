/**
 * Opt-in live smoke test for the dedicated Excalidraw Supabase project.
 * Uses only synthetic content, two tiny scenes, and one tiny encrypted file.
 * Never deletes data, creates paid resources, or accepts service-role credentials.
 *
 * Local validation: node supabase/tests/live-cloud.mjs --self-test
 * After deployment is explicitly ready: node supabase/tests/live-cloud.mjs --run-live
 * Optional EXCALIDRAW_SUPABASE_PUBLISHABLE_KEY overrides the public client key.
 */
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";

const PROJECT = "https://tpxtjxebqboatqcakwma.supabase.co";
const PUBLIC_KEY = process.env.EXCALIDRAW_SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_B46QPGATYQ5aIO9-Q69KcQ_GNxUjQ1Q";
const ORIGIN = "https://excalidraw-wheat-theta.vercel.app";
const EDGE = "/functions/v1/excalidraw-cloud";
const MAX_REQUESTS = 40;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const crypto = webcrypto;
let checks = 0;
let requests = 0;
let started;

function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks++;
}

function okay(condition, label) {
  assert.ok(condition, label);
  checks++;
}

const base64 = (bytes) => Buffer.from(bytes).toString("base64");
const unbase64 = (text) => new Uint8Array(Buffer.from(text, "base64"));
const newId = () => randomBytes(10).toString("hex");
const wrongToken = () => randomBytes(32).toString("hex");

async function capability(kind, id, encryptionKey) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`excalidraw-cloud:v1:${kind}:${id}:${encryptionKey}`),
  );
  return Buffer.from(digest).toString("hex");
}

async function newScope(kind) {
  const id = newId();
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 128 }, true, ["encrypt", "decrypt"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { id, key, token: await capability(kind, id, jwk.k) };
}

async function encrypt(key, bytes) {
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, bytes,
  ));
  return { iv, ciphertext };
}

async function decrypt(key, iv, ciphertext) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, key, ciphertext,
  ));
}

async function roomPayload(scope, elements, sceneVersion) {
  const encrypted = await encrypt(scope.key, encoder.encode(JSON.stringify(elements)));
  return {
    sceneVersion,
    iv: base64(encrypted.iv),
    ciphertext: base64(encrypted.ciphertext),
  };
}

async function decryptRoom(scope, record) {
  return JSON.parse(decoder.decode(await decrypt(
    scope.key, unbase64(record.iv), unbase64(record.ciphertext),
  )));
}

// Opaque AES-GCM envelope for backend round-trip tests only. This is not the
// browser's Excalidraw snapshot/image serialization compatibility test.
async function opaqueBlob(scope, plaintext) {
  const { iv, ciphertext } = await encrypt(scope.key, plaintext);
  return new Uint8Array(Buffer.concat([iv, ciphertext]));
}

async function decryptBlob(scope, blob) {
  return decrypt(scope.key, blob.slice(0, 12), blob.slice(12));
}

async function call(path, {
  method = "GET", token, body, type = "application/json", origin = ORIGIN,
  headers = {}, edge = true,
} = {}) {
  assert.ok(++requests <= MAX_REQUESTS, "Live request budget exceeded");
  assert.ok(Date.now() - started < 120_000, "Live test exceeded two minutes");
  const requestHeaders = new Headers({ apikey: PUBLIC_KEY, ...headers });
  if (origin !== null) requestHeaders.set("origin", origin);
  if (token !== undefined) requestHeaders.set("x-excalidraw-token", token);
  if (body !== undefined) requestHeaders.set("content-type", type);
  const response = await fetch(`${PROJECT}${edge ? EDGE : ""}${path}`, {
    method, headers: requestHeaders, body, redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: response.status,
    headers: response.headers,
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

const json = (response) => JSON.parse(decoder.decode(response.bytes));
const postJson = (path, token, body, method = "POST") => call(path, {
  method, token, body: JSON.stringify(body),
});
const postBlob = (path, token, body, method = "POST") => call(path, {
  method, token, body, type: "application/octet-stream",
});

async function selfTest() {
  const room = await newScope("rooms");
  const value = [{ id: "synthetic-self-test", version: 1 }];
  equal(room.id.length, 20, "Room ID length");
  equal(room.token.length, 64, "Capability length");
  equal(await decryptRoom(room, await roomPayload(room, value, 1)), value,
    "Local room crypto round-trip");
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 255]);
  equal(await decryptBlob(room, await opaqueBlob(room, bytes)), bytes,
    "Local opaque binary crypto round-trip");
  console.log(`${checks} local crypto checks passed; no network requests made.`);
}

async function runLive() {
  okay(PUBLIC_KEY.startsWith("sb_publishable_"),
    "Only a public publishable key is accepted");
  started = Date.now();
  const room = await newScope("rooms");
  const snapshot = await newScope("shareLinks");
  const roomPath = `/rooms/${room.id}`;
  const snapshotPath = `/snapshots/${snapshot.id}`;
  const fileId = `synthetic_${randomBytes(8).toString("hex")}`;
  const filePath = `/files/shareLinks/${snapshot.id}/${fileId}`;
  console.log(`Target: ${PROJECT}; at most ${MAX_REQUESTS} requests; synthetic data only.`);
  console.log(`Synthetic room ID: ${room.id}; snapshot ID: ${snapshot.id}; file ID: ${fileId}`);

  const preflight = await call(roomPath, {
    method: "OPTIONS",
    headers: {
      "access-control-request-method": "POST",
      "access-control-request-headers": "apikey,x-excalidraw-token,content-type",
    },
  });
  equal(preflight.status, 204, "Gateway preflight");
  equal(preflight.headers.get("access-control-allow-origin"), ORIGIN, "Allowed origin");
  for (const header of ["apikey", "x-excalidraw-token", "content-type"]) {
    okay(preflight.headers.get("access-control-allow-headers")?.toLowerCase().includes(header),
      `Preflight allows ${header}`);
  }
  const deniedOrigin = await call(roomPath, { token: room.token, origin: "https://attacker.example" });
  equal(deniedOrigin.status, 403, "Foreign origin rejected");
  equal(deniedOrigin.headers.get("access-control-allow-origin"), null,
    "Foreign origin is not reflected");
  equal((await call("/not-a-route")).status, 404, "Exact gateway routing");
  console.log("PASS gateway routing and CORS");

  const initialElements = [{ id: "synthetic-rectangle", type: "rectangle", version: 1, x: 1, y: 2 }];
  const initialPayload = await roomPayload(room, initialElements, 1);
  const claims = await Promise.all([
    postJson(roomPath, room.token, initialPayload),
    postJson(roomPath, room.token, initialPayload),
  ]);
  equal(claims.map((result) => result.status).sort(), [201, 409],
    "Concurrent same-capability room claims have one winner");
  for (const claim of claims) {
    equal(json(claim).revision, 1, "Both room claims return first revision");
    equal(await decryptRoom(room, json(claim)), initialElements, "Claim returns decryptable content");
  }
  const roomRead = await call(roomPath, { token: room.token });
  equal(roomRead.status, 200, "Room read");
  equal(await decryptRoom(room, json(roomRead)), initialElements, "Room decrypt round-trip");
  equal(roomRead.headers.get("cache-control"), "private, no-store", "Room cache protection");
  equal((await call(roomPath)).status, 403, "Missing room capability rejected");
  equal((await call(roomPath, { token: wrongToken() })).status, 403,
    "Wrong room capability rejected");
  equal((await postJson(roomPath, wrongToken(), initialPayload)).status, 403,
    "Different capability cannot reclaim the room");
  console.log("PASS encrypted room creation/read, first claims, and capability rejection");

  const alternatives = [
    [{ id: "synthetic-rectangle", version: 2, x: 10 }],
    [{ id: "synthetic-rectangle", version: 3, x: 20 }],
  ];
  const updates = await Promise.all(alternatives.map(async (elements, index) => postJson(
    roomPath, room.token,
    { ...await roomPayload(room, elements, index + 2), expectedRevision: 1 }, "PUT",
  )));
  equal(updates.map((result) => result.status).sort(), [200, 409],
    "Concurrent CAS accepts exactly one update");
  const winner = updates.findIndex((result) => result.status === 200);
  for (const result of updates) {
    equal(json(result).revision, 2, "CAS success/conflict return authoritative revision");
    equal(await decryptRoom(room, json(result)), alternatives[winner],
      "CAS conflict preserves winning ciphertext");
  }
  const afterCAS = await call(roomPath, { token: room.token });
  equal(afterCAS.status, 200, "Read after CAS");
  equal(await decryptRoom(room, json(afterCAS)), alternatives[winner], "CAS winner persisted");
  console.log("PASS concurrent compare-and-swap and preserved winning edits");

  const snapshotPlaintext = encoder.encode(JSON.stringify({
    type: "synthetic-encrypted-snapshot", elements: initialElements,
  }));
  const snapshotBlob = await opaqueBlob(snapshot, snapshotPlaintext);
  equal((await postBlob(snapshotPath, snapshot.token, snapshotBlob)).status, 201,
    "Encrypted snapshot creation");
  const snapshotRead = await call(snapshotPath, { token: snapshot.token });
  equal(snapshotRead.status, 200, "Snapshot read");
  equal(snapshotRead.headers.get("content-type"), "application/octet-stream", "Snapshot MIME");
  equal(await decryptBlob(snapshot, snapshotRead.bytes), snapshotPlaintext, "Snapshot decrypt round-trip");
  const changedSnapshot = await opaqueBlob(snapshot, encoder.encode("synthetic replacement"));
  equal((await postBlob(snapshotPath, snapshot.token, changedSnapshot)).status, 409,
    "Snapshot cannot be replaced by repeated creation");
  equal((await postBlob(snapshotPath, snapshot.token, changedSnapshot, "PUT")).status, 405,
    "Snapshot update method rejected");
  equal((await call(snapshotPath, { token: wrongToken() })).status, 403,
    "Wrong snapshot capability rejected");
  const unchangedSnapshot = await call(snapshotPath, { token: snapshot.token });
  equal(unchangedSnapshot.status, 200, "Snapshot reread");
  equal(unchangedSnapshot.bytes, snapshotBlob, "Snapshot remains immutable");
  console.log("PASS encrypted snapshot round-trip and immutability");

  // A small valid 1x1 PNG, encrypted locally before upload.
  const imagePlaintext = unbase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l8sAAAAASUVORK5CYII=");
  const imageBlob = await opaqueBlob(snapshot, imagePlaintext);
  equal((await postBlob(filePath, snapshot.token, imageBlob)).status, 201, "Encrypted image upload");
  const imageRead = await call(filePath, { token: snapshot.token });
  equal(imageRead.status, 200, "Encrypted image download");
  equal(imageRead.headers.get("content-type"), "application/octet-stream", "Image MIME");
  equal(await decryptBlob(snapshot, imageRead.bytes), imagePlaintext, "Image decrypt round-trip");
  equal((await call(filePath, { token: wrongToken() })).status, 403,
    "Wrong image capability rejected");
  equal((await call(filePath)).status, 403, "Missing image capability rejected");
  equal((await postBlob(filePath, snapshot.token, imageBlob)).status, 200, "Image retry is idempotent");
  const differentSameSize = imageBlob.slice();
  differentSameSize[differentSameSize.length - 1] ^= 1;
  equal((await postBlob(filePath, snapshot.token, differentSameSize)).status, 200,
    "Same-size retry acknowledges immutable existing image");
  equal((await postBlob(filePath, snapshot.token, imageBlob.slice(0, -1))).status, 409,
    "Different-size image retry rejected");
  const unchangedImage = await call(filePath, { token: snapshot.token });
  equal(unchangedImage.status, 200, "Immutable image reread");
  equal(unchangedImage.bytes, imageBlob, "Image bytes cannot be overwritten");
  console.log("PASS encrypted image upload/download, decryption, and immutable retries");

  // Even possession of a capability hash must not enable direct anonymous RPC.
  const tokenHash = Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(room.token))).toString("hex");
  const anonymousRpc = await call("/rest/v1/rpc/excalidraw_get_scene", {
    edge: false, origin: null, method: "POST",
    body: JSON.stringify({ p_kind: "rooms", p_id: room.id, p_token_hash: tokenHash }),
  });
  okay([401, 403, 404].includes(anonymousRpc.status),
    `Direct anonymous RPC must be denied; received ${anonymousRpc.status}`);
  const storageObject = `/storage/v1/object/excalidraw-encrypted/shareLinks/${snapshot.id}/${fileId}`;
  const anonymousObject = await call(storageObject, { edge: false, origin: null });
  okay([400, 401, 403, 404].includes(anonymousObject.status),
    `Direct anonymous object read must be denied; received ${anonymousObject.status}`);
  const publicObject = await call(storageObject.replace("/object/", "/object/public/"), {
    edge: false, origin: null,
  });
  okay([400, 401, 403, 404].includes(publicObject.status),
    `Public object read must be denied; received ${publicObject.status}`);
  console.log(`PASS direct anonymous RPC (${anonymousRpc.status}), object (${anonymousObject.status}), and public storage (${publicObject.status}) denial`);
  console.log(`PASS ${checks} assertions across ${requests} live requests (${Date.now() - started} ms).`);
  console.log("Created two synthetic scenes and one tiny encrypted image. No records deleted; no paid resources created.");
}

const mode = process.argv[2];
if (mode === "--self-test") {
  await selfTest();
} else if (mode === "--run-live") {
  await runLive();
} else {
  console.log("No network requests made. Use --self-test locally, or --run-live only after explicit deployment readiness confirmation.");
  if (mode !== undefined) process.exitCode = 2;
}
