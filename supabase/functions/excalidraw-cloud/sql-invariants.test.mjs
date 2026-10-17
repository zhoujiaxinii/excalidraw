/** Local PostgreSQL-WASM regression suite; never connects to a live project.
 * npm install --prefix /tmp/excalidraw-sql-tests @electric-sql/pglite@0.5.10
 * PGLITE_MODULE=/tmp/excalidraw-sql-tests/node_modules/@electric-sql/pglite/dist/index.js node supabase/functions/excalidraw-cloud/sql-invariants.test.mjs
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
let checks = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema storage;
  create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
`);
const migrations = new URL("../../migrations/", import.meta.url);
for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()) {
  await db.exec(await readFile(new URL(name, migrations), "utf8"));
}
const hash = "a".repeat(64);
const wrong = "b".repeat(64);
const ip = "c".repeat(64);
const id = "0123456789abcdef0123";
const iv = Buffer.alloc(12).toString("base64");
const ciphertext = Buffer.alloc(16, 3).toString("base64");
const invoke = async (name, args) => (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`, args)).rows[0].result;
const create = (roomId, verifier = hash, kind = "rooms", rateIp = ip) => invoke("excalidraw_create_scene", [kind, roomId, verifier, kind === "rooms" ? 1 : 0, kind === "rooms" ? iv : null, ciphertext, rateIp]);
const update = (revision, version = 1, verifier = hash) => invoke("excalidraw_update_room", [id, verifier, revision, version, iv, ciphertext]);

try {
  equal((await invoke("excalidraw_get_scene", ["rooms", id, hash])).status, 403);
  const created = await create(id);
  equal(created.status, 201);
  equal(created.writeAck, { revision: 1, sceneVersion: 1 });
  equal(created.record, undefined);
  equal((await create(id, wrong)).status, 403);
  const original = await create(id);
  equal(original.status, 409);
  equal(original.record.revision, 1);
  equal((await invoke("excalidraw_get_scene", ["rooms", id, wrong])).status, 403);
  equal((await update(1, 99, wrong)).status, 403);
  equal((await update(1, 0)).writeAck.revision, 2); // Lower sceneVersion still valid CAS.
  const stale = await update(1);
  equal(stale.status, 409);
  equal(stale.record.revision, 2);
  equal(stale.record.sceneVersion, 0);
  const attempts = await Promise.all([update(2, 5), update(2, 6)]);
  equal(attempts.map((result) => result.status).sort(), [200, 409]);
  equal((await invoke("excalidraw_get_scene", ["rooms", id, hash])).record.revision, 3);

  const snapshotId = "11111111111111111111";
  equal((await create(snapshotId, hash, "shareLinks")).status, 201);
  equal((await create(snapshotId, wrong, "shareLinks")).status, 403);
  equal((await create(snapshotId, hash, "shareLinks")).status, 409);
  equal((await invoke("excalidraw_update_room", [snapshotId, hash, 1, 1, iv, ciphertext])).status, 403);
  equal((await invoke("excalidraw_get_scene", ["shareLinks", snapshotId, hash])).record.ciphertext, ciphertext);

  equal((await invoke("excalidraw_reserve_file", ["rooms", id, wrong, "file", 20])).status, 403);
  equal((await invoke("excalidraw_authorize_file", ["rooms", id, wrong, "file"])).status, 403);
  equal((await invoke("excalidraw_authorize_file", ["rooms", id, hash, "file"])).status, 404);
  equal((await invoke("excalidraw_reserve_file", ["rooms", id, hash, "file", 20])).status, 201);
  equal((await invoke("excalidraw_reserve_file", ["rooms", id, hash, "file", 20])).status, 200);
  equal((await invoke("excalidraw_reserve_file", ["rooms", id, hash, "file", 21])).status, 409);
  equal((await invoke("excalidraw_authorize_file", ["rooms", id, hash, "file"])).byteSize, 20);
  equal((await db.query("select file_bytes::integer as n from excalidraw_private.budget")).rows[0].n, 20);

  for (const role of ["anon", "authenticated"]) {
    const grants = await db.query(`select p.proname, has_function_privilege($1, p.oid, 'EXECUTE') as allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'excalidraw_%'`, [role]);
    equal(grants.rows.length, 5);
    equal(grants.rows.every((entry) => entry.allowed === false), true);
    equal((await db.query("select has_schema_privilege($1, 'excalidraw_private', 'USAGE') as allowed", [role])).rows[0].allowed, false);
  }
  equal((await db.query("select count(*)::integer as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='excalidraw_private' and c.relkind='r' and c.relrowsecurity")).rows[0].n, 4);
  equal((await db.query("select count(*)::integer as n from pg_policies where schemaname='excalidraw_private'")).rows[0].n, 0);
  equal((await db.query("select bool_and(has_function_privilege('service_role', p.oid, 'EXECUTE')) as allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'excalidraw_%'")).rows[0].allowed, true);
  equal((await db.query("select public from storage.buckets where id='excalidraw-encrypted'")).rows[0].public, false);

  // Real role switching verifies permissions, not only catalog introspection.
  await db.exec("set role anon");
  await assert.rejects(() => invoke("excalidraw_get_scene", ["rooms", id, hash]), /permission denied/); checks++;
  await db.exec("reset role; set role service_role");
  equal((await invoke("excalidraw_get_scene", ["rooms", id, hash])).status, 200);
  await assert.rejects(() => db.query("select * from excalidraw_private.scenes"), /permission denied/); checks++;
  await db.exec("reset role");

  // Same-ID concurrent first-writers can never replace the first capability.
  const raceId = "22222222222222222222";
  const claims = await Promise.all([create(raceId, hash), create(raceId, wrong)]);
  equal(claims.map((entry) => entry.status).sort(), [201, 403]);

  // Durable IP creation ceiling and exact max-size SQL validation.
  const rateIp = "d".repeat(64);
  for (let i = 1; i <= 30; i++) equal((await create(i.toString(16).padStart(20, "0"), hash, "rooms", rateIp)).status, 201);
  equal((await create("eeeeeeeeeeeeeeeeeeee", hash, "rooms", rateIp)).status, 429);
  const maxCiphertext = Buffer.alloc(4194304, 7).toString("base64");
  equal((await invoke("excalidraw_create_scene", ["rooms", "ffffffffffffffffffff", hash, 1, iv, maxCiphertext, "e".repeat(64)])).status, 201);
  await assert.rejects(() => invoke("excalidraw_create_scene", ["rooms", "dddddddddddddddddddd", hash, 1, iv, Buffer.alloc(4194305).toString("base64"), ip]), /Invalid encrypted payload/); checks++;

  // Quota refusal never mutates a known scene or its verifier/revision.
  await db.exec("begin; update excalidraw_private.budget set scene_bytes=201326592");
  equal((await create("99999999999999999999")).status, 507);
  equal((await invoke("excalidraw_get_scene", ["rooms", id, hash])).record.revision, 3);
  await db.exec("rollback");
  await db.exec("begin; update excalidraw_private.budget set file_bytes=536870912");
  equal((await invoke("excalidraw_reserve_file", ["rooms", id, hash, "quota-file", 20])).status, 507);
  await db.exec("rollback");
  await db.exec("begin; update excalidraw_private.budget set daily_creations=500");
  equal((await create("99999999999999999999")).status, 429);
  equal((await update(3)).status, 200); // Throttled creation never blocks existing saves.
  await db.exec("rollback");
  console.log(`${checks} PostgreSQL invariant checks passed (PGlite; no live project touched).`);
} finally {
  await db.close();
}
