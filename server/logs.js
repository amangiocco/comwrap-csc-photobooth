// Activity log: HTTP calls (n8n, admin, print agent), server and print service messages, what
// happens to videos, photos and mails. One JSON line per entry in data/logs/photobooth-<day>.log
// (local day), kept for LOG_RETENTION_DAYS (2 by default): older entries and files are deleted.
// Shown in the admin (tab Log) and downloadable. Never holds API keys, request bodies or email
// addresses (the mail privacy rule): those are not written, and addresses in messages are masked.
import path from 'node:path';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';

const DAY = 24 * 60 * 60 * 1000;
const FILE = /^photobooth-(\d{4})-(\d{2})-(\d{2})\.log$/;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
export const LEVELS = ['info', 'warn', 'error'];
export const TYPES = {
  http: 'Chiamate HTTP', attivita: 'Attività', stampa: 'Servizio di stampa', sistema: 'Sistema',
};
const MAX_MEMORY = 200000;

const pad = (n, size = 2) => String(n).padStart(size, '0');
const dayOf = (time) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const clean = (value, max = 1000) => String(value ?? '').replace(EMAIL, '[email]').replace(/\s+/g, ' ').trim().slice(0, max);

/** «2026-10-05 14:03:21.120 WARN  http     [festa] POST /festa/wall 409 12 ms …» */
export function formatEntry(e) {
  const d = new Date(e.time);
  const when = `${dayOf(e.time)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const http = e.method ? ` ${e.method} ${e.path} ${e.status} ${e.ms} ms` : '';
  const extra = e.ip ? ` (${e.ip})` : '';
  return `${when} ${e.level.toUpperCase().padEnd(5)} ${e.type.padEnd(8)} ${e.event ? `[${e.event}] ` : ''}${e.msg}${http}${extra}`;
}

/**
 * options: { dir, retentionDays = 2, now = Date.now }
 * Returns { add, info, warn, error, query, prune, retentionDays }.
 */
export function createLogger({ dir, retentionDays = 2, now = Date.now } = {}) {
  const keepMs = retentionDays * DAY;
  let entries = [];
  let seq = 0;
  let disk = Boolean(dir);
  if (disk) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      disk = false;
    }
  }

  function prune() {
    const limit = now() - keepMs;
    if (entries.length && entries[0].time < limit) entries = entries.filter((e) => e.time >= limit);
    if (!disk) return;
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    names.forEach((name) => {
      const m = FILE.exec(name);
      // a day's file goes when its last entry (midnight) is older than the retention
      if (m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1).getTime() < limit) {
        try { unlinkSync(path.join(dir, name)); } catch { /* locked: next time */ }
      }
    });
  }

  // the entries of the last days, back from the files
  if (disk) {
    prune();
    readdirSync(dir).filter((name) => FILE.test(name)).sort().forEach((name) => {
      readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line) => {
        if (!line) return;
        try {
          const e = JSON.parse(line);
          if (e && typeof e.time === 'number') entries.push(e);
        } catch { /* half-written line */ }
      });
    });
    entries.sort((a, b) => a.time - b.time);
    prune();
    entries.forEach((e) => { e.id = ++seq; });
  }
  const timer = setInterval(prune, 60 * 60 * 1000);
  timer.unref?.();

  function add(fields) {
    const { id: _id, ...rest } = fields;
    const e = {
      time: now(),
      level: LEVELS.includes(fields.level) ? fields.level : 'info',
      type: TYPES[fields.type] ? fields.type : 'sistema',
      ...Object.fromEntries(Object.entries(rest).filter(([k, v]) => v !== undefined && v !== '' && !['level', 'type'].includes(k))),
    };
    e.msg = clean(e.msg);
    if (e.path) e.path = clean(e.path, 300);
    if (disk) {
      try {
        appendFileSync(path.join(dir, `photobooth-${dayOf(e.time)}.log`), `${JSON.stringify(e)}\n`, 'utf8');
      } catch { /* disk full or folder gone: the entry stays in memory */ }
    }
    e.id = ++seq;
    entries.push(e);
    if (entries.length > MAX_MEMORY) entries = entries.slice(-MAX_MEMORY / 2);
    else if (entries[0].time < e.time - keepMs) prune();
    return e;
  }

  /**
   * Filters: level (minimum), type, event, q (text), after / before (id), limit.
   * Returns { entries (newest first), more } — more: older entries beyond the limit.
   */
  function query({
    level, type, event, q, after, before, limit = 300,
  } = {}) {
    const min = Math.max(0, LEVELS.indexOf(level));
    const text = String(q || '').trim().toLowerCase();
    const max = Math.min(Math.max(Number(limit) || 300, 1), MAX_MEMORY);
    const limitTime = now() - keepMs;
    const found = [];
    let more = false;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const e = entries[i];
      if (after && e.id <= Number(after)) break;
      if (e.time < limitTime) break;
      if (before && e.id >= Number(before)) continue;
      if (LEVELS.indexOf(e.level) < min || (type && e.type !== type) || (event && e.event !== event)) continue;
      if (text && !formatEntry(e).toLowerCase().includes(text)) continue;
      if (found.length === max) {
        more = true;
        break;
      }
      found.push(e);
    }
    return { entries: found, more };
  }

  const at = (level) => (type, msg, extra = {}) => add({ ...extra, level, type, msg });
  return {
    add, info: at('info'), warn: at('warn'), error: at('error'), query, prune, retentionDays,
    close: () => clearInterval(timer),
  };
}

// --- HTTP calls -------------------------------------------------------------------------------
// what each call does, for the log (first match wins)
const ROUTES = [
  ['POST', /^\/(?:api\/videos|api\/events\/[^/]+\/videos|[^/]+\/wall)$/, 'Video da n8n'],
  ['POST', /^\/(?:api\/photos|api\/events\/[^/]+\/photos|[^/]+\/print)$/, 'Foto da stampare da n8n'],
  ['POST', /^\/(?:api\/mail|api\/events\/[^/]+\/mail|[^/]+\/mail)$/, 'Email da n8n'],
  ['POST', /^\/api\/events$/, 'Evento creato'],
  ['PATCH', /^\/api\/events(\/[^/]+)?$/, 'Evento modificato'],
  ['DELETE', /^\/api\/events(\/[^/]+)?$/, 'Evento eliminato'],
  ['DELETE', /^\/api\/(events\/[^/]+\/)?videos$/, 'Tutti i video eliminati'],
  ['DELETE', /^\/api\/(events\/[^/]+\/)?videos\/[^/]+$/, 'Video eliminato'],
  ['DELETE', /^\/api\/(events\/[^/]+\/)?photos$/, 'Tutte le foto eliminate'],
  ['DELETE', /^\/api\/(events\/[^/]+\/)?photos\/[^/]+$/, 'Foto eliminata'],
  ['POST', /^\/api\/(events\/[^/]+\/)?photos\/[^/]+\/reprint$/, 'Ristampa'],
  ['POST', /^\/api\/print\/photos\/[^/]+\/claim$/, 'Servizio di stampa: foto presa in carico'],
  ['POST', /^\/api\/print\/photos\/[^/]+\/preview$/, 'Servizio di stampa: anteprima'],
  ['POST', /^\/api\/print\/photos\/[^/]+\/result$/, 'Servizio di stampa: esito'],
  ['GET', /^\/api\/print\/photos\/[^/]+\/file$/, 'Servizio di stampa: foto scaricata'],
  ['GET', /^\/api\/print\/templates\//, 'Servizio di stampa: template scaricato'],
  ['POST', /^\/api\/events\/[^/]+\/template(\/fonts)?$/, 'Template di stampa caricato'],
  ['DELETE', /^\/api\/events\/[^/]+\/template(\/fonts\/[^/]+)?$/, 'Template di stampa rimosso'],
  ['POST', /^\/api\/events\/[^/]+\/mail-template$/, 'Modello email caricato'],
  ['DELETE', /^\/api\/events\/[^/]+\/mail-template(\/images\/[^/]+)?$/, 'Modello email rimosso'],
  ['PUT', /^\/api\/mail\/config$/, 'Account email salvato'],
  ['POST', /^\/api\/mail\/verify$/, 'Prova della connessione email'],
  ['POST', /^\/api\/mail\/test$/, 'Mail di prova'],
  ['GET', /^\/api\/logs\/download$/, 'Log scaricato'],
  ['POST', /^\/api\/admin\/login$/, 'Accesso alla console'],
  ['POST', /^\/api\/admin\/logout$/, 'Uscita dalla console'],
  ['GET', /^\/api\/admin\/api-key$/, 'Chiave API letta dalla console'],
  ['GET', /^\/admin$/, 'Pagina admin aperta'],
  ['GET', /^\/[^/]+\/wall$/, 'Wall aperto'],
  ['GET', /^\/[^/]+\/print$/, 'Anteprima stampe aperta'],
];
// reads repeated every few seconds (admin, wall without live, print agent): logged only on error
const QUIET = [
  /^\/static\//, /^\/media\//, /^\/favicon/, /^\/api\/health$/, /^\/api\/info$/, /^\/api\/events$/,
  /^\/api\/print\/queue$/, /^\/api\/events\/[^/]+\/(wall|prints|stream|live)$/, /^\/api\/(wall|prints)$/, /^\/api\/logs$/,
  /\/preview$/, /^\/api\/mail\/config$/, /^\/api\/admin\/session$/,
];
const SLUG = /^\/(?:api\/events\/|wall\/|print\/)?([a-z0-9][a-z0-9-]{0,62})(?:\/|$)/;
const NOT_EVENTS = new Set(['api', 'static', 'media', 'admin', 'favicon.ico']);

export function describeCall(method, pathname) {
  return ROUTES.find(([m, re]) => m === method && re.test(pathname))?.[2] || 'Chiamata';
}

/** Express middleware: one entry per call when the answer is sent. */
export function requestLogger(logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const pathname = req.path;
      const { statusCode: status } = res;
      const write = req.method !== 'GET' && req.method !== 'HEAD';
      if (!write && status < 400 && QUIET.some((re) => re.test(pathname))) return;
      if (req.method === 'OPTIONS') return;
      const m = /^\/api\/print\//.test(pathname) ? null : SLUG.exec(pathname);
      // the event named as a parameter of the call (event-param.js), else the one in the path
      const event = res.locals.event || (m && !NOT_EVENTS.has(m[1]) ? m[1] : undefined);
      logger.add({
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        type: 'http',
        event,
        msg: `${describeCall(req.method, pathname)}${res.locals.logError ? `: ${res.locals.logError}` : ''}`,
        method: req.method,
        path: pathname,
        status,
        ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
        ip: (req.ip || '').replace(/^::ffff:/, ''),
        bytes: Number(req.get('content-length')) || undefined,
        agent: /^\/api\/print\//.test(pathname) ? clean(req.get('x-print-agent'), 100) : undefined,
      });
    });
    next();
  };
}

// --- admin: GET /api/logs (JSON, filters as query) and /api/logs/download (file) ---------------
export function logRoutes(app, { logger, requireAdmin }) {
  const filters = (q) => ({
    level: q.level, type: q.type, event: q.event, q: q.q, after: q.after, before: q.before, limit: q.limit,
  });
  app.get('/api/logs', requireAdmin, (req, res) => {
    res.json({
      ...logger.query(filters(req.query)),
      retentionDays: logger.retentionDays,
      levels: LEVELS,
      types: TYPES,
    });
  });
  app.get('/api/logs/download', requireAdmin, (req, res) => {
    const { entries } = logger.query({ ...filters(req.query), limit: Infinity, after: undefined, before: undefined });
    const json = req.query.format === 'jsonl';
    const lines = entries.reverse().map((e) => {
      const { id, ...rest } = e;
      return json ? JSON.stringify(rest) : formatEntry(e);
    });
    const d = new Date();
    const stamp = `${dayOf(d.getTime()).replace(/-/g, '')}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    res.set('Content-Type', json ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8');
    res.attachment(`photobooth-log-${stamp}.${json ? 'jsonl' : 'log'}`);
    res.send(lines.length ? `${lines.join('\n')}\n` : '');
  });
}
