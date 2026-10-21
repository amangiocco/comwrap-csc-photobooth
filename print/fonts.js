// Fonts for the template texts: the .ttf/.otf files in a folder are registered for drawing and
// matched to the font names the PSD uses (PostScript names such as «Alaska-ExtraCondBlackIta»).
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { GlobalFonts } from '@napi-rs/canvas';

// used when a template font is missing: condensed and heavy, like the Alaska family
export const FALLBACK_FONT = 'Impact';

const normalize = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Names in a TrueType/OpenType file: PostScript (6), full name (4), family (1). */
export function fontNames(buffer) {
  const names = new Set();
  try {
    const tables = buffer.readUInt16BE(4);
    for (let t = 0; t < tables; t += 1) {
      const entry = 12 + t * 16;
      if (buffer.toString('latin1', entry, entry + 4) !== 'name') continue;
      const table = buffer.readUInt32BE(entry + 8);
      const count = buffer.readUInt16BE(table + 2);
      const strings = table + buffer.readUInt16BE(table + 4);
      for (let r = 0; r < count; r += 1) {
        const record = table + 6 + r * 12;
        const platform = buffer.readUInt16BE(record);
        const nameId = buffer.readUInt16BE(record + 6);
        if (![1, 4, 6].includes(nameId)) continue;
        const length = buffer.readUInt16BE(record + 8);
        const start = strings + buffer.readUInt16BE(record + 10);
        const raw = buffer.subarray(start, start + length);
        // Windows/Unicode names are UTF-16BE, Mac names single byte
        const text = platform === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le');
        if (text) names.add(text);
      }
    }
  } catch {
    // not a font we can read: matched by file name only
  }
  return [...names];
}

/**
 * Registers the fonts in `dir`; returns lookup(psdFontName) -> family to draw with, or null.
 * Each file is registered under its own alias, so two styles of a family never clash.
 */
export async function loadFonts(dir) {
  const byName = new Map();
  let files = [];
  try {
    files = (await readdir(dir)).filter((name) => /\.(ttf|otf)$/i.test(name));
  } catch {
    // no fonts folder
  }
  for (const name of files) {
    const file = path.join(dir, name);
    const alias = `tpl-${normalize(name)}`;
    // eslint-disable-next-line no-await-in-loop
    const buffer = await readFile(file);
    if (!GlobalFonts.register(buffer, alias)) continue;
    [path.parse(name).name, ...fontNames(buffer)].forEach((n) => byName.set(normalize(n), alias));
  }
  const system = new Set(GlobalFonts.families.map((f) => normalize(f.family)));
  return {
    files,
    lookup(psdName) {
      const key = normalize(psdName);
      if (byName.has(key)) return byName.get(key);
      // an installed system font with that family name
      const found = GlobalFonts.families.find((f) => normalize(f.family) === key);
      return found && system.has(key) ? found.family : null;
    },
  };
}
