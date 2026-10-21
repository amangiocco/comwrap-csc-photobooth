import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApp, parsePlaceholder } from '../server/app.js';
import { ADMIN_HASH, adminCookie } from './helpers/admin.js';

test('parsePlaceholder recognises YouTube links and plain video URLs', () => {
  const youtube = { type: 'youtube', id: 'LXb3EKWsInQ' };
  assert.deepEqual(parsePlaceholder('https://www.youtube.com/watch?v=LXb3EKWsInQ'), youtube);
  assert.deepEqual(parsePlaceholder('https://youtu.be/LXb3EKWsInQ?t=10'), youtube);
  assert.deepEqual(parsePlaceholder('https://m.youtube.com/shorts/LXb3EKWsInQ'), youtube);
  assert.deepEqual(parsePlaceholder('https://www.youtube.com/embed/LXb3EKWsInQ'), youtube);
  assert.deepEqual(parsePlaceholder('https://cdn.example.com/loop.mp4'), { type: 'video', url: 'https://cdn.example.com/loop.mp4' });
  assert.equal(parsePlaceholder(''), null);
  assert.equal(parsePlaceholder('not a url'), null);
  assert.equal(parsePlaceholder('javascript:alert(1)'), null);
});

test('wall exposes the placeholder, admin info exposes the public URL', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-wall-'));
  const { app, hub } = createApp({
    dataDir,
    apiKey: 'k',
    adminPasswordHash: ADMIN_HASH,
    placeholder: 'https://www.youtube.com/watch?v=LXb3EKWsInQ',
    publicUrl: 'http://localhost:8080/',
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    hub.closeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const headers = { 'x-api-key': 'k', 'Content-Type': 'application/json' };
  await fetch(`${base}/api/events`, { method: 'POST', headers, body: JSON.stringify({ name: 'Demo' }) });

  const wall = await (await fetch(`${base}/api/events/demo/wall`)).json();
  assert.deepEqual(wall.placeholder, { type: 'youtube', id: 'LXb3EKWsInQ' });

  assert.equal((await fetch(`${base}/api/info`)).status, 401);
  assert.equal((await fetch(`${base}/api/info`, { headers })).status, 401, 'the API key does not open the console');
  const info = await (await fetch(`${base}/api/info`, { headers: { cookie: await adminCookie(base) } })).json();
  assert.equal(info.publicUrl, 'http://localhost:8080');
});
