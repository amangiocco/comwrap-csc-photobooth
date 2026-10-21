import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createStore, toSlug } from '../server/store.js';

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('toSlug strips accents and symbols', () => {
  assert.equal(toSlug('  Festa Città 2026!  '), 'festa-citta-2026');
  assert.equal(toSlug('---'), '');
});

test('create, update and persist events', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  const event = await store.create({ name: 'Festa Aziendale' });
  assert.equal(event.slug, 'festa-aziendale');
  assert.equal(event.active, false);
  await assert.rejects(store.create({ name: 'Festa aziendale' }), { status: 409 });
  await assert.rejects(store.create({ name: '' }), { status: 400 });
  await assert.rejects(store.create({ name: 'x', slug: '!!!' }), { status: 400 });

  await store.update('festa-aziendale', { active: true, name: '  Nuovo nome ' });
  const saved = JSON.parse(await readFile(path.join(dir, 'events.json'), 'utf8'));
  assert.equal(saved.events[0].active, true);
  assert.equal(saved.events[0].name, 'Nuovo nome');

  const reloaded = createStore(dir);
  assert.equal((await reloaded.get('festa-aziendale')).active, true);
  await assert.rejects(reloaded.get('nope'), { status: 404 });
});

test('videos are added and removed together with their file', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  await store.create({ name: 'Evento', slug: 'evento' });
  const file = path.join(store.mediaDir('evento'), 'a.mp4');
  await writeFile(file, 'x');
  const video = await store.addVideo('evento', { file: 'a.mp4', title: 'A' });
  assert.ok(video.id);
  assert.equal((await store.get('evento')).videos.length, 1);

  await store.removeVideo('evento', video.id);
  assert.equal((await store.get('evento')).videos.length, 0);
  assert.equal(existsSync(file), false);
  await assert.rejects(store.removeVideo('evento', video.id), { status: 404 });

  await store.remove('evento');
  assert.equal(existsSync(store.mediaDir('evento')), false);
  assert.deepEqual(await store.list(), []);
});

test('concurrent additions are all persisted', async (t) => {
  const dir = await tempDir(t);
  const store = createStore(dir);
  await store.create({ name: 'Evento', slug: 'evento' });
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.addVideo('evento', { file: `${i}.mp4` })));
  const saved = JSON.parse(await readFile(path.join(dir, 'events.json'), 'utf8'));
  assert.equal(saved.events[0].videos.length, 20);
});
