// The calls of n8n name the event as a parameter, not in the address: the same URL works for every
// event (POST /api/videos, /api/photos, /api/mail...). «eventID» in the query (?eventID=), in the
// x-event-id header or as a field of the body (JSON, form, multipart). The older addresses with the
// event in the path (/<event>/wall, /api/events/<event>/videos...) still work.
import path from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import express from 'express';
import { HttpError } from './store.js';

const clean = (value) => String(value ?? '').trim();

/** The event of the call, from the path, the query or the header (the body is not read yet). */
export const eventBeforeBody = (req) => clean(req.params?.slug) || clean(req.query?.eventID) || clean(req.get('x-event-id'));

/** The event of the call, also from the body; 400 if there is none. Also kept for the log. */
export function eventOf(req, res) {
  const slug = eventBeforeBody(req) || clean(req.body?.eventID);
  if (!slug) throw new HttpError(400, 'Manca «eventID»: il nome dell\'evento (campo eventID, ?eventID= o header x-event-id).');
  if (res) res.locals.event = slug.slice(0, 64);
  return slug;
}

/**
 * Middlewares for the uploads (video, photo): the event must be on, the body is a file (multipart,
 * any field name) or JSON. `upload` is the multer instance: it writes into uploadDir(req, ...).
 * When the event comes only with the file's fields, the file first goes to the staging folder and
 * is moved into the event's folder (`dirFor(slug)`) once the fields are read. Then req.slug is set.
 */
export const uploadDir = (req, dirFor, stagingDir) => (req.slug ? dirFor(req.slug) : stagingDir);

export function receiveUpload({
  store, upload, dirFor, refused,
}) {
  const check = async (slug) => {
    const event = await store.get(slug);
    if (!event.active) throw new HttpError(409, `L'evento «${event.slug}» è spento: ${refused}.`);
  };
  const files = (req) => req.files || [];
  return [
    async (req, res, next) => {
      req.slug = eventBeforeBody(req) || null;
      if (req.slug) {
        res.locals.event = req.slug.slice(0, 64);
        await check(req.slug);
      }
      (req.is('multipart/form-data') ? upload.any() : express.json())(req, res, next);
    },
    async (req, res, next) => {
      if (req.slug) return next();
      try {
        req.slug = eventOf(req, res);
        await check(req.slug);
        if (files(req).length) {
          const dir = dirFor(req.slug);
          await mkdir(dir, { recursive: true });
          for (const file of files(req)) {
            const target = path.join(dir, file.filename);
            // eslint-disable-next-line no-await-in-loop
            await rename(file.path, target);
            Object.assign(file, { destination: dir, path: target });
          }
        }
      } catch (error) {
        await Promise.all(files(req).map((file) => rm(file.path, { force: true })));
        throw error;
      }
      return next();
    },
  ];
}
