// Test PSD template and photo, shared by compose and print tests.
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { writePsdBuffer } from 'ag-psd';

export const W = 300;
export const H = 200;
export const HOLE = {
  left: 50, top: 50, right: 250, bottom: 150,
};

function solid(width, height, [r, g, b, a], keep = () => true) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const on = keep(x, y);
      data.set(on ? [r, g, b, a] : [0, 0, 0, 0], i);
    }
  }
  return { width, height, data };
}

const inHole = (x, y) => x >= HOLE.left && x < HOLE.right && y >= HOLE.top && y < HOLE.bottom;

/** Red background, FOTO box, green frame on top with a transparent hole over FOTO. */
export async function writeTemplate(dir, { withPhotoLayer = true } = {}) {
  const children = [
    { name: 'Sfondo', left: 0, top: 0, imageData: solid(W, H, [255, 0, 0, 255]) },
    ...(withPhotoLayer ? [{
      name: 'FOTO', left: HOLE.left, top: HOLE.top, imageData: solid(200, 100, [128, 128, 128, 255]),
    }] : []),
    {
      name: 'Cornice', left: 0, top: 0, imageData: solid(W, H, [0, 255, 0, 255], (x, y) => !inHole(x, y)),
    },
  ];
  const psd = {
    width: W,
    height: H,
    children,
    imageData: solid(W, H, [255, 0, 0, 255]),
    imageResources: {
      resolutionInfo: {
        horizontalResolution: 300, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches',
        verticalResolution: 300, verticalResolutionUnit: 'PPI', heightUnit: 'Inches',
      },
    },
  };
  const file = path.join(dir, 'template.psd');
  await writeFile(file, writePsdBuffer(psd, { generateThumbnail: false }));
  return file;
}

export const bluePhoto = () => sharp({
  create: {
    width: 400, height: 400, channels: 3, background: '#0000ff',
  },
}).png().toBuffer();

/**
 * Like the real template: a hidden «card» layer (going past the left edge, with a mask hiding its
 * right part from x 220) under a composite that is green with a transparent hole.
 */
export async function writeCardTemplate(dir) {
  const card = solid(300, 100, [128, 128, 128, 255]);
  const mask = solid(W, H, [0, 0, 0, 255], (x) => x < 220);
  for (let i = 0; i < mask.data.length; i += 4) {
    const v = mask.data[i + 3] ? 255 : 0;
    mask.data.set([v, v, v, 255], i);
  }
  const psd = {
    width: W,
    height: H,
    children: [
      {
        name: 'card', hidden: true, left: -50, top: HOLE.top, imageData: card,
        mask: { left: 0, top: 0, imageData: mask, defaultColor: 0 },
      },
      { name: 'Cornice', left: 0, top: 0, imageData: solid(W, H, [0, 255, 0, 255], (x, y) => !inHole(x, y)) },
    ],
    imageData: solid(W, H, [0, 255, 0, 255], (x, y) => !inHole(x, y)),
  };
  const file = path.join(dir, 'card.psd');
  await writeFile(file, writePsdBuffer(psd, { generateThumbnail: false }));
  return file;
}

/**
 * A hidden {total} text placeholder («01», Impact, right aligned at x 250, baseline y 120) over a
 * plain composite; returns { file, bounds } with the ink box of the sample text.
 */
export async function writeTextTemplate(dir) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const surface = createCanvas(W, H);
  const ctx = surface.getContext('2d');
  ctx.font = '80px "Impact"';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'right';
  ctx.fillText('01', 250, 120);
  const { data } = ctx.getImageData(0, 0, W, H);
  let left = W; let top = H; let right = 0; let bottom = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (data[(y * W + x) * 4 + 3] > 64) {
        left = Math.min(left, x); right = Math.max(right, x + 1);
        top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
      }
    }
  }
  const pixels = new Uint8ClampedArray((right - left) * (bottom - top) * 4);
  for (let y = top; y < bottom; y += 1) {
    pixels.set(data.subarray((y * W + left) * 4, (y * W + right) * 4), (y - top) * (right - left) * 4);
  }
  const psd = {
    width: W,
    height: H,
    children: [
      { name: 'card', hidden: true, left: 0, top: 0, imageData: solid(W, H, [128, 128, 128, 255]) },
      {
        name: '{total}',
        hidden: true,
        left,
        top,
        imageData: { width: right - left, height: bottom - top, data: pixels },
        text: {
          text: '01',
          transform: [1, 0, 0, 1, 250, 120],
          style: { font: { name: 'Impact' }, fontSize: 80, fillColor: { r: 255, g: 255, b: 255 } },
          paragraphStyle: { justification: 'right' },
        },
      },
    ],
    imageData: solid(W, H, [0, 0, 0, 255], (x, y) => y < 20),
  };
  const file = path.join(dir, 'testi.psd');
  await writeFile(file, writePsdBuffer(psd, { generateThumbnail: false }));
  return {
    file,
    bounds: {
      left, top, right, bottom,
    },
  };
}
