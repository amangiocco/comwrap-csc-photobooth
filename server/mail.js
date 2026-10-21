// Email: one mail account for the server (SMTP, set from the admin) and an HTML template per event,
// imported from the admin together with its images. n8n calls POST /<event>/mail with the
// recipient, the subject (set by the service, with {placeholders} too), the userid (first and
// last name), the card made with the PSD template (file or URL) and the link to the EDS page
// built in the flow: {userid}, {link} and {card} (an image:
// <img src="{card}">) in the template, like any other parameter of the call ({name} or {{name}}).
// The card is shown in the mail and attached. Nothing about the people is stored: the mail is
// sent at once and the answer says how it went; recipients, values and card are not written
// anywhere (a downloaded card lives in a temporary file until the mail is sent), logs included.
//
// data/mail.json (account, password only on the server), data/mail/<event>/ (template.html, images)
import path from 'node:path';
import os from 'node:os';
import {
  mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import nodemailer from 'nodemailer';
import { HttpError } from './store.js';
import { PHOTO, downloadFile } from './download.js';

const SECURITY = { ssl: 'SSL/TLS (di solito porta 465)', starttls: 'STARTTLS (di solito porta 587)', none: 'Nessuna (solo reti interne)' };
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;
const HTML_FILE = /\.html?$/i;
const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}|\{\s*([\w.-]+)\s*\}/g;
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
// fields of the call that are not template parameters ({card} is the image, not the URL sent)
const RESERVED = new Set(['to', 'cc', 'bcc', 'subject', 'params', 'card', 'cardUrl']);
// what every call must carry, and what the template should use
export const REQUIRED_PLACEHOLDERS = ['userid', 'card', 'link'];
const CARD_MAX_BYTES = 15 * 1024 * 1024;
const CARD_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
// a grey 2:3 card for the preview in the admin, where the real one is not there yet
const SAMPLE_CARD = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="540" height="810" viewBox="0 0 540 810"><rect width="540" height="810" fill="#d6d3d1"/><text x="270" y="405" font-family="sans-serif" font-size="44" fill="#57534e" text-anchor="middle">{card}</text></svg>')}`;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const cleanName = (name) => path.basename(String(name || '')).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';

/** The names of the {placeholders} of a text, in order of appearance, without repetitions. */
export function placeholders(text) {
  const names = [];
  for (const match of String(text || '').matchAll(PLACEHOLDER)) {
    const name = match[1] || match[2];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Puts the values in the text; `escape` for HTML. Returns { text, missing }. */
export function fill(text, values, { escape = true } = {}) {
  const missing = new Set();
  const out = String(text || '').replace(PLACEHOLDER, (all, a, b) => {
    const name = a || b;
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (value === undefined || value === null) {
      missing.add(name);
      return '';
    }
    return escape ? escapeHtml(value) : String(value);
  });
  return { text: out, missing: [...missing] };
}

/** Recipients: a string with commas/semicolons or a list; every address must be valid. */
function readRecipients(value, label, { required = false } = {}) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(/[,;]/))
    .map((v) => String(v).trim()).filter(Boolean);
  if (required && !list.length) throw new HttpError(400, `Manca il destinatario («${label}»).`);
  const wrong = list.filter((v) => !EMAIL.test(v));
  if (wrong.length) throw new HttpError(400, `Indirizzo non valido in «${label}».`);
  if (list.length > 50) throw new HttpError(400, `Troppi indirizzi in «${label}» (massimo 50).`);
  return list;
}

/** A plain-text copy of the HTML, for mail programs that do not show HTML. */
function htmlToText(html) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Images of the template referred to with a relative path (src="logo.png", url(img/logo.png)) and
 * uploaded with it: `replace(name)` gives what to put instead (cid: for the mail, data: for the
 * preview). Absolute URLs (https://...) stay as they are.
 */
function swapImages(html, images, replace) {
  const byName = new Map(images.map((name) => [name.toLowerCase(), name]));
  const swap = (ref) => {
    if (/^(https?:|data:|cid:|mailto:|#)/i.test(ref)) return null;
    const name = byName.get(path.basename(ref.split(/[?#]/)[0]).toLowerCase());
    return name ? replace(name) : null;
  };
  return html
    .replace(/(\s(?:src|background)\s*=\s*)(["'])([^"']+)\2/gi, (all, attr, q, ref) => {
      const to = swap(ref);
      return to ? `${attr}${q}${to}${q}` : all;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, q, ref) => {
      const to = swap(ref);
      return to ? `url(${q}${to}${q})` : all;
    });
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

/** What the admin shows about the mail template of an event. */
export function publicMailTemplate(event) {
  const t = event.mailTemplate;
  if (!t) return null;
  return {
    originalName: t.originalName,
    images: t.images,
    placeholders: t.placeholders,
    // {userid}, {card}, {link} not used by the template: the call carries them anyway
    unused: REQUIRED_PLACEHOLDERS.filter((name) => !t.placeholders.includes(name)),
    uploadedAt: t.uploadedAt,
    previewUrl: `/api/events/${event.slug}/mail-template/preview`,
  };
}

export function mailRoutes(app, {
  store, requireKey, requireAdmin, dataDir, logger,
}) {
  const configFile = path.join(dataDir, 'mail.json');
  const templatesRoot = path.join(dataDir, 'mail');
  const templateDir = (slug) => path.join(templatesRoot, slug);
  let config = null;

  async function loadConfig() {
    if (config) return config;
    try {
      config = JSON.parse(await readFile(configFile, 'utf8'));
    } catch {
      config = {};
    }
    return config;
  }

  async function saveConfig(next) {
    await mkdir(dataDir, { recursive: true });
    const tmp = `${configFile}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, configFile);
    config = next;
  }

  const publicConfig = (c) => ({
    host: c.host || '',
    port: c.port || null,
    security: c.security || 'starttls',
    user: c.user || '',
    passwordSet: Boolean(c.password),
    fromAddress: c.fromAddress || '',
    fromName: c.fromName || '',
    replyTo: c.replyTo || '',
    configured: Boolean(c.host && c.fromAddress),
    securityOptions: SECURITY,
  });

  async function transport() {
    const c = await loadConfig();
    if (!c.host || !c.fromAddress) throw new HttpError(409, 'Account email non configurato: impostalo nell\'admin («Account email»).');
    const secure = c.security === 'ssl';
    return nodemailer.createTransport({
      host: c.host,
      port: c.port || (secure ? 465 : 587),
      secure,
      requireTLS: c.security === 'starttls',
      ignoreTLS: c.security === 'none',
      auth: c.user ? { user: c.user, pass: c.password || '' } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
  }

  const sender = (c) => (c.fromName ? { name: c.fromName, address: c.fromAddress } : c.fromAddress);

  /** The SMTP problem in words, for the caller only: never logged (it may name the recipient). */
  const smtpError = (error) => Object.assign(new HttpError(502, `Invio non riuscito: ${error.response || error.message}`.slice(0, 400)), { quiet: true });

  // --- account (one for the server) ---------------------------------------------------------
  app.get('/api/mail/config', requireAdmin, async (req, res) => res.json(publicConfig(await loadConfig())));

  app.put('/api/mail/config', requireAdmin, express.json(), async (req, res) => {
    const body = req.body || {};
    const current = await loadConfig();
    const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);
    const next = {
      host: text(body.host),
      port: body.port === '' || body.port == null ? null : Number(body.port),
      security: Object.hasOwn(SECURITY, body.security) ? body.security : 'starttls',
      user: text(body.user),
      // an empty password field keeps the one already set
      password: body.password ? String(body.password) : current.password || '',
      fromAddress: text(body.fromAddress),
      fromName: text(body.fromName),
      replyTo: text(body.replyTo),
    };
    if (body.clearPassword) next.password = '';
    const problems = [];
    if (!next.host) problems.push('server SMTP');
    if (next.port !== null && !(Number.isInteger(next.port) && next.port > 0 && next.port < 65536)) problems.push('porta');
    if (!EMAIL.test(next.fromAddress)) problems.push('indirizzo del mittente');
    if (next.replyTo && !EMAIL.test(next.replyTo)) problems.push('indirizzo per le risposte');
    if (problems.length) throw new HttpError(400, `Account email non valido: ${problems.join(', ')}.`);
    await saveConfig(next);
    res.json(publicConfig(next));
  });

  app.post('/api/mail/verify', requireAdmin, async (req, res) => {
    try {
      await (await transport()).verify();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw Object.assign(new HttpError(502, `Connessione non riuscita: ${error.response || error.message}`.slice(0, 400)), { quiet: true });
    }
    res.json({ ok: true });
  });

  app.post('/api/mail/test', requireAdmin, express.json(), async (req, res) => {
    const to = readRecipients(req.body?.to, 'to', { required: true });
    const c = await loadConfig();
    try {
      const info = await (await transport()).sendMail({
        from: sender(c),
        to,
        replyTo: c.replyTo || undefined,
        subject: 'Photobooth: mail di prova',
        text: 'Se leggi questo messaggio, l\'account email del photobooth funziona.',
      });
      res.json({ ok: true, messageId: info.messageId });
    } catch (error) {
      throw smtpError(error);
    }
  });

  // --- template of an event (HTML and images) --------------------------------------------------
  const upload = multer({
    storage: multer.diskStorage({
      destination: async (req, file, cb) => {
        const dir = path.join(templateDir(req.params.slug), 'incoming');
        await mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 15 * 1024 * 1024, files: 40 },
    fileFilter: (req, file, cb) => {
      if (HTML_FILE.test(file.originalname) || IMAGE_FILE.test(file.originalname)) cb(null, true);
      else cb(new HttpError(415, `«${file.originalname}» non è un file HTML né un'immagine.`));
    },
  });

  const describe = publicMailTemplate;

  async function templateFiles(slug) {
    const dir = templateDir(slug);
    const html = await readFile(path.join(dir, 'template.html'), 'utf8');
    const images = (await readdir(path.join(dir, 'images')).catch(() => [])).filter((n) => IMAGE_FILE.test(n));
    return { dir, html, images };
  }

  // the HTML (field of any name) and the images it uses; a new HTML replaces the old one, images
  // with the same name are replaced, the others stay
  app.post('/api/events/:slug/mail-template', requireAdmin, async (req, res) => {
    const event = await store.get(req.params.slug);
    const files = await new Promise((resolve, reject) => {
      upload.any()(req, res, (error) => (error ? reject(error) : resolve(req.files || [])));
    });
    const dir = templateDir(event.slug);
    try {
      const htmls = files.filter((f) => HTML_FILE.test(f.originalname));
      if (htmls.length > 1) throw new HttpError(400, 'Carica un solo file HTML per volta (più le sue immagini).');
      if (!htmls.length && !event.mailTemplate) throw new HttpError(400, 'Carica il file HTML del modello (più, se servono, le sue immagini).');
      await mkdir(path.join(dir, 'images'), { recursive: true });
      for (const file of files.filter((f) => IMAGE_FILE.test(f.originalname))) {
        // eslint-disable-next-line no-await-in-loop
        await rename(file.path, path.join(dir, 'images', cleanName(file.originalname)));
      }
      let originalName = event.mailTemplate?.originalName;
      if (htmls.length) {
        const html = await readFile(htmls[0].path, 'utf8');
        if (!/<[a-z][\s\S]*>/i.test(html)) throw new HttpError(400, 'Il file non sembra HTML.');
        await rename(htmls[0].path, path.join(dir, 'template.html'));
        originalName = cleanName(htmls[0].originalname);
      }
      const { html, images } = await templateFiles(event.slug);
      // the subject is not part of the template: every call brings its own
      const template = {
        originalName,
        images,
        placeholders: placeholders(html),
        uploadedAt: new Date().toISOString(),
      };
      const updated = await store.update(event.slug, { mailTemplate: template });
      res.status(201).json(describe(updated));
    } finally {
      await rm(path.join(dir, 'incoming'), { recursive: true, force: true });
    }
  });

  app.delete('/api/events/:slug/mail-template/images/:file', requireAdmin, async (req, res) => {
    const event = await store.get(req.params.slug);
    if (!event.mailTemplate) throw new HttpError(404, 'Nessun modello email per questo evento.');
    await rm(path.join(templateDir(event.slug), 'images', cleanName(req.params.file)), { force: true });
    const { images } = await templateFiles(event.slug);
    const updated = await store.update(event.slug, { mailTemplate: { ...event.mailTemplate, images } });
    res.json(describe(updated));
  });

  app.delete('/api/events/:slug/mail-template', requireAdmin, async (req, res) => {
    const event = await store.get(req.params.slug);
    await rm(templateDir(event.slug), { recursive: true, force: true });
    await store.update(event.slug, { mailTemplate: null });
    res.status(204).end();
  });

  // the HTML for the admin preview: images inline, the placeholders highlighted
  app.get('/api/events/:slug/mail-template/preview', requireAdmin, async (req, res) => {
    const event = await store.get(req.params.slug);
    if (!event.mailTemplate) throw new HttpError(404, 'Nessun modello email per questo evento.');
    const { dir, html, images } = await templateFiles(event.slug);
    const data = new Map(await Promise.all(images.map(async (name) => {
      const bytes = await readFile(path.join(dir, 'images', name));
      return [name, `data:${MIME[path.extname(name).toLowerCase()] || 'application/octet-stream'};base64,${bytes.toString('base64')}`];
    })));
    // in attributes (src="{card}", href="{link}") a sample value, in the text a highlight
    const inAttributes = html.replace(/(\s[\w:-]+\s*=\s*)(["'])([^"']*)\2/g, (all, attr, q, value) => {
      if (!placeholders(value).length) return all;
      return `${attr}${q}${value.replace(PLACEHOLDER, (m, a, b) => ((a || b) === 'card' ? SAMPLE_CARD : '#'))}${q}`;
    });
    const marked = inAttributes.replace(PLACEHOLDER, (all, a, b) => `<mark style="background:#fff3a3;color:#000">{${escapeHtml(a || b)}}</mark>`);
    res.type('html').send(swapImages(marked, images, (name) => data.get(name)));
  });

  // --- sending, from n8n ------------------------------------------------------------------------
  // the card: a file of the multipart call (any field name), kept in memory only
  const cardUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CARD_MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      if (PHOTO.extensionFor(file.mimetype, file.originalname)) cb(null, true);
      else cb(new HttpError(415, `La card non è un'immagine JPEG, PNG o WebP (${file.mimetype}).`));
    },
  });

  /** The card of the call: the uploaded file, or the image at the URL in «card» / «cardUrl». */
  async function readCard(req) {
    const file = req.files?.[0];
    if (file) {
      const ext = PHOTO.extensionFor(file.mimetype, file.originalname);
      return { content: file.buffer, ext, contentType: CARD_MIME[ext] };
    }
    const url = String(req.body?.cardUrl || req.body?.card || '').trim();
    if (!url) throw new HttpError(400, 'Manca la card: mandala come file (multipart) o come URL nel campo «card».');
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'photobooth-card-'));
    try {
      const saved = await downloadFile(url, path.join(tmp, 'card'), { type: PHOTO, maxBytes: CARD_MAX_BYTES, timeoutMs: 30000 });
      const ext = path.extname(saved.file);
      return { content: await readFile(path.join(tmp, saved.file)), ext, contentType: CARD_MIME[ext] };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  function readLink(value) {
    const text = String(value ?? '').trim();
    if (!text) throw new HttpError(400, 'Manca «link»: l\'indirizzo della pagina EDS.');
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new HttpError(400, '«link» non è un indirizzo valido.');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, '«link» deve essere un indirizzo http/https.');
    return url.href;
  }

  // POST /<event>/mail (or /api/events/<event>/mail): JSON, form or multipart fields.
  // to, subject (may hold {placeholders}), userid (first and last name), link (EDS page) and card
  // (file, or URL in «card») are required; cc, bcc, params (object) or any other field: the
  // values of the other {placeholders}.
  app.post(['/:slug/mail', '/api/events/:slug/mail'], requireKey, (req, res, next) => cardUpload.any()(req, res, next), express.json(), express.urlencoded({ extended: false }), async (req, res) => {
    const event = await store.get(req.params.slug);
    if (!event.active) throw new HttpError(409, `L'evento «${event.slug}» è spento: accendilo per inviare email.`);
    if (!event.mailTemplate) throw new HttpError(409, 'Questo evento non ha un modello email: importalo dall\'admin.');
    const body = req.body || {};
    const to = readRecipients(body.to, 'to', { required: true });
    const cc = readRecipients(body.cc, 'cc');
    const bcc = readRecipients(body.bcc, 'bcc');
    const subjectText = String(body.subject ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!subjectText) throw new HttpError(400, 'Manca «subject»: l\'oggetto della mail.');
    const values = {};
    Object.entries(body).forEach(([key, value]) => {
      if (!RESERVED.has(key) && (typeof value !== 'object' || value === null)) values[key] = value;
    });
    if (body.params && typeof body.params === 'object') Object.assign(values, body.params);
    values.userid = String(values.userid ?? body.userId ?? '').trim().slice(0, 200);
    if (!values.userid) throw new HttpError(400, 'Manca «userid»: nome e cognome della persona.');
    values.link = readLink(values.link);
    const card = await readCard(req);
    const cardCid = `card.${randomUUID().slice(0, 8)}@photobooth`;
    values.card = `cid:${cardCid}`;

    const { dir, html, images } = await templateFiles(event.slug);
    const subject = fill(subjectText, values, { escape: false });
    const filled = fill(html, values);
    const cids = new Map(images.map((name, i) => [name, `img${i}.${randomUUID().slice(0, 8)}@photobooth`]));
    const finalHtml = swapImages(filled.text, images, (name) => `cid:${cids.get(name)}`);
    const used = images.filter((name) => finalHtml.includes(`cid:${cids.get(name)}`));
    const c = await loadConfig();
    const mailer = await transport();
    let info;
    try {
      info = await mailer.sendMail({
        from: sender(c),
        to,
        cc: cc.length ? cc : undefined,
        bcc: bcc.length ? bcc : undefined,
        replyTo: c.replyTo || undefined,
        subject: subject.text.replace(/\s+/g, ' ').trim() || event.name,
        html: finalHtml,
        text: htmlToText(finalHtml),
        attachments: [
          ...used.map((name) => ({ filename: name, path: path.join(dir, 'images', name), cid: cids.get(name) })),
          // the card twice: in the text (where the template has {card}) and as a file to download
          ...(finalHtml.includes(values.card) ? [{
            filename: `card${card.ext}`, content: card.content, contentType: card.contentType, cid: cardCid,
          }] : []),
          { filename: `card-${cleanName(values.userid).replace(/\s+/g, '-')}${card.ext}`, content: card.content, contentType: card.contentType },
        ],
      });
    } catch (error) {
      throw smtpError(error);
    }
    // privacy: no addresses or values, only how it went
    logger?.info('attivita', `Email inviata (${info.accepted?.length || 0} destinatari accettati, ${info.rejected?.length || 0} rifiutati)`, { event: event.slug });
    res.json({
      ok: true,
      messageId: info.messageId,
      accepted: info.accepted?.length || 0,
      rejected: info.rejected?.length || 0,
      // placeholders of the template with no value in the call: left empty
      missing: [...new Set([...subject.missing, ...filled.missing])],
    });
  });

  return { describe };
}
