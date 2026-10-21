import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { attachLive, createApp } from '../server/app.js';
import { ADMIN_HASH } from './helpers/admin.js';

const KEY = 'k';

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-live-'));
  const { app, hub, store } = createApp({ dataDir, apiKey: KEY, adminPasswordHash: ADMIN_HASH, placeholder: 'https://youtu.be/LXb3EKWsInQ' });
  const server = http.createServer(app);
  const wss = attachLive(server, { store, hub });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `127.0.0.1:${server.address().port}`;
  t.after(async () => {
    hub.closeAll();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (method, url, body, headers = {}) => fetch(`http://${base}${url}`, {
    method, headers: { 'x-api-key': KEY, ...headers }, body,
  });
  const json = (method, url, data) => call(method, url, JSON.stringify(data), { 'Content-Type': 'application/json' });
  await json('POST', '/api/events', { name: 'Festa' });
  await json('PATCH', '/api/events/festa', { active: true });
  return {
    base, call, dataDir, store,
  };
}

/** Collects the messages of a WebSocket; next(type) waits for the next one of that type. */
function listen(url) {
  const socket = new WebSocket(url);
  const messages = [];
  const waiting = [];
  socket.addEventListener('message', (e) => {
    messages.push(JSON.parse(e.data));
    waiting.splice(0).forEach((check) => check());
  });
  const next = (type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nessun messaggio «${type}»`)), 3000);
    const check = () => {
      const index = messages.findIndex((m) => m.type === type);
      if (index === -1) { waiting.push(check); return; }
      clearTimeout(timer);
      resolve(messages.splice(index, 1)[0].data);
    };
    check();
  });
  return { socket, next };
}

const video = () => {
  const form = new FormData();
  form.append('v', new Blob(['fake mp4'], { type: 'video/mp4' }), 'clip.mp4');
  return form;
};

test('live updates over WebSocket; «delete all» videos announces each removal', async (t) => {
  const {
    base, call, dataDir,
  } = await setup(t);
  const live = listen(`ws://${base}/api/events/festa/live`);
  t.after(() => live.socket.close());
  assert.equal((await live.next('status')).active, true);

  const first = await (await call('POST', '/festa/wall', video())).json();
  assert.equal((await live.next('video')).id, first.id);
  const second = await (await call('POST', '/festa/wall', video())).json();
  await live.next('video');
  assert.ok(existsSync(path.join(dataDir, 'media', 'festa', second.file)));

  assert.equal((await call('DELETE', '/api/events/festa/videos', undefined, { 'x-api-key': 'no' })).status, 401);
  const cleared = await (await call('DELETE', '/api/events/festa/videos')).json();
  assert.equal(cleared.removed, 2);
  const removed = [(await live.next('removed')).id, (await live.next('removed')).id];
  assert.deepEqual(removed.sort(), [first.id, second.id].sort());
  assert.equal(existsSync(path.join(dataDir, 'media', 'festa', second.file)), false, 'files deleted');
  const events = await (await call('GET', '/api/events')).json();
  assert.deepEqual(events[0].videos, []);

  // the sample cards go too, and the wall is told to reload; the switch brings them back
  await live.next('settings');
  assert.equal(events[0].showPlaceholder, false);
  assert.equal((await (await call('GET', '/api/events/festa/wall')).json()).placeholder, null);
  await call('PATCH', '/api/events/festa', JSON.stringify({ showPlaceholder: true }), { 'Content-Type': 'application/json' });
  await live.next('settings');
  assert.deepEqual((await (await call('GET', '/api/events/festa/wall')).json()).placeholder, { type: 'youtube', id: 'LXb3EKWsInQ' });
});

test('the template cannot be changed through the event update', async (t) => {
  const { call } = await setup(t);
  await call('PATCH', '/api/events/festa', JSON.stringify({ template: { version: 'x' } }), { 'Content-Type': 'application/json' });
  const [event] = await (await call('GET', '/api/events')).json();
  assert.equal(event.template, null);
});

test('a WebSocket for an unknown event is refused', async (t) => {
  const { base } = await setup(t);
  const socket = new WebSocket(`ws://${base}/api/events/nessuno/live`);
  const outcome = await new Promise((resolve) => {
    socket.addEventListener('open', () => resolve('open'));
    socket.addEventListener('error', () => resolve('refused'));
  });
  assert.equal(outcome, 'refused');
});
