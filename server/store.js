// Events with their videos and photos to print, persisted in data/events.json;
// video files in data/media/<event>/ (public), photos in data/photos/<event>/ (behind the key),
// print previews composed by the print agent in data/previews/<event>/ (public), print template
// (PSD and fonts) uploaded from the admin in data/templates/<event>/.
import path from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// first path segments used by the server itself: an event cannot be called like them
export const RESERVED_SLUGS = ['admin', 'api', 'static', 'media', 'previews', 'wall', 'print', 'mail', 'favicon-ico'];

export function toSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// On Windows antivirus/indexers briefly lock a just-written file, so rename fails with EPERM/EBUSY.
async function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

export function createStore(dataDir) {
  const file = path.join(dataDir, 'events.json');
  const mediaRoot = path.join(dataDir, 'media');
  const photosRoot = path.join(dataDir, 'photos');
  const previewsRoot = path.join(dataDir, 'previews');
  const templatesRoot = path.join(dataDir, 'templates');
  let events = null;
  // writes are serialised so concurrent uploads never lose an update
  let queue = Promise.resolve();

  async function load() {
    if (events) return events;
    try {
      events = JSON.parse(await readFile(file, 'utf8')).events || [];
      events.forEach((event) => { event.photos ||= []; });
    } catch {
      events = [];
    }
    return events;
  }

  function persist() {
    const run = queue.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ events }, null, 2)}\n`, 'utf8');
      await renameRetrying(tmp, file);
    });
    // a failed write must not block the ones queued after it
    queue = run.catch(() => {});
    return run;
  }

  async function get(slug) {
    const event = (await load()).find((e) => e.slug === slug);
    if (!event) throw new HttpError(404, `Evento «${slug}» non trovato.`);
    return event;
  }

  return {
    mediaRoot,
    mediaDir: (slug) => path.join(mediaRoot, slug),
    photosDir: (slug) => path.join(photosRoot, slug),
    previewsRoot,
    previewsDir: (slug) => path.join(previewsRoot, slug),
    templatesDir: (slug) => path.join(templatesRoot, slug),
    // uploads whose event is known only after reading the file's fields (see event-param.js)
    incomingDir: path.join(dataDir, 'incoming'),

    async list() {
      return load();
    },

    get,

    async create({ name, slug }) {
      const cleanName = String(name || '').trim();
      if (!cleanName) throw new HttpError(400, 'Il nome dell\'evento è obbligatorio.');
      const id = slug ? toSlug(slug) : toSlug(cleanName);
      if (!SLUG.test(id)) throw new HttpError(400, 'Identificativo evento non valido.');
      if (RESERVED_SLUGS.includes(id)) throw new HttpError(400, `«${id}» è un nome riservato: scegline un altro.`);
      const list = await load();
      if (list.some((e) => e.slug === id)) throw new HttpError(409, `Esiste già un evento «${id}».`);
      const event = {
        slug: id, name: cleanName, active: false, createdAt: new Date().toISOString(), videos: [], photos: [],
      };
      list.push(event);
      await mkdir(path.join(mediaRoot, id), { recursive: true });
      await persist();
      return event;
    },

    async update(slug, changes) {
      const event = await get(slug);
      if (typeof changes.name === 'string' && changes.name.trim()) event.name = changes.name.trim();
      if (typeof changes.active === 'boolean') event.active = changes.active;
      // already validated by the caller (server/print-settings.js)
      if (changes.printSettings) event.printSettings = changes.printSettings;
      // the print template uploaded from the admin (server/templates.js); null removes it
      if (changes.template !== undefined) event.template = changes.template;
      if (typeof changes.showPlaceholder === 'boolean') event.showPlaceholder = changes.showPlaceholder;
      // the mail template imported from the admin (server/mail.js); null removes it
      if (changes.mailTemplate !== undefined) event.mailTemplate = changes.mailTemplate;
      await persist();
      return event;
    },

    async remove(slug) {
      const list = await load();
      const index = list.findIndex((e) => e.slug === slug);
      if (index === -1) throw new HttpError(404, `Evento «${slug}» non trovato.`);
      list.splice(index, 1);
      await persist();
      await rm(path.join(mediaRoot, slug), { recursive: true, force: true });
      await rm(path.join(photosRoot, slug), { recursive: true, force: true });
      await rm(path.join(previewsRoot, slug), { recursive: true, force: true });
      await rm(path.join(templatesRoot, slug), { recursive: true, force: true });
      await rm(path.join(dataDir, 'mail', slug), { recursive: true, force: true });
    },

    async addVideo(slug, video) {
      const event = await get(slug);
      const entry = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        ...video,
      };
      event.videos.push(entry);
      await persist();
      return entry;
    },

    async removeVideo(slug, id) {
      const event = await get(slug);
      const index = event.videos.findIndex((v) => v.id === id);
      if (index === -1) throw new HttpError(404, 'Video non trovato.');
      const [video] = event.videos.splice(index, 1);
      await persist();
      if (video.file) await rm(path.join(mediaRoot, slug, video.file), { force: true });
      return video;
    },

    /** Removes every video of the event with its file; returns the removed ones. */
    async clearVideos(slug) {
      const event = await get(slug);
      const removed = event.videos.splice(0);
      await persist();
      await Promise.all(removed.filter((v) => v.file).map((v) => rm(path.join(mediaRoot, slug, v.file), { force: true })));
      return removed;
    },

    /** Removes every photo of the event, with its file and preview; returns the removed ones. */
    async clearPhotos(slug) {
      const event = await get(slug);
      const removed = event.photos.splice(0);
      await persist();
      await Promise.all(removed.flatMap((p) => [
        rm(path.join(photosRoot, slug, p.file), { force: true }),
        p.cardFile ? rm(path.join(photosRoot, slug, p.cardFile), { force: true }) : null,
        p.previewFile ? rm(path.join(previewsRoot, slug, p.previewFile), { force: true }) : null,
      ]));
      return removed;
    },

    // --- photos to print: status queued -> printing -> printed | saved | failed ----------
    async addPhoto(slug, photo) {
      const event = await get(slug);
      const entry = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        status: 'queued',
        prints: 0,
        ...photo,
      };
      event.photos.push(entry);
      await persist();
      return entry;
    },

    /** Finds a photo in any event: { event, photo }. */
    async findPhoto(id) {
      for (const event of await load()) {
        const photo = event.photos.find((p) => p.id === id);
        if (photo) return { event, photo };
      }
      throw new HttpError(404, 'Foto non trovata.');
    },

    /** `check(photo)` runs right before the change, with no await in between: it may throw or edit. */
    async updatePhoto(id, changes, check) {
      const { event, photo } = await this.findPhoto(id);
      check?.(photo);
      Object.assign(photo, changes);
      await persist();
      return { event, photo };
    },

    async removePhoto(slug, id) {
      const event = await get(slug);
      const index = event.photos.findIndex((p) => p.id === id);
      if (index === -1) throw new HttpError(404, 'Foto non trovata.');
      const [photo] = event.photos.splice(index, 1);
      await persist();
      await rm(path.join(photosRoot, slug, photo.file), { force: true });
      if (photo.cardFile) await rm(path.join(photosRoot, slug, photo.cardFile), { force: true });
      if (photo.previewFile) await rm(path.join(previewsRoot, slug, photo.previewFile), { force: true });
      return photo;
    },
  };
}
