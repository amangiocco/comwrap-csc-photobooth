import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createApp } from '../server/app.js';
import { ADMIN_HASH } from './helpers/admin.js';

const KEY = 'test-key';
const VIDEO = Buffer.from('fake mp4 bytes'.repeat(10));

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

/** Starts the app with one active event «festa»; returns { base, dataDir, hub, call }. */
async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-upload-'));
  const { app, hub } = createApp({ dataDir, apiKey: KEY, adminPasswordHash: ADMIN_HASH, ...options });
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    hub.closeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (method, url, { body, headers = {}, key = KEY } = {}) => fetch(base + url, {
    method,
    headers: { ...(key ? { 'x-api-key': key } : {}), ...headers },
    body,
  });
  const json = (method, url, data, opts) => call(method, url, {
    ...opts, body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' },
  });
  assert.equal((await json('POST', '/api/events', { name: 'Festa' })).status, 201);
  assert.equal((await json('PATCH', '/api/events/festa', { active: true })).status, 200);
  return { base, dataDir, hub, call, json };
}

/** A second server playing the role of the site where the AI video was generated. */
async function videoSource(t) {
  const server = http.createServer((req, res) => {
    if (req.url === '/clip.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(VIDEO);
    } else if (req.url === '/download?id=1') {
      res.writeHead(200, { 'Content-Type': 'video/webm' });
      res.end(VIDEO);
    } else if (req.url === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const base = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return base;
}

function videoForm(field = 'data', name = 'clip.mp4', type = 'video/mp4') {
  const form = new FormData();
  form.append('title', 'Mario e Anna');
  form.append(field, new Blob([VIDEO], { type }), name);
  return form;
}

test('multipart upload with any field name is stored and served', async (t) => {
  const { dataDir, call } = await setup(t);
  const response = await call('POST', '/api/events/festa/videos', { body: videoForm('whatever') });
  assert.equal(response.status, 201);
  const video = await response.json();
  assert.equal(video.title, 'Mario e Anna');
  assert.equal(video.source, 'upload');
  assert.match(video.url, /^\/media\/festa\/.+\.mp4$/);
  assert.deepEqual(await readFile(path.join(dataDir, 'media', 'festa', video.file)), VIDEO);

  const media = await call('GET', video.url, { key: null });
  assert.equal(media.status, 200);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), VIDEO);

  const range = await call('GET', video.url, { key: null, headers: { Range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'fake');

  const wall = await (await call('GET', '/api/events/festa/wall', { key: null })).json();
  assert.equal(wall.active, true);
  assert.equal(wall.videos.length, 1);
});

test('JSON with url downloads the video', async (t) => {
  const source = await videoSource(t);
  const { dataDir, json } = await setup(t);
  const response = await json('POST', '/api/events/festa/videos', { url: `${source}/clip.mp4`, title: 'Da URL' });
  assert.equal(response.status, 201);
  const video = await response.json();
  assert.equal(video.source, 'url');
  assert.equal(video.title, 'Da URL');
  assert.deepEqual(await readFile(path.join(dataDir, 'media', 'festa', video.file)), VIDEO);

  // no extension in the URL: the content type decides
  const typed = await (await json('POST', '/api/events/festa/videos', { url: `${source}/download?id=1` })).json();
  assert.match(typed.file, /\.webm$/);
});

test('url download errors', async (t) => {
  const source = await videoSource(t);
  const { json } = await setup(t, { maxUploadMb: 50 / (1024 * 1024) });
  const post = (url) => json('POST', '/api/events/festa/videos', { url });
  assert.equal((await post(`${source}/page.html`)).status, 415);
  assert.equal((await post(`${source}/missing.mp4`)).status, 502);
  assert.equal((await post('ftp://example.com/a.mp4')).status, 400);
  assert.equal((await post('not a url')).status, 400);
  assert.equal((await post(`${source}/clip.mp4`)).status, 413);
});

test('rejects missing key, inactive or unknown events and non-video files', async (t) => {
  const { call, json, dataDir } = await setup(t);
  assert.equal((await call('POST', '/api/events/festa/videos', { body: videoForm(), key: null })).status, 401);
  assert.equal((await call('POST', '/api/events/festa/videos', { body: videoForm(), key: 'wrong' })).status, 401);
  const bearer = await call('POST', '/api/events/festa/videos', {
    body: videoForm(), key: null, headers: { Authorization: `Bearer ${KEY}` },
  });
  assert.equal(bearer.status, 201);
  assert.equal((await call('POST', '/api/events/nope/videos', { body: videoForm() })).status, 404);
  assert.equal((await call('POST', '/api/events/festa/videos', { body: videoForm('f', 'a.txt', 'text/plain') })).status, 415);
  assert.equal((await json('POST', '/api/events/festa/videos', {})).status, 400);

  await json('PATCH', '/api/events/festa', { active: false });
  const off = await call('POST', '/api/events/festa/videos', { body: videoForm() });
  assert.equal(off.status, 409);

  const events = await (await call('GET', '/api/events')).json();
  assert.equal(events[0].videos.length, 1);
  assert.ok(dataDir);
});

test('rejects multipart files over the size limit', async (t) => {
  const { call } = await setup(t, { maxUploadMb: 50 / (1024 * 1024) });
  const response = await call('POST', '/api/events/festa/videos', { body: videoForm() });
  assert.equal(response.status, 413);
});

test('the wall stream announces new videos and on/off', async (t) => {
  const { base, call, json } = await setup(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${base}/api/events/festa/stream`, { signal: controller.signal });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  async function waitFor(type) {
    while (!buffer.includes(`event: ${type}\n`)) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) throw new Error('stream closed');
      buffer += value;
    }
    const start = buffer.indexOf(`event: ${type}\n`);
    const end = buffer.indexOf('\n\n', start);
    const data = JSON.parse(buffer.slice(start, end).split('data: ')[1]);
    buffer = buffer.slice(end + 2);
    return data;
  }

  assert.equal((await waitFor('status')).active, true);
  const video = await (await call('POST', '/api/events/festa/videos', { body: videoForm() })).json();
  assert.equal((await waitFor('video')).id, video.id);
  await call('DELETE', `/api/events/festa/videos/${video.id}`);
  assert.equal((await waitFor('removed')).id, video.id);
  await json('PATCH', '/api/events/festa', { active: false });
  assert.equal((await waitFor('status')).active, false);
});

test('a YouTube link is stored as an embed, without downloading', async (t) => {
  const { call, json } = await setup(t);
  const response = await json('POST', '/api/events/festa/videos', {
    url: 'https://www.youtube.com/watch?v=LXb3EKWsInQ', title: 'Costa Rica',
  });
  assert.equal(response.status, 201);
  const video = await response.json();
  assert.equal(video.source, 'youtube');
  assert.equal(video.youtubeId, 'LXb3EKWsInQ');
  assert.equal(video.url, null);
  assert.equal(video.title, 'Costa Rica');
  assert.equal((await call('DELETE', `/api/events/festa/videos/${video.id}`)).status, 204);
});

test('userid is stored with the video, from JSON and from multipart', async (t) => {
  const { call, json } = await setup(t);
  const fromJson = await (await json('POST', '/api/events/festa/videos', {
    url: 'https://youtu.be/LXb3EKWsInQ', userid: '  Mario  ',
  })).json();
  assert.equal(fromJson.userId, 'Mario');
  const form = videoForm();
  form.append('userid', 'Anna');
  const fromForm = await (await call('POST', '/api/events/festa/videos', { body: form })).json();
  assert.equal(fromForm.userId, 'Anna');
  const wall = await (await call('GET', '/api/events/festa/wall', { key: null })).json();
  assert.deepEqual(wall.videos.map((v) => v.userId), ['Mario', 'Anna']);
  assert.equal(wall.showcaseSeconds, 8);
});
