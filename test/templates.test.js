import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { ADMIN_HASH, adminCookie } from './helpers/admin.js';
import { createAgent } from '../print/agent.js';
import { writeCardTemplate, writeTextTemplate, bluePhoto } from './helpers/template.js';

const KEY = 'k';
const SCORES = {
  userid: 'Mario', total: 87, technique: 9, fun: 95, style: 78, performance: 100,
};
const SYSTEM_FONT = 'C:/Windows/Fonts/arial.ttf';

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-tpl-'));
  const { app, hub } = createApp({ dataDir: path.join(dir, 'data'), apiKey: KEY, adminPasswordHash: ADMIN_HASH });
  const server = http.createServer(app);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    hub.closeAll();
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    await rm(dir, { recursive: true, force: true });
  });
  const cookie = await adminCookie(base);
  const call = (method, url, { body, key = KEY, headers = {} } = {}) => fetch(base + url, {
    method, headers: { ...(key ? { 'x-api-key': key, cookie } : {}), ...headers }, body,
  });
  const json = (method, url, data) => call(method, url, { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } });
  await json('POST', '/api/events', { name: 'Festa' });
  await json('PATCH', '/api/events/festa', { active: true });
  const upload = async (url, files) => {
    const form = new FormData();
    for (const [name, data] of files) form.append('file', new Blob([data]), name);
    return call('POST', url, { body: form });
  };
  return {
    dir, base, call, upload,
  };
}

test('a PSD uploaded from the admin is checked, previewed and used for the card that is printed', async (t) => {
  const {
    dir, base, call, upload,
  } = await setup(t);
  const psd = await readFile(await writeCardTemplate(dir));
  assert.equal((await upload('/api/events/festa/template', [['cornice.psd', psd]])).status, 201);
  const [event] = await (await call('GET', '/api/events')).json();
  const tpl = event.template;
  assert.equal(tpl.originalName, 'cornice.psd');
  assert.deepEqual([tpl.info.width, tpl.info.height, tpl.info.photoLayer, tpl.info.mode], [300, 200, 'card', 'composite']);
  assert.equal((await call('GET', tpl.previewUrl, { key: null })).status, 401);
  const preview = await call('GET', tpl.previewUrl);
  assert.equal(preview.status, 200);
  assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).format, 'jpeg');

  // the server makes the card with the uploaded template when the photo arrives
  const form = new FormData();
  Object.entries(SCORES).forEach(([k, v]) => form.append(k, String(v)));
  form.append('foto', new Blob([await bluePhoto()], { type: 'image/png' }), 'a.png');
  const sent = await (await call('POST', '/festa/print', { body: form })).json();
  assert.deepEqual(sent.print, { ok: true, status: 'queued', copies: 1 });
  assert.equal(sent.mail, null, 'no «to»: no mail');
  const [item] = await (await call('GET', '/api/print/queue')).json();
  assert.equal(item.template.version, tpl.version);
  assert.equal(item.cardUrl, `/api/print/photos/${item.id}/card`);

  const logs = [];
  const agent = createAgent({
    server: base,
    apiKey: KEY,
    templatePath: path.join(dir, 'nessuna-cartella'),
    outputDir: path.join(dir, 'prints'),
    cacheDir: path.join(dir, 'cache'),
    keepFiles: true,
    log: (line) => logs.push(line),
  });
  const [file] = await agent.runOnce();
  // the agent prints the server's card: it does not download the template
  assert.ok(!logs.some((line) => line.startsWith('Template dell\'evento')), logs.join('\n'));
  assert.ok(!existsSync(path.join(dir, 'cache', 'festa')));
  // the sheet holds the composed template: green frame of the test PSD around the photo
  const { data, info } = await sharp(await readFile(file)).raw().toBuffer({ resolveWithObject: true });
  const at = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
  const green = at(info.width / 2, 40);
  assert.ok(green[1] > 200 && green[0] < 80, `frame from the uploaded template ${green}`);
});

test('wrong uploads are refused and leave nothing behind', async (t) => {
  const { call, upload } = await setup(t);
  assert.equal((await upload('/api/events/festa/template', [['foto.jpg', Buffer.from('x')]])).status, 415);
  const broken = await upload('/api/events/festa/template', [['rotto.psd', Buffer.from('not a psd at all')]]);
  assert.equal(broken.status, 400);
  assert.match((await broken.json()).error, /non si può usare/);
  assert.equal((await upload('/api/events/festa/template/fonts', [['a.ttf', Buffer.from('x')]])).status, 409, 'fonts need a PSD first');
  const [event] = await (await call('GET', '/api/events')).json();
  assert.equal(event.template, null);
});

test('fonts: added and removed at runtime, each change is a new version', { skip: !existsSync(SYSTEM_FONT) && 'no Arial on this system' }, async (t) => {
  const { dir, call, upload } = await setup(t);
  const { file } = await writeTextTemplate(dir);
  const first = await (await upload('/api/events/festa/template', [['testi.psd', await readFile(file)]])).json();
  assert.equal(first.info.texts[0].found, true, 'Impact is a system font');

  const withFont = await (await upload('/api/events/festa/template/fonts', [['arial.ttf', await readFile(SYSTEM_FONT)]])).json();
  assert.deepEqual(withFont.fonts.map((f) => f.file), ['arial.ttf']);
  assert.notEqual(withFont.version, first.version);
  const font = await call('GET', '/api/print/templates/festa/fonts/arial.ttf');
  assert.equal(font.status, 200);
  assert.equal((await call('GET', `/api/print/templates/festa/${first.version}`)).status, 404, 'old version gone');
  assert.equal((await call('GET', `/api/print/templates/festa/${withFont.version}`)).status, 200);

  const without = await (await call('DELETE', '/api/events/festa/template/fonts/arial.ttf')).json();
  assert.deepEqual(without.fonts, []);
  assert.equal((await call('DELETE', '/api/events/festa/template')).status, 204);
  const [event] = await (await call('GET', '/api/events')).json();
  assert.equal(event.template, null);
});
