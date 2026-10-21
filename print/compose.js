// Merges a photo into the PSD template, in place of the photo layer (named «card» or «FOTO», see
// PHOTO_LAYERS). The photo fills that layer's box (cropped to fit, keeping the most interesting part)
// and takes its layer mask.
//
// Two ways to draw the rest of the template:
// - composite: when the photo layer is hidden and nothing visible lies below it, the flattened image
//   Photoshop saves in the PSD is exactly «the template without the photo», with its transparency.
//   It goes over the photo as it is: gradients, effects and blend modes are as in Photoshop.
// - layers: otherwise the visible layers are drawn one by one in their order (only normal blending,
//   no effects, no adjustment layers: what is missing is listed in `warnings`).
//
// Text layers named like {name} or {total} are placeholders: they are drawn again with the values
// of the call (compose(photo, template, { name: 'MARIO', total: '87' })), with the layer's font,
// size, colour, tracking, alignment and rotation. The fonts come from the «fonts» folder next to
// the PSD (see fonts.js). In composite mode the placeholder layers must be hidden in the PSD,
// otherwise their sample text («NAME», «01») is already in the composite.
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { initializeCanvas, readPsd } from 'ag-psd';
import { createCanvas } from '@napi-rs/canvas';
import { FALLBACK_FONT, loadFonts } from './fonts.js';

export const PHOTO_LAYERS = ['card', 'foto'];
const PLACEHOLDER = /^\{\s*([\w-]+)\s*\}$/;

// pixels are read as plain RGBA arrays (useImageData), so no real canvas is needed in Node
initializeCanvas(
  () => { throw new Error('Il template usa una funzione del PSD che richiede un canvas.'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
);

const toBuffer = (pixels) => Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);

function bounds(layer) {
  if (layer.right > layer.left && layer.bottom > layer.top) {
    return { left: layer.left, top: layer.top, right: layer.right, bottom: layer.bottom };
  }
  // a group: the union of its children
  const inner = (layer.children || []).map(bounds).filter(Boolean);
  if (!inner.length) return null;
  return {
    left: Math.min(...inner.map((b) => b.left)),
    top: Math.min(...inner.map((b) => b.top)),
    right: Math.max(...inner.map((b) => b.right)),
    bottom: Math.max(...inner.map((b) => b.bottom)),
  };
}

function layerWarnings(layer, name) {
  const warnings = [];
  if (layer.adjustment) warnings.push(`livello di regolazione «${name}» ignorato`);
  if (layer.blendMode && !['normal', 'pass through'].includes(layer.blendMode)) {
    warnings.push(`livello «${name}»: metodo di fusione «${layer.blendMode}» reso come normale`);
  }
  if (layer.effects && Object.keys(layer.effects).some((k) => k !== 'scale' && k !== 'disabled')) {
    warnings.push(`livello «${name}»: effetti (ombre, bagliori...) non riprodotti, rasterizzali nel PSD`);
  }
  if (layer.clipping) warnings.push(`livello «${name}»: maschera di ritaglio ignorata`);
  if (!layer.imageData && !layer.children && !layer.adjustment) warnings.push(`livello «${name}» senza pixel (riempimento?) ignorato`);
  return warnings;
}

/**
 * Reads the template: { width, height, dpi, mode, layers, photoBox, photoMask, texts, warnings }.
 * options.photoLayers: names the photo layer may have (case-insensitive), first match wins.
 * options.fontsDir: where the fonts of the texts are (default: «fonts» next to the PSD).
 */
export async function loadTemplate(file, { photoLayers = PHOTO_LAYERS, fontsDir } = {}) {
  const psd = readPsd(await readFile(file), { useImageData: true, skipThumbnail: true });
  const canvas = { width: psd.width, height: psd.height };
  const wanted = photoLayers.map((name) => name.trim().toLowerCase());

  // all layers bottom to top, with the visibility and opacity they get from their groups
  const flat = [];
  (function walk(list, visible, groupOpacity) {
    for (const layer of list || []) {
      const shown = visible && !layer.hidden;
      const opacity = groupOpacity * (layer.opacity ?? 1);
      const name = (layer.name || '').trim();
      flat.push({
        layer, name, shown, opacity,
      });
      if (layer.children) walk(layer.children, shown, opacity);
    }
  }(psd.children, true, 1));

  const photoIndex = wanted.map((w) => flat.findIndex((f) => f.name.toLowerCase() === w)).find((i) => i !== -1) ?? -1;
  const warnings = [];
  let photoBox;
  let photoMask = null;
  if (photoIndex === -1) {
    warnings.push(`nessun livello ${photoLayers.join(' / ')}: la foto riempie tutto il foglio, sotto il template`);
    photoBox = { left: 0, top: 0, width: canvas.width, height: canvas.height };
  } else {
    const { layer, name } = flat[photoIndex];
    const box = bounds(layer);
    if (!box) throw new Error(`Il livello «${name}» del template è vuoto: disegnaci il riquadro della foto.`);
    // only the part of the box inside the sheet: the whole photo stays visible
    const left = Math.max(0, box.left);
    const top = Math.max(0, box.top);
    photoBox = {
      left, top, width: Math.min(canvas.width, box.right) - left, height: Math.min(canvas.height, box.bottom) - top,
    };
    const { mask } = layer;
    if (mask?.imageData && !mask.disabled) {
      photoMask = {
        left: mask.left, top: mask.top, width: mask.imageData.width, height: mask.imageData.height,
        data: toBuffer(mask.imageData.data), outside: mask.defaultColor ?? 0,
      };
    }
  }

  const isPlaceholder = (f) => f.layer.text && PLACEHOLDER.test(f.name);
  const photo = photoIndex === -1 ? null : flat[photoIndex];
  const nothingBelow = flat.slice(0, Math.max(0, photoIndex)).every((f) => !f.shown || f.layer.children);
  let mode;
  let layers;
  if (psd.imageData && (!photo || !photo.shown) && nothingBelow) {
    mode = 'composite';
    layers = [{ photo: true }, {
      name: 'composita', left: 0, top: 0, imageData: psd.imageData, opacity: 1,
    }];
  } else {
    mode = 'layers';
    layers = [];
    if (!photo) layers.push({ photo: true });
    flat.forEach((f, index) => {
      if (index === photoIndex) {
        layers.push({ photo: true });
        return;
      }
      if (!f.shown || f.layer.children || isPlaceholder(f)) return;
      warnings.push(...layerWarnings(f.layer, f.name));
      const data = f.layer.imageData;
      if (!data || !data.width || !data.height) return;
      layers.push({
        name: f.name, left: f.layer.left, top: f.layer.top, imageData: data, opacity: f.opacity,
      });
    });
  }
  const fonts = await loadFonts(fontsDir || path.join(path.dirname(file), 'fonts'));
  const texts = flat.filter(isPlaceholder).map((f) => textSpec(f, fonts, canvas, warnings));
  const missing = new Map();
  texts.filter((t) => !t.fontFound).forEach((t) => missing.set(t.fontName, [...(missing.get(t.fontName) || []), t.layerName]));
  missing.forEach((layers, font) => {
    warnings.push(`font «${font}» mancante (${layers.join(', ')}): caricalo con «Aggiungi font» nell'admin, oppure metti il file .otf/.ttf nella cartella fonts accanto al PSD. Intanto si usa ${FALLBACK_FONT}`);
  });
  if (mode === 'composite') {
    const baked = texts.filter((t) => t.baked).map((t) => t.layerName);
    if (baked.length) {
      warnings.push(`i livelli ${baked.join(', ')} sono visibili nel PSD: il loro testo di esempio è già nella composita e resta sotto quello vero. Nascondili in Photoshop e salva di nuovo il PSD`);
    }
  }
  const dpi = Math.round(psd.imageResources?.resolutionInfo?.horizontalResolution || 300);
  return {
    ...canvas, dpi, mode, layers, photoBox, photoMask, photoLayer: photo?.name || null, texts, fonts: fonts.files, warnings,
  };
}

// --- placeholder texts ------------------------------------------------------------------------
const ALIGN = {
  left: 'left',
  right: 'right',
  center: 'center',
  justifyLeft: 'left',
  justifyRight: 'right',
  justifyCenter: 'center',
  justifyAll: 'left',
};

const cssColor = (c) => (c && 'r' in c ? `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})` : '#ffffff');

/** Draws `value` as the placeholder would be: k = { scale, dx, dy } corrections, fit shrinks it. */
function drawText(ctx, spec, value, k = { scale: 1, dx: 0, dy: 0 }, fit = 1) {
  const [a, b, c, d, tx, ty] = spec.transform;
  const size = spec.fontSize * k.scale * fit;
  ctx.save();
  ctx.setTransform(a, b, c, d, tx + k.dx, ty + k.dy);
  ctx.font = `${spec.italic ? 'italic ' : ''}${size}px "${spec.family}"`;
  ctx.letterSpacing = `${(spec.tracking / 1000) * size}px`;
  ctx.fillStyle = spec.color;
  ctx.textAlign = spec.align;
  ctx.textBaseline = 'alphabetic';
  let x = 0;
  let y = 0;
  if (spec.box) {
    // box text: (0, 0) is the box corner and the first line hangs from its top
    const [left, top, right] = spec.box;
    if (spec.align === 'right') x = right;
    else if (spec.align === 'center') x = (left + right) / 2;
    else x = left;
    y = top + size * 0.8;
  }
  ctx.fillText(value, x, y);
  const width = ctx.measureText(value).width * Math.hypot(a, b);
  ctx.restore();
  return width;
}

/** Bounding box of the ink of a drawing on a sheet-sized canvas; null if nothing was drawn. */
function ink(canvas, draw) {
  const surface = createCanvas(canvas.width, canvas.height);
  const ctx = surface.getContext('2d');
  draw(ctx);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      if (data[(y * canvas.width + x) * 4 + 3] > 64) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  return right < 0 ? null : {
    left, top, right: right + 1, bottom: bottom + 1,
  };
}

/**
 * What is needed to draw a placeholder. Its sample text is drawn once and compared with the pixels
 * Photoshop saved for the layer: the difference (size and position) is corrected for every value.
 */
function textSpec(f, fonts, canvas, warnings) {
  const t = f.layer.text;
  const style = t.style || {};
  const fontName = style.font?.name || '';
  let family = fonts.lookup(fontName);
  const fontFound = Boolean(family);
  if (!family) family = FALLBACK_FONT; // reported once per font by loadTemplate
  const spec = {
    key: PLACEHOLDER.exec(f.name)[1].toLowerCase(),
    layerName: f.name,
    baked: f.shown,
    sample: t.text || '',
    fontName,
    family,
    fontFound,
    italic: family === FALLBACK_FONT && /ita|obl/i.test(fontName),
    fontSize: style.fontSize || 12,
    color: cssColor(style.fillColor),
    tracking: style.tracking || 0,
    align: ALIGN[t.paragraphStyle?.justification] || 'left',
    transform: t.transform || [1, 0, 0, 1, 0, 0],
    box: t.shapeType === 'box' && t.boxBounds ? t.boxBounds : null,
    k: { scale: 1, dx: 0, dy: 0 },
  };
  const target = {
    left: f.layer.left, top: f.layer.top, right: f.layer.right, bottom: f.layer.bottom,
  };
  spec.maxWidth = (target.right - target.left) * (spec.box ? 2.5 : 1.6);
  const first = spec.sample && target.right > target.left ? ink(canvas, (ctx) => drawText(ctx, spec, spec.sample)) : null;
  if (first) {
    const scale = Math.min(2, Math.max(0.5, (target.bottom - target.top) / (first.bottom - first.top)));
    const second = ink(canvas, (ctx) => drawText(ctx, spec, spec.sample, { scale, dx: 0, dy: 0 })) || first;
    let dx = target.left - second.left;
    if (spec.align === 'right') dx = target.right - second.right;
    if (spec.align === 'center') dx = (target.left + target.right - second.left - second.right) / 2;
    spec.k = { scale, dx, dy: target.bottom - second.bottom };
  }
  return spec;
}

/** The placeholder texts with their values, as one sheet-sized RGBA layer; null if none. */
function textLayer(template, values) {
  const specs = (template.texts || []).filter((spec) => values[spec.key] !== undefined && values[spec.key] !== null);
  if (!specs.length) return null;
  const surface = createCanvas(template.width, template.height);
  const ctx = surface.getContext('2d');
  const measure = createCanvas(1, 1).getContext('2d');
  specs.forEach((spec) => {
    const value = String(values[spec.key]);
    const width = drawText(measure, spec, value, spec.k);
    drawText(ctx, spec, value, spec.k, width > spec.maxWidth ? spec.maxWidth / width : 1);
  });
  return Buffer.from(ctx.getImageData(0, 0, template.width, template.height).data.buffer);
}

/** A raw RGBA overlay for sharp, cut to the canvas; null if it falls outside. */
async function overlay(data, width, height, left, top, canvas) {
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  const right = Math.min(canvas.width, left + width);
  const bottom = Math.min(canvas.height, top + height);
  if (right <= x || bottom <= y) return null;
  const raw = { width, height, channels: 4 };
  let input = data;
  if (x !== left || y !== top || right - x !== width || bottom - y !== height) {
    input = await sharp(data, { raw })
      .extract({ left: x - left, top: y - top, width: right - x, height: bottom - y })
      .raw()
      .toBuffer();
  }
  return {
    input, raw: { width: right - x, height: bottom - y, channels: 4 }, left: x, top: y,
  };
}

function withOpacity(pixels, opacity) {
  const data = toBuffer(pixels);
  if (opacity >= 1) return data;
  const copy = Buffer.from(data);
  for (let i = 3; i < copy.length; i += 4) copy[i] = Math.round(copy[i] * opacity);
  return copy;
}

/** Multiplies the photo's alpha by the layer mask (grey level in the red channel). */
function applyMask(pixels, box, mask) {
  for (let y = 0; y < box.height; y += 1) {
    const my = box.top + y - mask.top;
    for (let x = 0; x < box.width; x += 1) {
      const mx = box.left + x - mask.left;
      const inside = mx >= 0 && my >= 0 && mx < mask.width && my < mask.height;
      const value = inside ? mask.data[(my * mask.width + mx) * 4] : mask.outside;
      const i = (y * box.width + x) * 4 + 3;
      pixels[i] = Math.round((pixels[i] * value) / 255);
    }
  }
}

/**
 * Returns the finished picture as JPEG, at the template's size and resolution.
 * `values`: text for each placeholder, by name without braces ({ name: 'MARIO', total: '87' }).
 */
export async function compose(photo, template, values = {}) {
  const canvas = { width: template.width, height: template.height };
  const overlays = [];
  for (const layer of template.layers) {
    let piece;
    if (layer.photo) {
      const box = template.photoBox;
      const pixels = await sharp(photo)
        .rotate() // honour the camera orientation
        .resize(box.width, box.height, { fit: 'cover', position: sharp.strategy.attention })
        .ensureAlpha()
        .raw()
        .toBuffer();
      if (template.photoMask) applyMask(pixels, box, template.photoMask);
      piece = await overlay(pixels, box.width, box.height, box.left, box.top, canvas);
    } else {
      const { imageData, opacity } = layer;
      piece = await overlay(withOpacity(imageData.data, opacity), imageData.width, imageData.height, layer.left, layer.top, canvas);
    }
    if (piece) overlays.push(piece);
  }
  const texts = textLayer(template, values);
  if (texts) overlays.push({ input: texts, raw: { ...canvas, channels: 4 }, left: 0, top: 0 });
  return sharp({ create: { ...canvas, channels: 4, background: '#ffffff' } })
    .composite(overlays)
    .flatten({ background: '#ffffff' })
    .withMetadata({ density: template.dpi })
    .jpeg({ quality: 95 })
    .toBuffer();
}
