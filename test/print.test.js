import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../server/app.js';
import { ADMIN_HASH, adminCookie } from './helpers/admin.js';
import { createAgent, printValues, toPdf } from '../print/agent.js';
import { writeTemplate, bluePhoto } from './helpers/template.js';

const KEY = 'test-key';
const SCORES = {
  total: 87, technique: 9, fun: 95, style: 78, performance: 100,
};

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

/** App with one active event «festa», plus a temp dir; returns helpers. */
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-print-'));
  const { app, hub } = createApp({ dataDir: path.join(dir, 'data'), apiKey: KEY, adminPasswordHash: ADMIN_HASH });
  const server = http.createServer(app);
  const base = await listen(server);
  t.after(async () => {
    hub.closeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const cookie = await adminCookie(base);
  const call = (method, url, {
    body, headers = {}, key = KEY, redirect,
  } = {}) => fetch(base + url, {
    method, headers: { ...(key ? { 'x-api-key': key, cookie } : {}), ...headers }, body, redirect,
  });
  const json = (method, url, data) => call(method, url, {
    body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' },
  });
  await json('POST', '/api/events', { name: 'Festa' });
  await json('PATCH', '/api/events/festa', { active: true });
  const sendPhoto = async (fields = {}) => {
    const form = new FormData();
    Object.entries({ userid: 'Ospite', ...SCORES, ...fields }).forEach(([k, v]) => form.append(k, String(v)));
    form.append('foto', new Blob([await bluePhoto()], { type: 'image/png' }), 'scatto.png');
    return call('POST', '/api/events/festa/photos', { body: form });
  };
  return {
    dir, base, call, json, sendPhoto,
  };
}

test('photos are queued, claimed once and served only with the key', async (t) => {
  const { call, json, sendPhoto } = await setup(t);
  const response = await sendPhoto({ userid: 'Mario', copies: '2' });
  assert.equal(response.status, 201);
  const photo = await response.json();
  assert.equal(photo.status, 'queued');
  assert.equal(photo.userId, 'Mario');
  assert.equal(photo.copies, 2);
  assert.deepEqual(photo.scores, SCORES);
  assert.match(photo.file, /\.png$/);

  const queue = await (await call('GET', '/api/print/queue')).json();
  assert.deepEqual(queue.map((p) => [p.id, p.slug, p.eventName]), [[photo.id, 'festa', 'Festa']]);

  assert.equal((await call('GET', photo.fileUrl, { key: null })).status, 401);
  const file = await call('GET', photo.fileUrl);
  assert.equal(file.status, 200);
  assert.equal((await sharp(Buffer.from(await file.arrayBuffer())).metadata()).width, 400);

  assert.equal((await call('POST', `/api/print/photos/${photo.id}/claim`)).status, 200);
  assert.equal((await call('POST', `/api/print/photos/${photo.id}/claim`)).status, 409);
  assert.deepEqual(await (await call('GET', '/api/print/queue')).json(), []);

  await json('POST', `/api/print/photos/${photo.id}/result`, { ok: false, error: 'carta finita' });
  let events = await (await call('GET', '/api/events')).json();
  assert.equal(events[0].photos[0].status, 'failed');
  assert.equal(events[0].photos[0].error, 'carta finita');

  assert.equal((await call('POST', `/api/events/festa/photos/${photo.id}/reprint`)).status, 200);
  assert.equal((await (await call('GET', '/api/print/queue')).json()).length, 1);

  // an event switched off pauses its queue
  await json('PATCH', '/api/events/festa', { active: false });
  assert.deepEqual(await (await call('GET', '/api/print/queue')).json(), []);
  assert.equal((await sendPhoto()).status, 409);

  assert.equal((await call('DELETE', `/api/events/festa/photos/${photo.id}`)).status, 204);
  events = await (await call('GET', '/api/events')).json();
  assert.deepEqual(events[0].photos, []);
});

test('photo upload checks', async (t) => {
  const { call, json } = await setup(t);
  const text = new FormData();
  text.append('f', new Blob(['ciao'], { type: 'text/plain' }), 'a.txt');
  assert.equal((await call('POST', '/api/events/festa/photos', { body: text })).status, 415);
  assert.equal((await json('POST', '/api/events/festa/photos', {})).status, 400);
  // userid and all five scores are required, and the scores must be numbers
  const missing = await json('POST', '/api/events/festa/photos', { url: 'http://x/y.jpg', userid: 'A', total: 'tanto', fun: 3 });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /total, technique, style, performance/);
  const noUser = new FormData();
  Object.entries(SCORES).forEach(([k, v]) => noUser.append(k, String(v)));
  noUser.append('foto', new Blob([await bluePhoto()], { type: 'image/png' }), 'a.png');
  assert.equal((await call('POST', '/api/events/festa/photos', { body: noUser })).status, 400);
  assert.equal((await call('POST', '/api/events/festa/photos', { body: new FormData(), key: 'no' })).status, 401);

  const source = http.createServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(await sharp(await bluePhoto()).jpeg().toBuffer());
  });
  const sourceBase = await listen(source);
  t.after(() => new Promise((resolve) => { source.close(resolve); }));
  const fromUrl = await json('POST', '/api/events/festa/photos', { url: `${sourceBase}/x`, userid: 'Anna', ...SCORES });
  assert.equal(fromUrl.status, 201);
  const photo = await fromUrl.json();
  assert.match(photo.file, /\.jpg$/);
  assert.equal(photo.source, 'url');
});

test('the agent merges the photo into the template, saves it and prints it', async (t) => {
  const {
    dir, base, call, sendPhoto,
  } = await setup(t);
  const photo = await (await sendPhoto({ userid: 'Mario Rossi', copies: '3' })).json();
  const printed = [];
  const logs = [];
  const agent = createAgent({
    server: base,
    apiKey: KEY,
    printer: 'Stampante finta',
    templatePath: await writeTemplate(dir),
    outputDir: path.join(dir, 'prints'),
    keepFiles: true,
    print: async (file, options) => printed.push({ file, ...options }),
    log: (line) => logs.push(line),
  });
  const [jpegFile] = await agent.runOnce();
  assert.ok(jpegFile.includes(path.join('prints', 'festa')));
  assert.match(path.basename(jpegFile), /Mario_Rossi/);
  const meta = await sharp(await readFile(jpegFile)).metadata();
  // the test template is landscape: default 10×15 paper turned the same way, at 300 dpi
  assert.deepEqual([meta.width, meta.height], [1800, 1200]);

  assert.equal(printed.length, 1);
  assert.equal(printed[0].printer, 'Stampante finta');
  assert.equal(printed[0].copies, 3);
  assert.ok(existsSync(printed[0].file) && printed[0].file.endsWith('.pdf'));

  const events = await (await call('GET', '/api/events')).json();
  const stored = events[0].photos.find((p) => p.id === photo.id);
  assert.equal(stored.status, 'printed');
  assert.equal(stored.prints, 1);

  // the composed picture is on the public print page
  const page = await (await call('GET', '/api/events/festa/prints', { key: null })).json();
  assert.equal(page.prints[0].userId, 'Mario Rossi');
  assert.equal(page.prints[0].status, 'printed');
  assert.equal(page.prints[0].file, undefined, 'no file names of the original photo');
  // for the print dialog: printer, copies and the sheet
  assert.equal(page.prints[0].printer, 'Stampante finta');
  assert.equal(page.prints[0].copies, 3);
  assert.deepEqual(page.prints[0].paper, { widthMm: 152.4, heightMm: 101.6 });
  const preview = await call('GET', page.prints[0].previewUrl, { key: null });
  assert.equal(preview.status, 200);
  // the preview is a light copy for the screen
  assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width, 1200);
  assert.equal((await call('GET', '/print/festa', { key: null })).status, 200);
  assert.deepEqual(await agent.runOnce(), [], 'nothing left to print');

  const info = await (await call('GET', '/api/info')).json();
  assert.equal(info.printAgent.printer, 'Stampante finta');
  assert.ok(logs.some((line) => line.startsWith('Template caricato')));
});

test('without a printer the agent only saves; a print error marks the photo failed', async (t) => {
  const { dir, base, call, sendPhoto } = await setup(t);
  await sendPhoto();
  const saver = createAgent({
    server: base, apiKey: KEY, templatePath: path.join(dir, 'manca.psd'), outputDir: path.join(dir, 'prints'), keepFiles: true, log: () => {},
  });
  const [file] = await saver.runOnce();
  assert.ok(existsSync(file));

  await sendPhoto();
  const broken = createAgent({
    server: base,
    apiKey: KEY,
    printer: 'X',
    templatePath: path.join(dir, 'manca.psd'),
    outputDir: path.join(dir, 'prints'),
    print: async () => { throw new Error('stampante spenta'); },
    log: () => {},
  });
  assert.deepEqual(await broken.runOnce(), []);
  const events = await (await call('GET', '/api/events')).json();
  assert.deepEqual(events[0].photos.map((p) => p.status), ['saved', 'failed']);
  assert.equal(events[0].photos[1].error, 'stampante spenta');
});

test('the PDF page has the real size of the picture', async () => {
  // 1800×1200 px at 300 dpi = 6×4 inches = 432×288 points
  const jpeg = await sharp({
    create: {
      width: 1800, height: 1200, channels: 3, background: '#fff',
    },
  }).withMetadata({ density: 300 }).jpeg().toBuffer();
  const page = (await PDFDocument.load(await toPdf(jpeg))).getPage(0);
  assert.deepEqual([page.getWidth(), page.getHeight()], [432, 288]);
});

test('values for the template: name as sent, scores with two digits', () => {
  assert.deepEqual(printValues({ userId: 'Mario Rossi', scores: SCORES }), {
    name: 'Mario Rossi', total: '87', technique: '09', fun: '95', style: '78', performance: '100',
  });
});

test('print settings of the event reach the agent and shape the sheet', async (t) => {
  const {
    dir, base, call, json, sendPhoto,
  } = await setup(t);
  assert.equal((await json('PATCH', '/api/events/festa', { printSettings: { paper: 'A9' } })).status, 400);
  const saved = await (await json('PATCH', '/api/events/festa', {
    printSettings: { paper: 'A6', border: 'uniform', borderMm: 4, margins: { top: 2, right: 2, bottom: 2, left: 2 } },
  })).json();
  assert.equal(saved.printSettings.paper, 'A6');
  assert.equal(saved.printSettings.widthMm, 105);

  await sendPhoto({ userid: 'Mario' });
  const [item] = await (await call('GET', '/api/print/queue')).json();
  assert.equal(item.printSettings.border, 'uniform');

  const printed = [];
  const agent = createAgent({
    server: base,
    apiKey: KEY,
    printer: 'P',
    templatePath: await writeTemplate(dir),
    outputDir: path.join(dir, 'prints'),
    keepFiles: true,
    print: async (file, options) => printed.push(options),
    log: () => {},
  });
  const [file] = await agent.runOnce();
  const meta = await sharp(await readFile(file)).metadata();
  // A6 at 300 dpi, landscape like the test template: 148×105 mm = 1748×1240 px
  assert.deepEqual([meta.width, meta.height], [1748, 1240]);
  assert.equal(printed[0].scale, 'fit');

  const page = await (await call('GET', '/api/events/festa/prints', { key: null })).json();
  assert.deepEqual(page.prints[0].paper, { widthMm: 148, heightMm: 105 });
  assert.equal(page.prints[0].layout.paper, 'A6 (10,5×14,8 cm)');
  assert.match(page.prints[0].layout.border, /4 mm/);
  assert.equal(page.prints[0].layout.margins, '2 mm');
});

test('addresses by event: /<event>/wall and /<event>/print, GET page and POST content', async (t) => {
  const { call, json, sendPhoto } = await setup(t);
  const wall = await call('GET', '/festa/wall', { key: null });
  assert.equal(wall.status, 200);
  assert.match(await wall.text(), /wall\.js/);
  assert.match(await (await call('GET', '/festa/print', { key: null })).text(), /print\.js/);
  const old = await call('GET', '/wall/festa', { key: null, redirect: 'manual' });
  assert.equal(old.status, 301);
  assert.equal(old.headers.get('location'), '/festa/wall');

  const video = new FormData();
  video.append('v', new Blob(['fake mp4'], { type: 'video/mp4' }), 'clip.mp4');
  assert.equal((await call('POST', '/festa/wall', { body: video })).status, 201);
  assert.equal((await call('POST', '/festa/wall', { body: new FormData(), key: null })).status, 401);
  // the photo upload on the same address as the print page
  const form = new FormData();
  Object.entries({ userid: 'A', ...SCORES }).forEach(([k, v]) => form.append(k, String(v)));
  form.append('foto', new Blob([await bluePhoto()], { type: 'image/png' }), 'a.png');
  assert.equal((await call('POST', '/festa/print', { body: form })).status, 201);
  assert.ok(sendPhoto);

  const events = await (await call('GET', '/api/events')).json();
  assert.equal(events[0].wallUrl, '/festa/wall');
  assert.equal(events[0].photoUploadUrl, '/festa/print');
  assert.equal((await json('POST', '/api/events', { name: 'Admin' })).status, 400, 'reserved name');
});

test('by default nothing stays on the PC: the PDF only lives while printing', async (t) => {
  const { dir, base, sendPhoto } = await setup(t);
  await sendPhoto();
  const seen = [];
  const agent = createAgent({
    server: base,
    apiKey: KEY,
    printer: 'P',
    templatePath: await writeTemplate(dir),
    outputDir: path.join(dir, 'prints'),
    print: async (file) => seen.push({ file, exists: existsSync(file) }),
    log: () => {},
  });
  assert.equal((await agent.runOnce()).length, 1);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].exists, 'the printer gets the PDF');
  assert.equal(existsSync(seen[0].file), false, 'and then it is deleted');
  assert.equal(existsSync(path.join(dir, 'prints')), false, 'no sheets kept');
});

test('«delete all» photos removes them with their files and previews', async (t) => {
  const {
    dir, base, call, sendPhoto,
  } = await setup(t);
  await sendPhoto();
  await sendPhoto();
  const agent = createAgent({
    server: base, apiKey: KEY, templatePath: path.join(dir, 'manca.psd'), outputDir: path.join(dir, 'prints'), log: () => {},
  });
  await agent.runOnce();
  const before = await (await call('GET', '/api/events/festa/prints', { key: null })).json();
  const previewUrl = before.prints[0].previewUrl;
  assert.equal((await call('GET', previewUrl, { key: null })).status, 200);

  const cleared = await (await call('DELETE', '/api/events/festa/photos')).json();
  assert.equal(cleared.removed, 2);
  const events = await (await call('GET', '/api/events')).json();
  assert.deepEqual(events[0].photos, []);
  assert.equal((await call('GET', previewUrl, { key: null })).status, 404, 'preview deleted');
  assert.equal(existsSync(path.join(dir, 'data', 'photos', 'festa')) ? (await import('node:fs')).readdirSync(path.join(dir, 'data', 'photos', 'festa')).length : 0, 0);
});
