// Lays the composed picture out on the sheet of paper in use (server/print-settings.js): paper size
// and orientation, blank margins, a border (uniform, or instant-photo style with a taller bottom
// band) and how the picture fits (whole, or filling the space and cropping the edges).
import sharp from 'sharp';
import { DEFAULT_PRINT_SETTINGS, PAPERS, describePrintSettings, normalizePrintSettings } from '../server/print-settings.js';

export const SHEET_DPI = 300;
// instant-photo style: the bottom band is this many times the border
const INSTANT_BOTTOM = 3.5;

const toPx = (mm, dpi) => Math.round((mm / 25.4) * dpi);

/** Paper size in mm for these settings and this picture, already oriented. */
export function paperSize(settings, picture) {
  const pictureMm = {
    widthMm: (picture.width / (picture.density || SHEET_DPI)) * 25.4,
    heightMm: (picture.height / (picture.density || SHEET_DPI)) * 25.4,
  };
  const size = settings.paper === 'template' ? pictureMm : { widthMm: settings.widthMm, heightMm: settings.heightMm };
  let { widthMm, heightMm } = size;
  const pictureLandscape = picture.width > picture.height;
  const wantLandscape = settings.orientation === 'landscape'
    || (settings.orientation === 'auto' && pictureLandscape);
  if (wantLandscape !== widthMm > heightMm && widthMm !== heightMm) [widthMm, heightMm] = [heightMm, widthMm];
  return { widthMm: Math.round(widthMm * 10) / 10, heightMm: Math.round(heightMm * 10) / 10 };
}

/**
 * The sheet to print: { jpeg, widthMm, heightMm, layout } where `layout` describes it in words for
 * the print dialog. Throws if margins and border leave no room for the picture.
 */
export async function layoutSheet(picture, rawSettings = DEFAULT_PRINT_SETTINGS, { dpi = SHEET_DPI } = {}) {
  const settings = normalizePrintSettings(rawSettings);
  const meta = await sharp(picture).metadata();
  const { widthMm, heightMm } = paperSize(settings, meta);
  const sheet = { width: toPx(widthMm, dpi), height: toPx(heightMm, dpi) };
  const m = settings.margins;
  const area = {
    left: toPx(m.left, dpi),
    top: toPx(m.top, dpi),
    width: sheet.width - toPx(m.left, dpi) - toPx(m.right, dpi),
    height: sheet.height - toPx(m.top, dpi) - toPx(m.bottom, dpi),
  };
  const border = settings.border === 'none' ? 0 : toPx(settings.borderMm, dpi);
  const bottom = settings.border === 'instant' ? Math.round(border * INSTANT_BOTTOM) : border;
  const box = {
    left: area.left + border,
    top: area.top + border,
    width: area.width - 2 * border,
    height: area.height - border - bottom,
  };
  if (box.width < 50 || box.height < 50) {
    throw new Error('Margini e bordo sono troppo grandi per questo formato di carta: la foto non ci sta.');
  }

  const resized = await sharp(picture)
    .resize(box.width, box.height, { fit: settings.fit === 'cover' ? 'cover' : 'inside' })
    .toBuffer({ resolveWithObject: true });
  const overlays = [];
  if (border) {
    overlays.push({
      input: { create: { width: area.width, height: area.height, channels: 3, background: settings.borderColor } },
      left: area.left,
      top: area.top,
    });
  }
  // a whole picture narrower than its box sits in the middle of it
  overlays.push({
    input: resized.data,
    left: box.left + Math.floor((box.width - resized.info.width) / 2),
    top: box.top + Math.floor((box.height - resized.info.height) / 2),
  });
  const jpeg = await sharp({ create: { ...sheet, channels: 3, background: '#ffffff' } })
    .composite(overlays)
    .withMetadata({ density: dpi })
    .jpeg({ quality: 95 })
    .toBuffer();
  return {
    jpeg,
    widthMm,
    heightMm,
    layout: {
      ...describePrintSettings(settings),
      widthMm,
      heightMm,
      orientation: widthMm > heightMm ? 'Orizzontale' : 'Verticale',
    },
  };
}

export { PAPERS };
