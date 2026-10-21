import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createApp } from '../server/app.js';
import { ADMIN_HASH, adminCookie } from './helpers/admin.js';
import { createLogger, formatEntry } from '../server/logs.js';

const KEY = 'k';
const HOUR = 60 * 60 * 1000;

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-logs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('entries are kept for the retention only, in memory and on disk', async (t) => {
  const dir = await tempDir(t);
  let clock = new Date(2026, 9, 1, 10, 0).getTime();
  const logger = createLogger({ dir, retentionDays: 2, now: () => clock });
  t.after(() => logger.close());
  logger.info('attivita', 'vecchia');
  clock += 30 * HOUR;
  logger.warn('http', 'recente', { event: 'festa' });
  assert.deepEqual(logger.query().entries.map((e) => e.msg), ['recente', 'vecchia']);

  clock += 20 * HOUR; // 50 h after the first entry
  logger.prune();
  assert.deepEqual(logger.query().entries.map((e) => e.msg), ['recente']);
  // 1 Oct ended more than 2 days ago only on 4 Oct: its file is still there on 3 Oct
  assert.ok((await readdir(dir)).includes('photobooth-2026-10-01.log'));
  clock = new Date(2026, 9, 4, 1, 0).getTime();
  logger.prune();
  assert.deepEqual(await readdir(dir), ['photobooth-2026-10-02.log']);

  // after a restart the entries come back from the files
  const again = createLogger({ dir, retentionDays: 2, now: () => clock });
  t.after(() => again.close());
  assert.deepEqual(again.query().entries.map((e) => e.msg), ['recente']);
});

test('filters, paging and masked email addresses', async (t) => {
  const logger = createLogger({ retentionDays: 2 });
  t.after(() => logger.close());
  logger.info('http', 'Video da n8n', {
    event: 'festa', method: 'POST', path: '/festa/wall', status: 201, ms: 5,
  });
  logger.error('stampa', 'Stampa non riuscita');
  logger.warn('attivita', 'Scritto a mario.rossi@esempio.it', { event: 'altra' });
  assert.equal(logger.query({ level: 'warn' }).entries.length, 2);
  assert.deepEqual(logger.query({ type: 'stampa' }).entries.map((e) => e.msg), ['Stampa non riuscita']);
  assert.equal(logger.query({ event: 'festa' }).entries.length, 1);
  assert.equal(logger.query({ q: '/FESTA/WALL 201' }).entries.length, 1);
  assert.equal(logger.query().entries[0].msg, 'Scritto a [email]');
  const first = logger.query({ limit: 2 });
  assert.equal(first.more, true);
  assert.deepEqual(logger.query({ before: first.entries[1].id }).entries.map((e) => e.type), ['http']);
  assert.equal(logger.query({ after: first.entries[1].id }).entries.length, 1);
  assert.match(formatEntry(first.entries[1]), /ERROR stampa {3}Stampa non riuscita$/);
});

test('HTTP calls are logged with their reason, polling reads are not', async (t) => {
  const dataDir = path.join(await tempDir(t), 'data');
  const { app, hub, logger } = createApp({ dataDir, apiKey: KEY, adminPasswordHash: ADMIN_HASH });
  const server = http.createServer(app);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    hub.closeAll();
    logger.close();
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = await adminCookie(base);
  const call = (method, url, body) => fetch(`${base}${url}`, {
    method,
    headers: { 'x-api-key': KEY, cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  assert.equal((await call('POST', '/api/events', { name: 'Festa', slug: 'festa' })).status, 201);
  await call('PATCH', '/api/events/festa', { active: false });
  assert.equal((await call('POST', '/festa/wall', { url: 'https://esempio.it/v.mp4' })).status, 409);
  await call('GET', '/api/events');
  await call('GET', '/api/events/festa/wall');
  assert.equal((await fetch(`${base}/api/logs`)).status, 401);

  const { entries, retentionDays } = await (await call('GET', '/api/logs')).json();
  assert.equal(retentionDays, 2);
  // the GET /api/logs itself is logged only after it answered
  const calls = entries.filter((e) => e.type === 'http').map((e) => `${e.method} ${e.path} ${e.status}`);
  assert.deepEqual(calls, ['GET /api/logs 401', 'POST /festa/wall 409', 'PATCH /api/events/festa 200', 'POST /api/events 201', 'POST /api/admin/login 200']);
  const refused = entries.find((e) => e.status === 409);
  assert.equal(refused.event, 'festa');
  assert.equal(refused.level, 'warn');
  assert.match(refused.msg, /^Video da n8n: L'evento «festa» è spento/);

  const download = await call('GET', '/api/logs/download?level=warn');
  assert.match(download.headers.get('content-disposition'), /attachment; filename="photobooth-log-\d{8}-\d{4}\.log"/);
  const text = await download.text();
  assert.match(text, /WARN {2}http {5}\[festa\] Video da n8n: .* POST \/festa\/wall 409 \d+ ms/);
  assert.ok(!text.includes('PATCH'));
  const jsonl = (await (await call('GET', '/api/logs/download?format=jsonl')).text()).trim().split('\n').map(JSON.parse);
  assert.equal(jsonl[0].path, '/api/admin/login');
  assert.equal(jsonl[0].msg, 'Accesso alla console');

  const files = await readdir(path.join(dataDir, 'logs'));
  assert.equal(files.length, 1);
  assert.match(await readFile(path.join(dataDir, 'logs', files[0]), 'utf8'), /"status":409/);
});

test('a broken line in a log file is skipped', async (t) => {
  const dir = await tempDir(t);
  const now = Date.now();
  const day = new Date(now);
  const name = `photobooth-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.log`;
  writeFileSync(path.join(dir, name), `${JSON.stringify({ time: now, level: 'info', type: 'sistema', msg: 'ok' })}\n{"time":`);
  const logger = createLogger({ dir });
  t.after(() => logger.close());
  assert.deepEqual(logger.query().entries.map((e) => e.msg), ['ok']);
  assert.ok(existsSync(path.join(dir, name)));
});
