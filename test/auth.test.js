import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApp } from '../server/app.js';
import { hashPassword, verifyPassword } from '../server/auth.js';
import { ADMIN_HASH, adminCookie } from './helpers/admin.js';

const KEY = 'chiave-n8n';

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-auth-'));
  const { app, hub, logger } = createApp({
    dataDir, apiKey: KEY, adminPasswordHash: ADMIN_HASH, ...options,
  });
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
  const call = (method, url, headers = {}, body) => fetch(base + url, {
    method,
    redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const login = (user, password, headers = {}) => call('POST', '/api/admin/login', headers, { user, password });
  return { base, call, login };
}

test('passwords are stored as a scrypt hash', () => {
  const hash = hashPassword('una password lunga');
  assert.match(hash, /^scrypt:[\w-]+:[\w-]+$/);
  assert.ok(!hash.includes('una password'));
  assert.ok(verifyPassword('una password lunga', hash));
  assert.ok(!verifyPassword('un\'altra', hash));
  assert.ok(!verifyPassword('una password lunga', 'non-un-hash'));
  assert.notEqual(hashPassword('x'), hashPassword('x'), 'a new salt every time');
});

test('the API key does n8n work, not the console settings', async (t) => {
  const { call } = await setup(t);
  const key = { 'x-api-key': KEY };
  assert.equal((await call('POST', '/api/events', key, { name: 'Festa', slug: 'festa' })).status, 201);
  assert.equal((await call('PATCH', '/api/events/festa', { authorization: `Bearer ${KEY}` }, { active: true })).status, 200);
  assert.equal((await call('GET', '/api/events', key)).status, 200);
  assert.equal((await call('GET', '/api/print/queue', key)).status, 200);
  assert.equal((await call('DELETE', '/api/events/festa/videos', key)).status, 200);
  for (const [method, url] of [
    ['GET', '/api/info'], ['GET', '/api/mail/config'], ['PUT', '/api/mail/config'], ['POST', '/api/mail/test'],
    ['GET', '/api/logs'], ['GET', '/api/logs/download'], ['DELETE', '/api/events/festa/template'],
    ['DELETE', '/api/events/festa/mail-template'], ['GET', '/api/admin/api-key'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await call(method, url, key)).status, 401, `${method} ${url}`);
  }
  assert.equal((await call('GET', '/api/events', { 'x-api-key': 'sbagliata' })).status, 401);
  assert.equal((await call('GET', '/api/events')).status, 401);
  // public, read-only
  assert.equal((await call('GET', '/api/events/festa/wall')).status, 200);
  assert.equal((await call('GET', '/api/events/festa/prints')).status, 200);
});

test('the console logs in with user and password and can do everything', async (t) => {
  const { base, call, login } = await setup(t);
  assert.equal((await call('GET', '/api/admin/session')).status, 401);
  assert.equal((await login('admin', 'sbagliata')).status, 401);
  assert.equal((await login('altro', 'password-di-prova')).status, 401);

  const response = await login('admin', 'password-di-prova');
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];

  assert.deepEqual(await (await call('GET', '/api/admin/session', { cookie })).json(), { user: 'admin' });
  assert.equal((await call('POST', '/api/events', { cookie }, { name: 'Festa', slug: 'festa' })).status, 201);
  assert.equal((await call('GET', '/api/info', { cookie })).status, 200);
  assert.equal((await call('GET', '/api/logs', { cookie })).status, 200);
  assert.deepEqual(await (await call('GET', '/api/admin/api-key', { cookie })).json(), { key: KEY });

  // a write sent by another site is refused even with the cookie
  assert.equal((await call('PATCH', '/api/events/festa', { cookie, origin: 'https://altro.example' }, { active: true })).status, 403);
  assert.equal((await call('PATCH', '/api/events/festa', { cookie, origin: base }, { active: true })).status, 200);

  // a wrong key is not saved by a valid cookie
  assert.equal((await call('GET', '/api/events', { cookie, 'x-api-key': 'sbagliata' })).status, 401);

  assert.equal((await call('POST', '/api/admin/logout', { cookie })).status, 204);
  assert.equal((await call('GET', '/api/events', { cookie })).status, 401);
  assert.ok(await adminCookie(base), 'a new login works');
});

test('too many wrong passwords block the login for a while', async (t) => {
  const { login } = await setup(t);
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await login('admin', `sbagliata-${i}`)).status, 401);
  }
  const blocked = await login('admin', 'password-di-prova');
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /Troppi tentativi/);
});

test('with HTTPS the console requires it, except from this PC', async (t) => {
  // a proxy in front (AWS): the client address and the protocol come from X-Forwarded-*
  const { call, login } = await setup(t, { trustProxy: true, https: { port: 443 } });
  const remote = { 'X-Forwarded-For': '10.21.0.7', 'X-Forwarded-Proto': 'http' };

  const page = await call('GET', '/admin', { ...remote, 'X-Forwarded-Host': 'photobooth.example' });
  assert.equal(page.status, 301);
  assert.equal(page.headers.get('location'), 'https://photobooth.example/admin');
  const refused = await login('admin', 'password-di-prova', remote);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /in chiaro/);
  // the API key and the wall keep working over http
  assert.equal((await call('GET', '/api/events', { ...remote, 'x-api-key': KEY })).status, 200);

  const secure = await login('admin', 'password-di-prova', { ...remote, 'X-Forwarded-Proto': 'https' });
  assert.equal(secure.status, 200);
  assert.match(secure.headers.get('set-cookie'), /; Secure/);

  // loopback over http: no network in between
  const local = await login('admin', 'password-di-prova');
  assert.equal(local.status, 200);
  assert.doesNotMatch(local.headers.get('set-cookie'), /Secure/);
});

test('without HTTPS nothing changes', async (t) => {
  const { call, login } = await setup(t, { trustProxy: true });
  const remote = { 'X-Forwarded-For': '10.21.0.7' };
  assert.equal((await call('GET', '/admin', remote)).status, 200);
  assert.equal((await login('admin', 'password-di-prova', remote)).status, 200);
});
