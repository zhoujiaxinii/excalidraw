// Synthetic, isolated clients exercising the shipped transport against Supabase.
import assert from 'node:assert/strict';
import { webcrypto, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { createClient } from '@supabase/supabase-js';

const url = 'https://tpxtjxebqboatqcakwma.supabase.co';
const publishableKey = 'sb_publishable_B46QPGATYQ5aIO9-Q69KcQ_GNxUjQ1Q';
if (!process.argv.includes('--run-live')) {
  console.log('Use --run-live to exchange synthetic encrypted data on the dedicated Supabase project.');
  process.exit(0);
}
const outfile = `/tmp/excalidraw-realtime-${process.pid}.mjs`;
await build({ entryPoints: ['excalidraw-app/collab/SupabaseSocket.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile,
  define: { 'import.meta.env.VITE_APP_SUPABASE_URL': JSON.stringify(url),
    'import.meta.env.VITE_APP_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(publishableKey) } });
const { SupabaseSocket } = await import(outfile);
const roomId = randomBytes(10).toString('hex');
const keyBytes = randomBytes(16);
const linkKey = keyBytes.toString('base64url');
const topic = `room:${Buffer.from(await webcrypto.subtle.digest('SHA-256',
  new TextEncoder().encode(`excalidraw-realtime:v1:rooms:${roomId}:${linkKey}`))).toString('hex')}`;
const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
const owner = () => ({ crypto: webcrypto, btoa, atob, setTimeout, clearTimeout, setInterval, clearInterval });
const clients = [0, 1].map(() => createClient(url, publishableKey,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }));
const sockets = clients.map((client) => new SupabaseSocket(client, topic, roomId, owner()));
const waitEvent = (socket, event) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out: ${event}`)), 25000);
  socket.once(event, (...args) => { clearTimeout(timer); resolve(args); });
});
let received;
try {
  const memberships = sockets.map((socket) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out: two peer presence')), 25000);
    socket.on('room-user-change', (members) => {
      if (members.length === 2) { clearTimeout(timer); resolve(); }
    });
  }));
  const connections = sockets.map((socket) => {
    socket.on('init-room', () => socket.emit('join-room', roomId));
    socket.on('error', (error) => console.error('Transport:', error.message));
    return waitEvent(socket, 'connect');
  });
  sockets.forEach((socket) => socket.connect());
  await Promise.all(connections);
  await Promise.all(memberships);
  assert.notEqual(sockets[0].id, sockets[1].id);
  console.log('PASS: two independent SDK clients joined with distinct identities');
  const plaintext = new TextEncoder().encode(JSON.stringify({
    type: 'SCENE_UPDATE', synthetic: true, label: 'Encrypted transport acceptance test',
    padding: 'x'.repeat(300000),
  }));
  const iv = randomBytes(12);
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  received = waitEvent(sockets[1], 'client-broadcast');
  sockets[0].emit('server-broadcast', roomId, ciphertext, iv);
  const [incoming, incomingIv] = await received;
  const decoded = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: incomingIv }, key, incoming);
  assert.deepEqual(new Uint8Array(decoded), plaintext);
  console.log('PASS: 300 KB encrypted scene traversed chunking/reassembly and decrypted identically');
  received = waitEvent(sockets[0], 'client-broadcast');
  sockets[1].emit('server-broadcast', roomId, incoming, incomingIv);
  const [returned, returnedIv] = await received;
  assert.deepEqual(new Uint8Array(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: returnedIv }, key, returned)), plaintext);
  console.log('PASS: reverse edit delivery works independently of shared browser storage');
  const wrongKey = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['decrypt']);
  await assert.rejects(webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: returnedIv }, wrongKey, returned));
  console.log('PASS: wrong encryption key cannot read delivered data');
} finally {
  sockets.forEach((socket) => socket.close());
  await Promise.all(clients.map(async (client) => { await client.removeAllChannels(); client.realtime.disconnect(); }));
}
