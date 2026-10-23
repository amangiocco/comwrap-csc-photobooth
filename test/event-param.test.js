import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { ADMIN_HASH } from './helpers/admin.js';

const KEY = 'test-key';
const VIDEO = Buffer.from('fake mp4 bytes'.repeat(10));
const SCORES = {
  total: 87, technique: 90, fun: 95, style: 78, performance: 85,
};

/** The app with two events, «festa» on and «spenta» off; the same address serves both. */
async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-event-'));
  const { app, hub, logger } = createApp({ dataDir, apiKey: KEY, adminPasswordHash: ADMIN_HASH });
  const server = http.createServer(app);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    hub.closeAll();
    logger.close();
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (method, url, { body, headers = {} } = {}) => fetch(base + url, {
    method, headers: { 'x-api-key': KEY, ...headers }, body,
  });
  const json = (method, url, data) => call(method, url, {
    body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' },
  });
  for (const name of ['Festa', 'Spenta']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await json('POST', '/api/events', { name })).status, 201);
  }
  assert.equal((await json('PATCH', '/api/events', { eventID: 'festa', active: true })).status, 200);
  return {
    dataDir, call, json, logger,
  };
}

const videoForm = (event, { eventFirst = false } = {}) => {
  const form = new FormData();
  if (event && eventFirst) form.append('eventID', event);
  form.append('video', new Blob([VIDEO], { type: 'video/mp4' }), 'clip.mp4');
  form.append('userid', 'Mario Rossi');
  // after the file: the server knows the event only once the file is already written
  if (event && !eventFirst) form.append('eventID', event);
  return form;
};

test('videos: one address for every event, the event as a parameter', async (t) => {
  const { dataDir, call, json } = await setup(t);
  // field of the multipart, before or after the file
  for (const eventFirst of [true, false]) {
    // eslint-disable-next-line no-await-in-loop
    const response = await call('POST', '/api/videos', { body: videoForm('festa', { eventFirst }) });
    assert.equal(response.status, 201);
    // eslint-disable-next-line no-await-in-loop
    assert.match((await response.json()).url, /^\/media\/festa\/.+\.mp4$/);
  }
  // in the query and in the header
  assert.equal((await call('POST', '/api/videos?eventID=festa', { body: videoForm() })).status, 201);
  assert.equal((await call('POST', '/api/videos', { body: videoForm(), headers: { 'x-event-id': 'festa' } })).status, 201);
  // JSON
  const yt = await json('POST', '/api/videos', { eventID: 'festa', url: 'https://www.youtube.com/watch?v=LXb3EKWsInQ' });
  assert.equal(yt.status, 201);

  const wall = await (await call('GET', '/api/wall?eventID=festa')).json();
  assert.equal(wall.videos.length, 5);
  assert.equal((await readdir(path.join(dataDir, 'media', 'festa'))).length, 4);
  // nothing left in the staging folder
  assert.deepEqual(await readdir(path.join(dataDir, 'incoming')).catch(() => []), []);
});

test('videos: missing, unknown or switched off event', async (t) => {
  const { dataDir, call, json } = await setup(t);
  const missing = await call('POST', '/api/videos', { body: videoForm() });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /eventID/);
  assert.equal((await call('POST', '/api/videos', { body: videoForm('nessuno') })).status, 404);
  assert.equal((await call('POST', '/api/videos', { body: videoForm('spenta') })).status, 409);
  assert.equal((await call('POST', '/api/videos?eventID=spenta', { body: videoForm() })).status, 409);
  assert.equal((await json('POST', '/api/videos', { url: 'https://esempio.it/v.mp4' })).status, 400);
  // only eventID names the event
  assert.equal((await json('POST', '/api/videos', { event: 'festa', url: 'https://youtu.be/LXb3EKWsInQ' })).status, 400);
  // the refused files are not kept anywhere
  assert.deepEqual(await readdir(path.join(dataDir, 'incoming')).catch(() => []), []);
  assert.deepEqual(await readdir(path.join(dataDir, 'media', 'spenta')).catch(() => []), []);
});

test('photos, clean-up and the event switched on and off with the event as a parameter', async (t) => {
  const { call, json, logger } = await setup(t);
  const jpeg = await sharp({
    create: {
      width: 20, height: 30, channels: 3, background: '#336699',
    },
  }).jpeg().toBuffer();
  const form = new FormData();
  form.append('foto', new Blob([jpeg], { type: 'image/jpeg' }), 'scatto.jpg');
  Object.entries({ userid: 'Mario Rossi', ...SCORES, eventID: 'festa' }).forEach(([k, v]) => form.append(k, String(v)));
  const sent = await call('POST', '/api/photos', { body: form });
  assert.equal(sent.status, 201);
  const photo = await sent.json();

  const prints = await (await call('GET', '/api/prints?eventID=festa')).json();
  assert.deepEqual(prints.prints.map((p) => p.id), [photo.id]);
  assert.equal((await call('POST', `/api/photos/${photo.id}/reprint`)).status, 200);
  assert.equal((await call('DELETE', `/api/photos/${photo.id}?eventID=festa`)).status, 204);

  const video = await (await json('POST', '/api/videos', { eventID: 'festa', url: 'https://youtu.be/LXb3EKWsInQ' })).json();
  assert.equal((await call('DELETE', `/api/videos/${video.id}?eventID=festa`)).status, 204);
  assert.deepEqual(await (await call('DELETE', '/api/videos?eventID=festa')).json(), { removed: 0 });
  assert.deepEqual(await (await call('DELETE', '/api/photos', { headers: { 'x-event-id': 'festa' } })).json(), { removed: 0 });

  assert.equal((await json('PATCH', '/api/events', { eventID: 'festa', active: false })).status, 200);
  assert.equal((await json('POST', '/api/videos', { eventID: 'festa', url: 'https://youtu.be/LXb3EKWsInQ' })).status, 409);
  assert.equal((await json('PATCH', '/api/events', { active: true })).status, 400);

  // the log knows the event even when it is not in the address
  const { entries } = logger.query({ type: 'http' });
  assert.ok(entries.some((e) => e.path === '/api/photos' && e.event === 'festa'));

  assert.equal((await call('DELETE', '/api/events?eventID=spenta')).status, 204);
  assert.equal((await call('GET', '/api/wall?eventID=spenta')).status, 404);
});

test('mail: the event as a parameter too', async (t) => {
  const { json } = await setup(t);
  assert.equal((await json('POST', '/api/mail', { to: 'a@esempio.it' })).status, 400);
  // the event is found: it has no mail template yet
  const noTemplate = await json('POST', '/api/mail', { eventID: 'festa', to: 'a@esempio.it' });
  assert.equal(noTemplate.status, 409);
  assert.match((await noTemplate.json()).error, /modello email/);
});
