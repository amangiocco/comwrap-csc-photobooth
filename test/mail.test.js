import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { createApp } from '../server/app.js';
import { ADMIN_HASH, adminCookie } from './helpers/admin.js';
import { fill, placeholders } from '../server/mail.js';
import { startSmtp } from './helpers/smtp.js';

const KEY = 'k';
const HTML = `<!doctype html><html><head><title>Ciao {userid}, ecco la tua card</title>
<style>body{color:#333} .a { color: red }</style></head>
<body style="background:url('sfondo.png')"><img src="img/logo.png" alt="logo">
<h1>Ciao {{userid}}!</h1><img src="{card}" alt="card"><p>Punteggio: {total}</p><p><a href="{link}">La tua pagina</a></p>
<img src="https://esempio.it/esterna.png"></body></html>`;
const LINK = 'https://main--photobooth--comwrap.aem.page/mario-rossi';

/** A multipart call with the card as a file, like the n8n HTTP node with «Form-Data». */
function withCard(fields, card) {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  if (card) form.append('card', new Blob([card], { type: 'image/jpeg' }), 'card.jpg');
  return form;
}

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-mail-'));
  const dataDir = path.join(dir, 'data');
  const { app, hub } = createApp({ dataDir, apiKey: KEY, adminPasswordHash: ADMIN_HASH });
  const server = http.createServer(app);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const smtp = await startSmtp();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    hub.closeAll();
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
    await smtp.close();
    await rm(dir, { recursive: true, force: true });
  });
  const cookie = await adminCookie(base);
  const call = (method, url, { body, key = KEY, headers = {} } = {}) => fetch(base + url, {
    method, headers: { ...(key ? { 'x-api-key': key, cookie } : {}), ...headers }, body,
  });
  const json = (method, url, data, opts = {}) => call(method, url, {
    ...opts, body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' },
  });
  await json('POST', '/api/events', { name: 'Festa' });
  await json('PATCH', '/api/events/festa', { active: true });
  const logo = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const card = await sharp({ create: { width: 8, height: 12, channels: 3, background: '#0000ff' } }).jpeg().toBuffer();
  // where n8n could leave the card: a URL the server downloads
  const files = http.createServer((req, res) => {
    if (req.url === '/card.jpg') res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(card);
    else res.writeHead(404).end();
  });
  await new Promise((resolve) => { files.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { files.close(resolve); }));
  const cardUrl = `http://127.0.0.1:${files.address().port}/card.jpg`;
  return {
    dir, dataDir, call, json, smtp, logo, card, cardUrl,
  };
}

const account = (smtp) => ({
  host: '127.0.0.1', port: smtp.port, security: 'none', user: '', password: '', fromAddress: 'photobooth@esempio.it', fromName: 'Photobooth',
});

test('placeholders: {a} and {{a}}, not CSS; values escaped in HTML', () => {
  assert.deepEqual(placeholders(HTML), ['userid', 'card', 'total', 'link']);
  const { text, missing } = fill('<p>{name} {total} {nope}</p>', { name: '<b>Mario</b>', total: 87 });
  assert.equal(text, '<p>&lt;b&gt;Mario&lt;/b&gt; 87 </p>');
  assert.deepEqual(missing, ['nope']);
});

test('account: saved without showing the password, checked, test mail', async (t) => {
  const { json, call, smtp } = await setup(t);
  assert.equal((await json('PUT', '/api/mail/config', { host: '', fromAddress: 'x' })).status, 400);
  const saved = await (await json('PUT', '/api/mail/config', { ...account(smtp), password: 'segreta' })).json();
  assert.equal(saved.passwordSet, true);
  assert.equal(saved.password, undefined, 'the password never goes back to the browser');
  const again = await (await json('PUT', '/api/mail/config', { ...account(smtp), password: '' })).json();
  assert.equal(again.passwordSet, true, 'an empty field keeps it');
  assert.equal((await call('GET', '/api/mail/config', { key: null })).status, 401);
  assert.equal((await call('POST', '/api/mail/verify')).status, 200);
  assert.equal((await json('POST', '/api/mail/test', { to: 'io@esempio.it' })).status, 200);
  assert.deepEqual(smtp.messages[0].to, ['io@esempio.it']);
  assert.match(smtp.messages[0].raw, /mail di prova/);
});

test('template import, preview and sending with the parameters of the call', async (t) => {
  const {
    dataDir, call, json, smtp, logo, card, cardUrl,
  } = await setup(t);
  await json('PUT', '/api/mail/config', account(smtp));
  const form = new FormData();
  form.append('file', new Blob([HTML], { type: 'text/html' }), 'card.html');
  form.append('file', new Blob([logo], { type: 'image/png' }), 'logo.png');
  form.append('file', new Blob([logo], { type: 'image/png' }), 'sfondo.png');
  const imported = await (await call('POST', '/api/events/festa/mail-template', { body: form })).json();
  assert.equal(imported.subject, undefined, 'the subject comes with every call, not from the template');
  assert.deepEqual(imported.placeholders, ['userid', 'card', 'total', 'link']);
  assert.deepEqual(imported.unused, []);
  assert.deepEqual(imported.images.sort(), ['logo.png', 'sfondo.png']);

  const preview = await (await call('GET', imported.previewUrl)).text();
  assert.match(preview, /src="data:image\/png;base64,/);
  assert.match(preview, /<mark[^>]*>\{userid\}<\/mark>/);
  assert.match(preview, /<img src="data:image\/svg\+xml;utf8,[^"]+" alt="card">/, 'a sample card, the attribute not broken');
  assert.match(preview, /<a href="#">/);

  // the card as a file of the multipart call
  const sent = await (await call('POST', '/festa/mail', {
    body: withCard({
      to: 'mario@esempio.it', subject: 'Ciao {userid}, ecco la tua card', userid: 'Mario Rossi', total: '87', link: LINK,
    }, card),
  })).json();
  assert.equal(sent.ok, true);
  assert.deepEqual(sent.missing, []);
  const raw = smtp.messages.at(-1).raw.replace(/=\r\n/g, '');
  assert.match(raw, /Subject: Ciao Mario Rossi, ecco la tua card/);
  assert.match(raw, /Ciao Mario Rossi!/);
  assert.match(raw, /src=3D"cid:img/);
  assert.match(raw, /Content-ID: <img/);
  assert.match(raw, /src=3D"cid:card\./, 'the card in the text');
  assert.match(raw, /Content-ID: <card\./);
  assert.match(raw, /filename=card-Mario-Rossi\.jpg/, 'and attached');
  assert.match(raw, new RegExp(`href=3D"${LINK.replace(/[.]/g, '\\.')}"`));
  assert.match(raw, /https:\/\/esempio\.it\/esterna\.png/, 'absolute images untouched');

  // or as a URL the server downloads (and does not keep)
  const before = (await readdir(os.tmpdir())).filter((n) => n.startsWith('photobooth-card-')).length;
  assert.equal((await json('POST', '/festa/mail', {
    to: 'anna@esempio.it', subject: 'La tua card', userid: 'Anna Bianchi', link: LINK, card: cardUrl, total: 90,
  })).status, 200);
  assert.match(smtp.messages.at(-1).raw.replace(/=\r\n/g, ''), /filename=card-Anna-Bianchi\.jpg/);
  assert.equal((await readdir(os.tmpdir())).filter((n) => n.startsWith('photobooth-card-')).length, before, 'temporary card removed');

  // nothing about the people is kept on the server
  const everything = JSON.stringify(await (await call('GET', '/api/events')).json())
    + await readFile(path.join(dataDir, 'events.json'), 'utf8');
  assert.equal(everything.includes('mario@esempio.it'), false);
  assert.equal(everything.includes('Mario Rossi'), false);
  assert.deepEqual((await readdir(path.join(dataDir, 'mail', 'festa'))).sort(), ['images', 'template.html']);
});

test('sending: checks and errors', async (t) => {
  const {
    call, json, smtp, cardUrl,
  } = await setup(t);
  const ok = {
    to: 'a@b.it', subject: 'Prova', userid: 'Mario Rossi', link: LINK, card: cardUrl,
  };
  assert.equal((await json('POST', '/festa/mail', ok)).status, 409, 'no template yet');
  const form = new FormData();
  form.append('file', new Blob(['<p>Ciao {userid} {name}</p>'], { type: 'text/html' }), 'm.html');
  const imported = await (await call('POST', '/api/events/festa/mail-template', { body: form })).json();
  assert.deepEqual(imported.unused, ['card', 'link'], 'the admin warns about what the template does not use');
  assert.equal((await json('POST', '/festa/mail', ok)).status, 409, 'no account yet');
  await json('PUT', '/api/mail/config', account(smtp));
  assert.equal((await json('POST', '/festa/mail', { ...ok, to: undefined })).status, 400, 'recipient required');
  assert.equal((await json('POST', '/festa/mail', { ...ok, to: 'non-una-mail' })).status, 400);
  assert.match((await (await json('POST', '/festa/mail', { ...ok, subject: ' ' })).json()).error, /subject/);
  assert.match((await (await json('POST', '/festa/mail', { ...ok, userid: ' ' })).json()).error, /userid/);
  assert.match((await (await json('POST', '/festa/mail', { ...ok, link: undefined })).json()).error, /link/);
  assert.equal((await json('POST', '/festa/mail', { ...ok, link: 'javascript:alert(1)' })).status, 400);
  assert.match((await (await json('POST', '/festa/mail', { ...ok, card: undefined })).json()).error, /card/);
  assert.equal((await json('POST', '/festa/mail', { ...ok, card: `${cardUrl}.nope` })).status, 502, 'card URL not found');
  assert.equal((await json('POST', '/festa/mail', ok, { key: 'no' })).status, 401);
  const partial = await (await json('POST', '/festa/mail', ok)).json();
  assert.deepEqual(partial.missing, ['name'], 'sent anyway, reports what was empty');
  assert.match(smtp.messages.at(-1).raw, /filename=card-Mario-Rossi\.jpg/, 'attached even if the template does not show it');
  assert.doesNotMatch(smtp.messages.at(-1).raw, /Content-ID: <card\./);
  const refused = await json('POST', '/festa/mail', { ...ok, to: 'rifiuta@b.it' });
  assert.equal(refused.status, 502);
  assert.match((await refused.json()).error, /Invio non riuscito/);
  // a file that is not an image is refused
  const notImage = withCard({
    to: 'c@d.it', subject: 'Prova', userid: 'Anna', link: LINK,
  });
  notImage.append('card', new Blob(['ciao'], { type: 'text/plain' }), 'card.txt');
  assert.equal((await call('POST', '/festa/mail', { body: notImage })).status, 415);

  await json('PATCH', '/api/events/festa', { active: false });
  assert.equal((await json('POST', '/festa/mail', ok)).status, 409, 'event off');
  assert.equal((await call('DELETE', '/api/events/festa/mail-template')).status, 204);
  const [event] = await (await call('GET', '/api/events')).json();
  assert.equal(event.mailTemplate, null);
  assert.ok(!existsSync(path.join(os.tmpdir(), 'never')));
});
