// Photos to print (status queued -> printing -> printed | saved | failed): upload from n8n, print
// queue polled by the print agent (print/agent.js), previews of the composed print for the
// /print/<event> page (live through the event stream: `print`, `print-removed`), admin actions.
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { HttpError } from './store.js';
import { PHOTO, downloadFile } from './download.js';
import { normalizePrintSettings } from './print-settings.js';
import { agentTemplate } from './templates.js';

// a photo claimed by an agent that then vanished goes back in the queue after this long
const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_COPIES = 10;
// values printed in the template's {total}, {technique}, {fun}, {style}, {performance} texts
export const SCORE_FIELDS = ['total', 'technique', 'fun', 'style', 'performance'];
const MAX_SCORE = 999;

/** userid and the five scores from the request; 400 listing what is missing or wrong. */
function readPrintFields(body = {}) {
  const problems = [];
  const userId = String(body.userid ?? body.userId ?? '').trim().slice(0, 100);
  if (!userId) problems.push('userid');
  const scores = {};
  SCORE_FIELDS.forEach((field) => {
    const raw = body[field];
    const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'));
    if (raw === undefined || raw === null || String(raw).trim() === '' || !Number.isFinite(value) || value < 0 || value > MAX_SCORE) {
      problems.push(field);
    } else {
      scores[field] = Math.round(value);
    }
  });
  if (problems.length) {
    throw new HttpError(400, `Campi mancanti o non validi: ${problems.join(', ')} (userid testo, punteggi numeri da 0 a ${MAX_SCORE}).`);
  }
  return { userId, scores };
}

// a reprint sends a new preview under the same name: the version makes the URL change
const previewUrl = (photo, slug) => (photo.previewFile
  ? `/previews/${slug}/${photo.previewFile}?v=${encodeURIComponent(photo.previewAt || '')}`
  : null);

export const publicPhoto = (photo, slug) => ({
  ...photo,
  fileUrl: `/api/print/photos/${photo.id}/file`,
  previewUrl: previewUrl(photo, slug),
});

// what the public print page may see: no file names of the original photo
const publicPrint = (photo, slug) => ({
  id: photo.id,
  userId: photo.userId,
  scores: photo.scores || null,
  status: photo.status,
  error: photo.error || null,
  createdAt: photo.createdAt,
  printedAt: photo.printedAt || null,
  copies: photo.copies || 1,
  // for the print dialog of the page: where and on what it is printed
  printer: photo.printer || null,
  paper: photo.paper || null,
  layout: photo.layout || null,
  previewAt: photo.previewAt || null,
  previewUrl: previewUrl(photo, slug),
});

/**
 * How the agent laid the sheet out (x-print-layout: JSON, URI-encoded): only known fields, as short
 * texts and sizes in mm. Returns { paper: { widthMm, heightMm }, layout } or nulls.
 */
function readLayout(header) {
  let raw;
  try {
    raw = JSON.parse(decodeURIComponent(String(header || '')));
  } catch {
    return { paper: null, layout: null };
  }
  const size = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 2000 ? Number(v) : null);
  const widthMm = size(raw?.widthMm);
  const heightMm = size(raw?.heightMm);
  const layout = {};
  ['paper', 'border', 'margins', 'fit', 'orientation'].forEach((key) => {
    if (typeof raw?.[key] === 'string') layout[key] = raw[key].slice(0, 120);
  });
  return {
    paper: widthMm && heightMm ? { widthMm, heightMm } : null,
    layout: Object.keys(layout).length ? layout : null,
  };
}

const isWaiting = (photo, now = Date.now()) => photo.status === 'queued'
  || (photo.status === 'printing' && now - Date.parse(photo.claimedAt) > CLAIM_TIMEOUT_MS);

const newName = (ext) => `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;

export function photoRoutes(app, {
  store, requireKey, maxBytes, hub, logger,
}) {
  const announce = (slug, photo) => hub.send(slug, 'print', publicPrint(photo, slug));

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (req, file, cb) => {
        const dir = store.photosDir(req.params.slug);
        await mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, newName(PHOTO.extensionFor(file.mimetype, file.originalname))),
    }),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (req, file, cb) => {
      if (PHOTO.extensionFor(file.mimetype, file.originalname)) cb(null, true);
      else cb(new HttpError(415, `Il file non è una foto JPEG, PNG o WebP (${file.mimetype}).`));
    },
  });

  // the admin shows whether a print agent is polling, and with which printer
  const agentSeen = (req) => {
    const before = app.locals.printAgent;
    const printer = String(req.get('x-printer') || '').slice(0, 200);
    // in the log: the agent showing up (first time, after a minute of silence, other printer)
    if (!before || Date.now() - Date.parse(before.lastSeenAt) > 60000 || before.printer !== printer) {
      logger?.info('stampa', `Servizio di stampa collegato: ${req.get('x-print-agent') || 'stampa'} · ${printer || 'nessuna stampante (solo anteprima)'}`);
    }
    app.locals.printAgent = {
      name: String(req.get('x-print-agent') || 'stampa').slice(0, 100),
      printer: String(req.get('x-printer') || '').slice(0, 200),
      lastSeenAt: new Date().toISOString(),
    };
  };

  // --- upload from n8n: multipart file (any field name) or JSON { url, ... }, with userid and the
  // five scores (required), title and copies (optional) ------------------------------------
  // POST /<event>/print, or the older /api/events/<event>/photos
  app.post(['/:slug/print', '/api/events/:slug/photos'], requireKey, async (req, res, next) => {
    const event = await store.get(req.params.slug);
    if (!event.active) throw new HttpError(409, `L'evento «${event.slug}» è spento: accendilo per ricevere foto.`);
    if (req.is('multipart/form-data')) {
      upload.any()(req, res, (error) => (error ? next(error) : next()));
      return;
    }
    express.json()(req, res, next);
  }, async (req, res) => {
    const { slug } = req.params;
    let fields;
    try {
      fields = readPrintFields(req.body);
    } catch (error) {
      await Promise.all((req.files || []).map((f) => rm(f.path, { force: true })));
      throw error;
    }
    let photo;
    if (req.files) {
      const [file] = req.files;
      if (!file) throw new HttpError(400, 'Nessuna foto nella richiesta.');
      photo = {
        file: file.filename, size: file.size, mime: file.mimetype, originalName: file.originalname, source: 'upload',
      };
    } else if (req.body?.url) {
      await mkdir(store.photosDir(slug), { recursive: true });
      const target = path.join(store.photosDir(slug), newName(''));
      const saved = await downloadFile(req.body.url, target, { type: PHOTO, maxBytes });
      photo = { ...saved, originalName: path.basename(new URL(req.body.url).pathname), source: 'url' };
    } else {
      throw new HttpError(400, 'Invia la foto come file (multipart/form-data) oppure JSON {"url": "..."}.');
    }
    const entry = await store.addPhoto(slug, {
      ...photo,
      ...fields,
      title: req.body?.title ? String(req.body.title).slice(0, 200) : '',
      copies: Math.min(MAX_COPIES, Math.max(1, Math.trunc(Number(req.body?.copies) || 1))),
    });
    logger?.info('attivita', `Foto in coda di stampa (${entry.copies} ${entry.copies === 1 ? 'copia' : 'copie'}, id ${entry.id})`, { event: slug });
    res.status(201).json(publicPhoto(entry, slug));
  });

  // --- print agent ---------------------------------------------------------------------
  // photos waiting to be printed, oldest first; events that are off are paused
  app.get('/api/print/queue', requireKey, async (req, res) => {
    agentSeen(req);
    const now = Date.now();
    const queue = [];
    (await store.list()).filter((event) => event.active).forEach((event) => {
      event.photos.filter((photo) => isWaiting(photo, now)).forEach((photo) => {
        queue.push({
          ...publicPhoto(photo, event.slug),
          slug: event.slug,
          eventName: event.name,
          printSettings: normalizePrintSettings(event.printSettings),
          // the template uploaded from the admin, if any (otherwise the agent's own folder)
          template: agentTemplate(event),
        });
      });
    });
    queue.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    res.json(queue);
  });

  // an agent takes a photo before printing it, so two agents never print the same one
  app.post('/api/print/photos/:id/claim', requireKey, async (req, res) => {
    agentSeen(req);
    const { event, photo } = await store.updatePhoto(
      req.params.id,
      { status: 'printing', claimedAt: new Date().toISOString(), error: null },
      (current) => {
        if (!isWaiting(current)) throw new HttpError(409, 'Foto già presa in carico o già stampata.');
      },
    );
    announce(event.slug, photo);
    res.json({ ...publicPhoto(photo, event.slug), slug: event.slug, eventName: event.name });
  });

  // the composed picture, sent by the agent before printing: shown on /print/<event>
  app.post('/api/print/photos/:id/preview', requireKey, express.raw({ type: 'image/jpeg', limit: maxBytes }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Invia l\'anteprima come image/jpeg.');
    const { event } = await store.findPhoto(req.params.id);
    const previewFile = `${req.params.id}.jpg`;
    await mkdir(store.previewsDir(event.slug), { recursive: true });
    await writeFile(path.join(store.previewsDir(event.slug), previewFile), req.body);
    agentSeen(req);
    const { photo } = await store.updatePhoto(req.params.id, {
      previewFile,
      previewAt: new Date().toISOString(),
      printer: String(req.get('x-printer') || '').slice(0, 200) || null,
      ...readLayout(req.get('x-print-layout')),
    });
    announce(event.slug, photo);
    res.json(publicPrint(photo, event.slug));
  });

  app.get('/api/print/photos/:id/file', requireKey, async (req, res) => {
    const { event, photo } = await store.findPhoto(req.params.id);
    res.sendFile(path.join(store.photosDir(event.slug), photo.file));
  });

  app.post('/api/print/photos/:id/result', requireKey, express.json(), async (req, res) => {
    agentSeen(req);
    const ok = req.body?.ok === true;
    const { event, photo } = await store.updatePhoto(req.params.id, {}, (current) => {
      Object.assign(current, ok
        ? {
          // saved: the agent has no printer configured and only wrote the file
          status: req.body.printed === false ? 'saved' : 'printed',
          printedAt: new Date().toISOString(),
          prints: (current.prints || 0) + (req.body.printed === false ? 0 : 1),
          error: null,
        }
        : { status: 'failed', error: String(req.body?.error || 'Errore di stampa.').slice(0, 500) });
      if (req.body?.output) current.output = String(req.body.output).slice(0, 500);
    });
    if (photo.status === 'failed') logger?.error('stampa', `Stampa non riuscita (foto ${photo.id}): ${photo.error}`, { event: event.slug });
    else logger?.info('stampa', `${photo.status === 'saved' ? 'Foto composta, senza stampante: solo anteprima' : 'Foto stampata'} (foto ${photo.id})`, { event: event.slug });
    announce(event.slug, photo);
    res.json(publicPhoto(photo, event.slug));
  });

  // --- admin -------------------------------------------------------------------------------
  app.post('/api/events/:slug/photos/:id/reprint', requireKey, async (req, res) => {
    const { event, photo } = await store.updatePhoto(req.params.id, { status: 'queued', error: null, claimedAt: null });
    announce(event.slug, photo);
    res.json(publicPhoto(photo, event.slug));
  });

  app.delete('/api/events/:slug/photos', requireKey, async (req, res) => {
    const removed = await store.clearPhotos(req.params.slug);
    removed.forEach((photo) => hub.send(req.params.slug, 'print-removed', { id: photo.id }));
    res.json({ removed: removed.length });
  });

  app.delete('/api/events/:slug/photos/:id', requireKey, async (req, res) => {
    await store.removePhoto(req.params.slug, req.params.id);
    hub.send(req.params.slug, 'print-removed', { id: req.params.id });
    res.status(204).end();
  });

  // --- print page (public, read-only like the wall) ------------------------------------
  app.get('/api/events/:slug/prints', async (req, res) => {
    const event = await store.get(req.params.slug);
    res.json({
      slug: event.slug,
      name: event.name,
      active: event.active,
      prints: event.photos.slice().reverse().map((photo) => publicPrint(photo, event.slug)),
    });
  });

  app.use('/previews', express.static(store.previewsRoot, { fallthrough: false, maxAge: '1h' }));
}
