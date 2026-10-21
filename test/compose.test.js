import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { compose, loadTemplate } from '../print/compose.js';
import {
  W, H, writeTemplate, writeCardTemplate, writeTextTemplate, bluePhoto,
} from './helpers/template.js';

async function pixel(jpeg, x, y) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

const near = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) < 40);

test('the photo fills the FOTO box, the layers above cover it', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-compose-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const template = await loadTemplate(await writeTemplate(dir));
  assert.deepEqual(template.photoBox, {
    left: 50, top: 50, width: 200, height: 100,
  });
  assert.equal(template.dpi, 300);
  assert.deepEqual(template.warnings, []);

  const result = await compose(await bluePhoto(), template);
  const meta = await sharp(result).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, W);
  assert.equal(meta.height, H);
  assert.equal(meta.density, 300);
  assert.ok(near(await pixel(result, 150, 100), [0, 0, 255]), 'photo inside the hole');
  assert.ok(near(await pixel(result, 10, 10), [0, 255, 0]), 'frame over everything else');
});

test('without a FOTO layer the photo goes under the whole template', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-compose-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const template = await loadTemplate(await writeTemplate(dir, { withPhotoLayer: false }));
  assert.match(template.warnings[0], /nessun livello card \/ foto/);
  const result = await compose(await bluePhoto(), template);
  // the red background is above the photo now, and fully opaque
  assert.ok(near(await pixel(result, 150, 100), [255, 0, 0]));
});

test('a hidden photo layer with nothing below: photo under the PSD composite, with its mask', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-compose-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await writeCardTemplate(dir);
  const template = await loadTemplate(file);
  assert.equal(template.mode, 'composite');
  assert.equal(template.photoLayer, 'card');
  // the layer goes past the sheet on the left: only the part inside is used
  assert.deepEqual(template.photoBox, {
    left: 0, top: 50, width: 250, height: 100,
  });
  const result = await compose(await bluePhoto(), template);
  assert.ok(near(await pixel(result, 150, 100), [0, 0, 255]), 'photo through the hole of the composite');
  assert.ok(near(await pixel(result, 10, 10), [0, 255, 0]), 'composite over the photo');
  assert.ok(near(await pixel(result, 230, 100), [255, 255, 255]), 'masked out: white sheet');
});

test('placeholder texts are drawn with the values, where the sample text was', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'photobooth-compose-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { file, bounds } = await writeTextTemplate(dir);
  const template = await loadTemplate(file);
  assert.deepEqual(template.texts.map((s) => [s.key, s.family, s.align]), [['total', 'Impact', 'right']]);
  assert.deepEqual(template.warnings, [], 'font found, layer hidden: nothing to report');
  const k = template.texts[0].k;
  assert.ok(Math.abs(k.scale - 1) < 0.05 && Math.abs(k.dx) <= 2 && Math.abs(k.dy) <= 2, JSON.stringify(k));

  const result = await compose(await bluePhoto(), template, { total: '87' });
  // white ink of «87»: right aligned and on the baseline of the sample «01»
  const { data, info } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
  let left = info.width; let right = 0; let bottom = 0;
  for (let y = 25; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const i = (y * info.width + x) * info.channels;
      if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) {
        left = Math.min(left, x); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
      }
    }
  }
  assert.ok(Math.abs(right - bounds.right) <= 3, `right edge ${right} vs ${bounds.right}`);
  assert.ok(Math.abs(bottom - bounds.bottom) <= 3, `baseline ${bottom} vs ${bounds.bottom}`);
  assert.ok(left > 100 && left < bounds.right - 40, 'two digits wide');

  // without a value the placeholder stays empty
  const empty = await compose(await bluePhoto(), template, {});
  assert.ok(near(await pixel(empty, 220, 100), [0, 0, 255]));
});
