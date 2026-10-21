// HTTP server: admin API (events on/off), uploads from n8n (videos for the wall, photos to
// print), video wall with live updates, print queue for the print agent (see print/).
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import { createStore, HttpError } from './store.js';
import { VIDEO, downloadFile } from './download.js';
import { photoRoutes, publicPhoto } from './photos.js';
import { PRINT_OPTIONS, normalizePrintSettings } from './print-settings.js';
import { publicTemplate, templateRoutes } from './templates.js';
import { mailRoutes, publicMailTemplate } from './mail.js';
import { createLogger, logRoutes, requestLogger } from './logs.js';
import { createAuth } from './auth.js';
import { requireHttps } from './https.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Server-sent events per event slug: the wall receives new videos and on/off at once. */
// A client is { send(type, data), close() }: an SSE response or a WebSocket (see attachLive).
function createHub() {
  const clients = new Map();
  return {
    add(slug, client) {
      if (!clients.has(slug)) clients.set(slug, new Set());
      clients.get(slug).add(client);
      return () => clients.get(slug)?.delete(client);
    },
    send(slug, type, data) {
      clients.get(slug)?.forEach((client) => client.send(type, data));
    },
    count(slug) {
      return clients.get(slug)?.size || 0;
    },
    closeAll() {
      clients.forEach((set) => set.forEach((client) => client.close()));
      clients.clear();
    },
  };
}

const LIVE_PATH = /^\/api\/events\/([a-z0-9][a-z0-9-]{0,62})\/live$/;

/**
 * Live updates over WebSocket on /api/events/<event>/live, same messages as the SSE stream
 * ({ type, data }). WebSockets are not counted in the browser's 6 connections per site, so any
 * number of wall and print tabs can stay open. Call it with the http.Server of the app.
 */
export function attachLive(server, { store, hub, logger }) {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    const match = LIVE_PATH.exec(new URL(req.url, 'http://x').pathname);
    let event = null;
    if (match) event = await store.get(match[1]).catch(() => null);
    if (!event) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = {
        send: (type, data) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data })); },
        close: () => ws.close(1001),
      };
      client.send('status', { active: event.active, name: event.name });
      const remove = hub.add(event.slug, client);
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      logger?.info('attivita', `Schermo collegato in diretta (${hub.count(event.slug)} collegati)`, { event: event.slug, ip });
      // a ping every 25 s keeps proxies from closing a quiet connection
      const ping = setInterval(() => ws.ping(), 25000);
      ws.on('close', () => {
        clearInterval(ping);
        remove();
        logger?.info('attivita', `Schermo scollegato dalla diretta (${hub.count(event.slug)} collegati)`, { event: event.slug, ip });
      });
      ws.on('error', () => ws.terminate());
    });
  });
  return wss;
}

const publicVideo = (slug, video) => ({ ...video, url: video.file ? `/media/${slug}/${video.file}` : null });
const publicEvent = (event, hub, wallPlaceholder) => ({
  ...event,
  videos: event.videos.map((video) => publicVideo(event.slug, video)),
  photos: (event.photos || []).map((photo) => publicPhoto(photo, event.slug)),
  printSettings: normalizePrintSettings(event.printSettings),
  template: publicTemplate(event),
  mailTemplate: publicMailTemplate(event),
  mailUrl: `/${event.slug}/mail`,
  // sample cards on the wall while there are few videos (WALL_PLACEHOLDER), on by default
  showPlaceholder: event.showPlaceholder !== false,
  placeholderAvailable: Boolean(wallPlaceholder),
  // pages and n8n calls share the address: GET shows the page, POST sends the content
  wallUrl: `/${event.slug}/wall`,
  printUrl: `/${event.slug}/print`,
  uploadUrl: `/${event.slug}/wall`,
  photoUploadUrl: `/${event.slug}/print`,
  screens: hub ? hub.count(event.slug) : 0,
});

/**
 * Placeholder shown by the wall while it has fewer videos than a row:
 * a YouTube link becomes { type: 'youtube', id }, any other URL { type: 'video', url }.
 */
export function parsePlaceholder(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.)/, '');
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1];
  }
  if (id && /^[\w-]{6,20}$/.test(id)) return { type: 'youtube', id };
  return ['http:', 'https:'].includes(url.protocol) ? { type: 'video', url: url.href } : null;
}

/**
 * options: { dataDir, apiKey, adminUser, adminPasswordHash, maxUploadMb, placeholder, publicUrl,
 *   showcaseSeconds, logRetentionDays, logger, trustProxy, https }
 * `trustProxy`: Express «trust proxy» (HTTPS done by a proxy in front). `https`: { port } when the
 * console is reachable on HTTPS, so it is required there (see https.js).
 * Returns { app, store, hub, logger }.
 */
export function createApp({
  dataDir, apiKey, adminUser = 'admin', adminPasswordHash, maxUploadMb = 500, placeholder = '', publicUrl = '', showcaseSeconds = 8,
  trustProxy, https = null,
  logRetentionDays = 2, logger = createLogger({ dir: path.join(dataDir, 'logs'), retentionDays: logRetentionDays }),
}) {
  const wallPlaceholder = parsePlaceholder(placeholder);
  const store = createStore(dataDir);
  const hub = createHub();
  const maxBytes = maxUploadMb * 1024 * 1024;
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(requestLogger(logger));
  if (https) app.use(requireHttps({ port: https.port, publicUrl }));

  // requireKey: API key (n8n, print agent) or console login; requireAdmin: console login only
  const auth = createAuth({
    apiKey, adminUser, adminPasswordHash, logger,
  });
  const { requireKey, requireAdmin } = auth;
  auth.routes(app);

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (req, file, cb) => {
        const dir = store.mediaDir(req.params.slug);
        await mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}${VIDEO.extensionFor(file.mimetype, file.originalname)}`),
    }),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (req, file, cb) => {
      if (VIDEO.extensionFor(file.mimetype, file.originalname)) cb(null, true);
      else cb(new HttpError(415, `Il file non è un video (${file.mimetype}).`));
    },
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  // base address for links shown in the admin (empty: the browser's own origin), print agent status
  app.get('/api/info', requireAdmin, (req, res) => res.json({
    publicUrl: publicUrl.replace(/\/+$/, ''),
    printAgent: app.locals.printAgent || null,
    printOptions: PRINT_OPTIONS,
  }));

  // --- events (admin) -----------------------------------------------------------------
  app.get('/api/events', requireKey, async (req, res) => {
    res.json((await store.list()).map((event) => publicEvent(event, hub, wallPlaceholder)));
  });

  app.post('/api/events', requireKey, express.json(), async (req, res) => {
    const event = await store.create(req.body || {});
    res.status(201).json(publicEvent(event, hub, wallPlaceholder));
  });

  app.patch('/api/events/:slug', requireKey, express.json(), async (req, res) => {
    // the print and mail templates change only through their own routes
    const { template, mailTemplate, ...changes } = req.body || {};
    if (changes.printSettings !== undefined) changes.printSettings = normalizePrintSettings(changes.printSettings, { strict: true });
    const event = await store.update(req.params.slug, changes);
    hub.send(event.slug, 'status', { active: event.active, name: event.name });
    // the wall reloads what it shows (e.g. the sample cards switched on or off)
    if (typeof changes.showPlaceholder === 'boolean') hub.send(event.slug, 'settings', {});
    res.json(publicEvent(event, hub, wallPlaceholder));
  });

  app.delete('/api/events/:slug', requireKey, async (req, res) => {
    hub.send(req.params.slug, 'status', { active: false, deleted: true });
    await store.remove(req.params.slug);
    res.status(204).end();
  });

  app.delete('/api/events/:slug/videos', requireKey, async (req, res) => {
    const removed = await store.clearVideos(req.params.slug);
    // «delete all» empties the wall: the sample cards go too (they can be switched on again)
    await store.update(req.params.slug, { showPlaceholder: false });
    removed.forEach((video) => hub.send(req.params.slug, 'removed', { id: video.id }));
    hub.send(req.params.slug, 'settings', {});
    res.json({ removed: removed.length });
  });

  app.delete('/api/events/:slug/videos/:id', requireKey, async (req, res) => {
    const video = await store.removeVideo(req.params.slug, req.params.id);
    hub.send(req.params.slug, 'removed', { id: video.id });
    res.status(204).end();
  });

  // --- upload from n8n: multipart file (any field name) or JSON { url, title } ---------
  // POST /<event>/wall, or the older /api/events/<event>/videos
  app.post(['/:slug/wall', '/api/events/:slug/videos'], requireKey, async (req, res, next) => {
    const event = await store.get(req.params.slug);
    if (!event.active) throw new HttpError(409, `L'evento «${event.slug}» è spento: accendilo per ricevere video.`);
    if (req.is('multipart/form-data')) {
      upload.any()(req, res, (error) => (error ? next(error) : next()));
      return;
    }
    express.json()(req, res, next);
  }, async (req, res) => {
    const { slug } = req.params;
    let video;
    if (req.files) {
      const [file] = req.files;
      if (!file) throw new HttpError(400, 'Nessun file video nella richiesta.');
      video = {
        file: file.filename, size: file.size, mime: file.mimetype, originalName: file.originalname, source: 'upload',
      };
    } else if (parsePlaceholder(req.body?.url)?.type === 'youtube') {
      // YouTube pages cannot be downloaded as a file: the wall embeds them instead
      video = { youtubeId: parsePlaceholder(req.body.url).id, originalName: String(req.body.url), source: 'youtube' };
    } else if (req.body?.url) {
      await mkdir(store.mediaDir(slug), { recursive: true });
      const target = path.join(store.mediaDir(slug), `${Date.now()}-${randomUUID().slice(0, 8)}`);
      const saved = await downloadFile(req.body.url, target, { type: VIDEO, maxBytes });
      video = { ...saved, originalName: path.basename(new URL(req.body.url).pathname), source: 'url' };
    } else {
      throw new HttpError(400, 'Invia il video come file (multipart/form-data) oppure JSON {"url": "..."}.');
    }
    const title = req.body?.title ? String(req.body.title).slice(0, 200) : '';
    // shown on the wall as «<userid>, ecco il tuo video»
    const userId = String(req.body?.userid ?? req.body?.userId ?? '').trim().slice(0, 100);
    const entry = await store.addVideo(slug, { ...video, title, userId });
    const from = { upload: 'file', url: 'scaricato da URL', youtube: 'YouTube' }[video.source];
    const size = video.size ? `, ${(video.size / 1024 / 1024).toFixed(1)} MB` : '';
    logger.info('attivita', `Video aggiunto al wall (${from}${size}, id ${entry.id})`, { event: slug });
    const payload = publicVideo(slug, entry);
    hub.send(slug, 'video', payload);
    res.status(201).json(payload);
  });

  // --- wall (public, read-only) -------------------------------------------------------
  app.get('/api/events/:slug/wall', async (req, res) => {
    const event = await store.get(req.params.slug);
    res.json({
      slug: event.slug,
      name: event.name,
      active: event.active,
      placeholder: event.showPlaceholder === false ? null : wallPlaceholder,
      showcaseSeconds,
      videos: event.videos.map((video) => publicVideo(event.slug, video)),
    });
  });

  app.get('/api/events/:slug/stream', async (req, res) => {
    const event = await store.get(req.params.slug);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // reverse proxies (nginx, IIS ARR) must not buffer the stream
      'X-Accel-Buffering': 'no',
    });
    const client = {
      send: (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
      close: () => res.end(),
    };
    client.send('status', { active: event.active, name: event.name });
    const remove = hub.add(event.slug, client);
    // comment line every 25s keeps proxies and browsers from closing the stream
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      remove();
    });
  });

  photoRoutes(app, {
    store, requireKey, maxBytes, hub, logger,
  });
  templateRoutes(app, {
    store, requireKey, requireAdmin, maxBytes,
  });
  mailRoutes(app, {
    store, requireKey, requireAdmin, dataDir, logger,
  });
  logRoutes(app, { logger, requireAdmin });

  app.use('/media', express.static(store.mediaRoot, { fallthrough: false, maxAge: '1h' }));
  app.get('/:slug/wall', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'wall.html')));
  app.get('/:slug/print', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'print.html')));
  // the first addresses: /wall/<event> and /print/<event>
  app.get('/wall/:slug', (req, res) => res.redirect(301, `/${encodeURIComponent(req.params.slug)}/wall`));
  app.get('/print/:slug', (req, res) => res.redirect(301, `/${encodeURIComponent(req.params.slug)}/print`));
  app.get('/', (req, res) => res.redirect('/admin'));
  app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
  app.use('/static', express.static(PUBLIC_DIR));

  app.use((req, res, next) => next(new HttpError(404, `Risorsa non trovata: ${req.path}`)));
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    let status = error.status || error.statusCode || 500;
    let { message } = error;
    if (error instanceof multer.MulterError) {
      status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      message = error.code === 'LIMIT_FILE_SIZE' ? `Il file supera ${maxUploadMb} MB.` : error.message;
    }
    if (status >= 500 && !error.quiet) console.error(error);
    // the reason, next to the call in the log
    res.locals.logError = message || 'Errore interno.';
    if (!res.headersSent) res.status(status).json({ error: message || 'Errore interno.' });
  });

  return {
    app, store, hub, logger,
  };
}
