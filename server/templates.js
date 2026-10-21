// Print template of an event, managed from the admin at runtime: the PSD and its fonts are uploaded
// to the server, checked with the same code the print agent uses (print/compose.js) and shown as a
// preview with a sample photo and sample values. The print agent downloads them from here (it finds
// the version in each queue item) and keeps them in a cache, so a new template is used from the
// next print on. Without one, the agent uses the PSD in its own templates folder.
//
// data/templates/<event>/<version>.psd, data/templates/<event>/fonts/*.otf|ttf, preview.jpg
import path from 'node:path';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
import { HttpError } from './store.js';
import { compose, loadTemplate } from '../print/compose.js';

const FONT_FILE = /\.(otf|ttf)$/i;
const SAMPLE_VALUES = {
  name: 'NOME COGNOME', total: '87', technique: '90', fun: '95', style: '78', performance: '85',
};

const cleanName = (name) => path.basename(String(name || '')).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';

/** A stand-in for the photo in the preview: soft gradient with «FOTO» in the middle. */
function samplePhoto() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7f8ea3"/><stop offset="1" stop-color="#3b4558"/></linearGradient></defs>
    <rect width="1200" height="1200" fill="url(#g)"/>
    <text x="600" y="640" font-family="Arial" font-size="140" font-weight="700" fill="#ffffff" fill-opacity=".55" text-anchor="middle">FOTO</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** What the admin shows and the agent needs to know about the template of an event. */
export function publicTemplate(event) {
  const t = event.template;
  if (!t) return null;
  return {
    version: t.version,
    originalName: t.originalName,
    size: t.size,
    uploadedAt: t.uploadedAt,
    fonts: t.fonts || [],
    info: t.info || null,
    previewUrl: `/api/events/${event.slug}/template/preview?v=${encodeURIComponent(t.version)}`,
  };
}

/** For the print agent, in each queue item: where to download the PSD and the fonts. */
export function agentTemplate(event) {
  const t = event.template;
  if (!t) return null;
  return {
    version: t.version,
    fileUrl: `/api/print/templates/${event.slug}/${encodeURIComponent(t.version)}`,
    fonts: (t.fonts || []).map((font) => ({
      name: font.file,
      url: `/api/print/templates/${event.slug}/fonts/${encodeURIComponent(font.file)}`,
    })),
  };
}

export function templateRoutes(app, {
  store, requireKey, requireAdmin, maxBytes,
}) {
  const upload = multer({
    storage: multer.diskStorage({
      destination: async (req, file, cb) => {
        const dir = path.join(store.templatesDir(req.params.slug), 'incoming');
        await mkdir(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: maxBytes, files: 20 },
    fileFilter: (req, file, cb) => {
      if (/\.psd$/i.test(file.originalname) || FONT_FILE.test(file.originalname)) cb(null, true);
      else cb(new HttpError(415, `«${file.originalname}» non è un PSD né un font .otf/.ttf.`));
    },
  });
  const receive = (req, res) => new Promise((resolve, reject) => {
    upload.any()(req, res, (error) => (error ? reject(error) : resolve(req.files || [])));
  });

  /** Reads the PSD with its fonts and renders the preview; throws a 400 if it cannot be used. */
  async function analyze(slug, template) {
    const dir = store.templatesDir(slug);
    let tpl;
    try {
      tpl = await loadTemplate(path.join(dir, `${template.version}.psd`), { fontsDir: path.join(dir, 'fonts') });
    } catch (error) {
      throw new HttpError(400, `Il PSD non si può usare: ${error.message}`);
    }
    const preview = await compose(await samplePhoto(), tpl, SAMPLE_VALUES);
    await writeFile(path.join(dir, 'preview.jpg'), await sharp(preview).resize(900, 900, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer());
    return {
      width: tpl.width,
      height: tpl.height,
      dpi: tpl.dpi,
      mode: tpl.mode,
      photoLayer: tpl.photoLayer,
      texts: tpl.texts.map((t) => ({
        layer: t.layerName, key: t.key, font: t.fontName, found: t.fontFound,
      })),
      warnings: tpl.warnings,
    };
  }

  /** Moves the uploaded fonts into the fonts folder; returns the list of the template's fonts. */
  async function storeFonts(slug, files, current = []) {
    const dir = path.join(store.templatesDir(slug), 'fonts');
    await mkdir(dir, { recursive: true });
    const fonts = current.filter((f) => !files.some((file) => cleanName(file.originalname) === f.file));
    for (const file of files) {
      const name = cleanName(file.originalname);
      // eslint-disable-next-line no-await-in-loop
      await rename(file.path, path.join(dir, name));
      fonts.push({ file: name, size: file.size });
    }
    return fonts;
  }

  const cleanIncoming = (slug) => rm(path.join(store.templatesDir(slug), 'incoming'), { recursive: true, force: true });

  // a new PSD (field of any name), optionally with fonts in the same upload
  app.post('/api/events/:slug/template', requireAdmin, async (req, res) => {
    const event = await store.get(req.params.slug);
    const files = await receive(req, res);
    try {
      const psds = files.filter((f) => /\.psd$/i.test(f.originalname));
      if (psds.length !== 1) throw new HttpError(400, 'Carica un solo file .psd (più, se servono, i font .otf/.ttf).');
      const [psd] = psds;
      const dir = store.templatesDir(event.slug);
      const version = `${Date.now()}-${randomUUID().slice(0, 6)}`;
      await rename(psd.path, path.join(dir, `${version}.psd`));
      const template = {
        version,
        originalName: cleanName(psd.originalname),
        size: psd.size,
        uploadedAt: new Date().toISOString(),
        fonts: await storeFonts(event.slug, files.filter((f) => FONT_FILE.test(f.originalname)), event.template?.fonts),
      };
      try {
        template.info = await analyze(event.slug, template);
      } catch (error) {
        await rm(path.join(dir, `${version}.psd`), { force: true });
        throw error;
      }
      // only the current version stays on disk
      const old = (await readdir(dir)).filter((name) => name.endsWith('.psd') && name !== `${version}.psd`);
      await Promise.all(old.map((name) => rm(path.join(dir, name), { force: true })));
      const updated = await store.update(event.slug, { template });
      res.status(201).json(publicTemplate(updated));
    } finally {
      await cleanIncoming(event.slug);
    }
  });

  // fonts for the current PSD; the template is checked again (missing fonts) and gets a new version,
  // so the print agent downloads it again
  app.post('/api/events/:slug/template/fonts', requireAdmin, async (req, res) => {
    const event = await store.get(req.params.slug);
    const files = await receive(req, res);
    try {
      if (!event.template) throw new HttpError(409, 'Carica prima il PSD del template.');
      const fonts = files.filter((f) => FONT_FILE.test(f.originalname));
      if (!fonts.length) throw new HttpError(400, 'Nessun font .otf/.ttf nella richiesta.');
      const template = { ...event.template, fonts: await storeFonts(event.slug, fonts, event.template.fonts) };
      template.info = await analyze(event.slug, template);
      const updated = await store.update(event.slug, { template: await bumpVersion(event.slug, template) });
      res.status(201).json(publicTemplate(updated));
    } finally {
      await cleanIncoming(event.slug);
    }
  });

  app.delete('/api/events/:slug/template/fonts/:file', requireAdmin, async (req, res) => {
    const event = await store.get(req.params.slug);
    if (!event.template) throw new HttpError(404, 'Nessun template per questo evento.');
    const name = cleanName(req.params.file);
    await rm(path.join(store.templatesDir(event.slug), 'fonts', name), { force: true });
    const template = { ...event.template, fonts: event.template.fonts.filter((f) => f.file !== name) };
    template.info = await analyze(event.slug, template);
    const updated = await store.update(event.slug, { template: await bumpVersion(event.slug, template) });
    res.json(publicTemplate(updated));
  });

  /** A new version name for the same PSD (renamed on disk), so the agent refreshes its cache. */
  async function bumpVersion(slug, template) {
    const dir = store.templatesDir(slug);
    const version = `${Date.now()}-${randomUUID().slice(0, 6)}`;
    await rename(path.join(dir, `${template.version}.psd`), path.join(dir, `${version}.psd`));
    return { ...template, version };
  }

  // the event goes back to the template of the print PC (its templates folder)
  app.delete('/api/events/:slug/template', requireAdmin, async (req, res) => {
    const event = await store.get(req.params.slug);
    await rm(store.templatesDir(event.slug), { recursive: true, force: true });
    await store.update(event.slug, { template: null });
    res.status(204).end();
  });

  app.get('/api/events/:slug/template/preview', requireAdmin, async (req, res) => {
    const event = await store.get(req.params.slug);
    if (!event.template) throw new HttpError(404, 'Nessun template per questo evento.');
    res.sendFile(path.join(store.templatesDir(event.slug), 'preview.jpg'));
  });

  // --- downloads for the print agent ---------------------------------------------------------
  app.get('/api/print/templates/:slug/fonts/:file', requireKey, async (req, res) => {
    const event = await store.get(req.params.slug);
    const name = cleanName(req.params.file);
    if (!event.template?.fonts?.some((f) => f.file === name)) throw new HttpError(404, 'Font non trovato.');
    res.sendFile(path.join(store.templatesDir(event.slug), 'fonts', name));
  });

  app.get('/api/print/templates/:slug/:version', requireKey, async (req, res) => {
    const event = await store.get(req.params.slug);
    if (event.template?.version !== req.params.version) throw new HttpError(404, 'Versione del template non più disponibile.');
    res.sendFile(path.join(store.templatesDir(event.slug), `${event.template.version}.psd`));
  });
}
