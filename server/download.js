// File types accepted by the server and download of a file from a URL (videos and photos).
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './store.js';

/** A kind of file: the extensions it may have and the content types they come from. */
function kind(noun, byMime, aliases = {}) {
  const extensions = [...new Set(Object.values(byMime))];
  return {
    noun,
    /** Extension for an upload, from its name or else its content type; null if not this kind. */
    extensionFor(mime, name) {
      const fromName = path.extname(String(name || '').split('?')[0]).toLowerCase();
      if (extensions.includes(fromName)) return fromName;
      if (aliases[fromName]) return aliases[fromName];
      return byMime[String(mime || '').split(';')[0].trim().toLowerCase()] || null;
    },
  };
}

export const VIDEO = kind('video', {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-m4v': '.m4v', 'video/ogg': '.ogv',
});
export const PHOTO = kind('foto', {
  'image/jpeg': '.jpg', 'image/pjpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
}, { '.jpeg': '.jpg' });

/** Downloads `url` into `target` + extension, refusing other kinds of content and oversized files. */
export async function downloadFile(url, target, { type, maxBytes, timeoutMs = 120000 }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, `URL ${type === PHOTO ? 'della foto' : 'del video'} non valido.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new HttpError(400, 'Sono ammessi solo URL http/https.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) throw new HttpError(502, `Download fallito (HTTP ${response.status}).`);
    const mime = response.headers.get('content-type') || '';
    const ext = type.extensionFor(mime, parsed.pathname);
    if (!ext) throw new HttpError(415, `Il contenuto scaricato non è ${type === PHOTO ? 'una foto' : 'un video'} (${mime || 'tipo sconosciuto'}).`);
    let size = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) callback(new HttpError(413, 'Il file supera la dimensione massima.'));
        else callback(null, chunk);
      },
    });
    const file = `${target}${ext}`;
    try {
      await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(file));
    } catch (error) {
      await rm(file, { force: true });
      throw error instanceof HttpError ? error : new HttpError(502, `Download interrotto: ${error.message}`);
    }
    return { file: path.basename(file), size, mime: mime.split(';')[0] || null };
  } catch (error) {
    if (error.name === 'AbortError') throw new HttpError(504, 'Download scaduto.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
