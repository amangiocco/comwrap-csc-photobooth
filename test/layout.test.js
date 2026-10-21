import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { layoutSheet } from '../print/layout.js';
import { normalizePrintSettings, DEFAULT_PRINT_SETTINGS } from '../server/print-settings.js';

// a 2:3 picture like the template (600×900 px at 200 dpi), blue
const picture = (width = 600, height = 900) => sharp({
  create: {
    width, height, channels: 3, background: '#0000ff',
  },
}).withMetadata({ density: 200 }).jpeg().toBuffer();

async function pixel(jpeg, x, y) {
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
const isBlue = (p) => p[2] > 200 && p[0] < 60;
const isWhite = (p) => p.every((v) => v > 230);
const px = (mm) => Math.round((mm / 25.4) * 300);

test('default: classic 10×15 photo paper, borderless, at 300 dpi', async () => {
  const sheet = await layoutSheet(await picture(), DEFAULT_PRINT_SETTINGS);
  const meta = await sharp(sheet.jpeg).metadata();
  assert.deepEqual([meta.width, meta.height, meta.density], [1200, 1800, 300]);
  assert.deepEqual([sheet.widthMm, sheet.heightMm], [101.6, 152.4]);
  assert.ok(isBlue(await pixel(sheet.jpeg, 2, 2)), 'picture up to the edge');
  assert.equal(sheet.layout.paper, 'Foto 10×15 cm (4×6″)');
  assert.equal(sheet.layout.margins, 'Nessuno');
});

test('uniform border and margins leave white paper around the picture', async () => {
  const settings = normalizePrintSettings({
    border: 'uniform', borderMm: 5, margins: { top: 3, right: 3, bottom: 3, left: 3 },
  });
  const sheet = await layoutSheet(await picture(), settings);
  assert.ok(isWhite(await pixel(sheet.jpeg, px(2), px(2))), 'margin');
  assert.ok(isWhite(await pixel(sheet.jpeg, px(6), px(60))), 'border');
  assert.ok(isBlue(await pixel(sheet.jpeg, 600, 900)), 'picture in the middle');
  assert.match(sheet.layout.border, /Bordo uniforme, 5 mm/);
  assert.equal(sheet.layout.margins, '3 mm');
});

test('instant style: taller band at the bottom, in the border colour', async () => {
  const settings = normalizePrintSettings({ border: 'instant', borderMm: 5, borderColor: '#ff0000' });
  const sheet = await layoutSheet(await picture(), settings);
  const red = (p) => p[0] > 200 && p[2] < 60;
  // bottom band 17.5 mm: red at 12 mm from the bottom, while the side border is only 5 mm
  assert.ok(red(await pixel(sheet.jpeg, 600, 1800 - px(12))), 'bottom band');
  assert.ok(isBlue(await pixel(sheet.jpeg, px(8), 900)), 'side border is thin');
});

test('orientation, fit and paper sizes', async () => {
  const landscape = await layoutSheet(await picture(), normalizePrintSettings({ orientation: 'landscape' }));
  assert.deepEqual([landscape.widthMm, landscape.heightMm], [152.4, 101.6]);

  // 13×18 is less tall than 2:3: whole picture leaves white at the sides, fill does not
  const whole = await layoutSheet(await picture(), normalizePrintSettings({ paper: '13x18', fit: 'contain' }));
  assert.ok(isWhite(await pixel(whole.jpeg, 3, 1000)));
  const filled = await layoutSheet(await picture(), normalizePrintSettings({ paper: '13x18', fit: 'cover' }));
  assert.ok(isBlue(await pixel(filled.jpeg, 3, 1000)));

  const custom = await layoutSheet(await picture(), normalizePrintSettings({ paper: 'custom', widthMm: 50, heightMm: 80 }));
  assert.deepEqual([custom.widthMm, custom.heightMm], [50, 80]);
  const same = await layoutSheet(await picture(), normalizePrintSettings({ paper: 'template' }));
  assert.deepEqual([same.widthMm, same.heightMm], [76.2, 114.3]);
});

test('settings are checked; margins that leave no room are an error', async () => {
  assert.throws(() => normalizePrintSettings({ paper: 'A9', margins: { top: 90 } }, { strict: true }), { status: 400 });
  assert.equal(normalizePrintSettings({ paper: 'A9' }).paper, '10x15', 'lenient: back to the default');
  const huge = normalizePrintSettings({ margins: { left: 50, right: 50 } });
  await assert.rejects(layoutSheet(await picture(), huge), /troppo grandi/);
});
