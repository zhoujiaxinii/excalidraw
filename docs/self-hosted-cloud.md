# Cloud collaboration for this deployment

The Vercel frontend uses the dedicated `excalidraw-cloud` Supabase project for encrypted room persistence, encrypted image storage, immutable share snapshots, and realtime collaboration. It does not use Excalidraw's upstream collaboration or persistence services.

## Use

1. Open the board and start **Live collaboration**.
2. Bookmark the complete room link, including everything after `#room=`. Share that complete link with collaborators.
3. Wait for **Saved to cloud** before closing. Image uploads are included in the save indicator. If saving fails, keep the page open and export a local `.excalidraw` backup.
4. Open the saved room link later to restore the latest persisted drawing and its images. Edits to this room continue to synchronize.
5. **Export to link** creates an immutable snapshot. Later room edits do not update an earlier snapshot.

A drawing outside a collaboration room is saved only in that browser. This deployment does not include a sign-in-based personal file library, room listing, history, or lost-link recovery.

## Security model

- Encryption keys stay in the link fragment. Scene and image contents are encrypted in the browser with Excalidraw's AES-GCM format.
- Anyone holding a complete room link can read and edit that room. Treat the link as a secret; there is no participant allowlist or revocation control.
- A domain-separated SHA-256 capability authorizes the storage API. Only its hash is persisted. Realtime uses a different derived capability so observing a topic does not grant storage access.
- Realtime channels are capability-addressed public channels. Supabase routes by the unguessable topic, rather than an authenticated membership ACL. Drawing/cursor content is encrypted; presence/control metadata is visible to the realtime provider. A topic holder can disrupt a channel but cannot decrypt or forge scene ciphertext without the drawing key.
- Drawing tables are in a private schema with RLS enabled and no direct client grants. Service-only, fixed-search-path RPCs enforce capability checks, atomic claims, compare-and-swap room writes, and quotas. Storage is private and accessible only through the capability-checked Edge Function.
- The browser contains only the Supabase URL and publishable key. The Edge Function uses the provider's built-in service credential; no service credential belongs in Vite configuration or source control.
- Third-party production analytics and Sentry reporting are disabled in this fork to reduce exposure of link fragments.

## Limits and durability

- Each encrypted scene/snapshot and image is limited to 4 MiB. A room/snapshot can reserve up to 256 images and 128 MiB of encrypted files.
- Project-level application ceilings are 5,000 scenes/snapshots, 192 MiB of scene ciphertext, and 512 MiB of encrypted images. New writes fail explicitly when a limit is reached; existing drawings are not evicted.
- Creation is capped at 500/day project-wide and 30/hour per best-effort daily-HMAC IP signal. Failed image uploads reserve capacity conservatively. No drawing/image expiry or automatic deletion is implemented.
- Anonymous abuse can still exhaust invocation, bandwidth, realtime, or application quotas. These bounds limit stored growth; they are not a guarantee of availability or complete abuse protection.
- Supabase Free may pause an inactive project after one week and has monthly/connection limits. This is persistent cloud storage, not a paid uptime or backup guarantee. Keep important local exports. No paid plan is enabled by this implementation.

## Deploy and verify

The schema is in `supabase/migrations/20261017021921_encrypted_excalidraw_storage.sql`. The Edge Function is `supabase/functions/excalidraw-cloud/index.ts`, deployed as `excalidraw-cloud` with gateway JWT verification disabled because its body implements link-capability authentication. Do not remove its authentication checks.

`VITE_APP_SUPABASE_URL` and `VITE_APP_SUPABASE_PUBLISHABLE_KEY` are public build-time settings. The function's origin allowlist must match a deployment's exact origin before testing browser uploads there. Never add a service-role key to a `VITE_` variable.

Run the repository typecheck/build and focused cloud, transport, lifecycle, and navigation tests. Backend checks:

```sh
deno test --no-config --no-lock supabase/functions/excalidraw-cloud/index.test.ts
PGLITE_MODULE=/path/to/@electric-sql/pglite/dist/index.js node supabase/functions/excalidraw-cloud/sql-invariants.test.mjs
```

Production acceptance requires independent clients exchanging encrypted edits, fresh cloud-only restore after clients close, image download/decryption, snapshot restore, and denial of missing/wrong capabilities and direct database/storage access. Two tabs sharing localStorage alone do not demonstrate durable restore.
