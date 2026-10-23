// Two separate accesses. The API key (PHOTOBOOTH_API_KEY, header x-api-key or Authorization:
// Bearer) is for n8n and the print agent: uploads, mails, print queue, events and clean-up. The
// admin console logs in with user and password (ADMIN_USER, ADMIN_PASSWORD_HASH in .env) and gets
// a session cookie: it can do everything, and alone the settings (SMTP account, templates, log).
// The key never opens the console, and the console keeps no key in the browser.
import {
  randomBytes, scryptSync, timingSafeEqual,
} from 'node:crypto';
import express from 'express';
import { HttpError } from './store.js';

const COOKIE = 'photobooth_session';
const MAX_FAILURES = 5;
const BLOCK_MS = 5 * 60 * 1000;

export function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

/** «scrypt:<salt>:<hash>» (base64url), what goes in ADMIN_PASSWORD_HASH. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('base64url')}:${scryptSync(String(password), salt, 32).toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const given = scryptSync(String(password || ''), Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(given, expected);
}

function readCookie(req, name) {
  const pair = (req.get('cookie') || '').split(';').map((part) => part.trim().split('='))
    .find(([key]) => key === name);
  return pair ? decodeURIComponent(pair.slice(1).join('=')) : '';
}

/**
 * options: { apiKey, adminUser, adminPasswordHash, sessionHours = 12, logger, now = Date.now }
 * Returns { requireKey (API key or console), requireAdmin (console only), routes(app) }.
 */
export function createAuth({
  apiKey, adminUser = 'admin', adminPasswordHash, sessionHours = 12, logger, now = Date.now,
}) {
  if (!apiKey) throw new Error('apiKey mancante');
  if (!adminPasswordHash) throw new Error('adminPasswordHash mancante');
  const sessionMs = sessionHours * 60 * 60 * 1000;
  // in memory: a restart asks for the login again
  const sessions = new Map();
  const failures = new Map();

  function session(req) {
    const token = readCookie(req, COOKIE);
    const found = token && sessions.get(token);
    if (!found) return null;
    if (found.expires < now()) {
      sessions.delete(token);
      return null;
    }
    // sliding: the session lasts while the console is used
    found.expires = now() + sessionMs;
    return { token, ...found };
  }

  // the session cookie is SameSite=Strict; the Origin check also stops a write sent from another site
  function sameOrigin(req) {
    const origin = req.get('origin');
    if (!origin || req.method === 'GET' || req.method === 'HEAD') return true;
    try {
      return new URL(origin).host === req.get('host');
    } catch {
      return false;
    }
  }

  const requireAdmin = (req, res, next) => {
    if (!session(req)) return next(new HttpError(401, 'Accesso alla console richiesto.'));
    if (!sameOrigin(req)) return next(new HttpError(403, 'Richiesta da un altro sito.'));
    return next();
  };

  const requireKey = (req, res, next) => {
    const header = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

    console.log("KEY FROM HEADER:", header);
    console.log("API KEY FROM ENV:", apiKey);

    if (header) {
      if (!sameSecret(header, apiKey)) return next(new HttpError(401, 'Chiave API mancante o non valida.'));
      return next();
    }
    if (session(req)) return requireAdmin(req, res, next);
    return next(new HttpError(401, 'Chiave API mancante o non valida.'));
  };

  const cookie = (req, token, maxAgeS) => [
    `${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeS}`,
    ...(req.secure ? ['Secure'] : []),
  ].join('; ');

  function routes(app) {
    app.post('/api/admin/login', express.json(), (req, res) => {
      const ip = (req.ip || '').replace(/^::ffff:/, '');
      const blocked = failures.get(ip);
      if (blocked?.until > now()) {
        const minutes = Math.ceil((blocked.until - now()) / 60000);
        throw new HttpError(429, `Troppi tentativi sbagliati: riprova tra ${minutes} min.`);
      }
      const { user, password } = req.body || {};
      const ok = sameSecret(String(user || '').trim(), adminUser) && verifyPassword(password, adminPasswordHash);
      if (!ok) {
        // the count starts again after a block or 5 minutes without errors
        const recent = blocked && !blocked.until && blocked.last > now() - BLOCK_MS;
        const count = (recent ? blocked.count : 0) + 1;
        failures.set(ip, { count, last: now(), until: count >= MAX_FAILURES ? now() + BLOCK_MS : 0 });
        if (count >= MAX_FAILURES) logger?.warn('attivita', `Console bloccata per 5 minuti dopo ${count} accessi sbagliati`, { ip });
        throw new HttpError(401, 'Utente o password non validi.');
      }
      failures.delete(ip);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { user: adminUser, expires: now() + sessionMs });
      res.set('Set-Cookie', cookie(req, token, Math.round(sessionMs / 1000)));
      res.json({ user: adminUser });
    });

    app.post('/api/admin/logout', (req, res) => {
      const found = session(req);
      if (found) sessions.delete(found.token);
      res.set('Set-Cookie', cookie(req, '', 0));
      res.status(204).end();
    });

    app.get('/api/admin/session', (req, res) => {
      const found = session(req);
      if (!found) throw new HttpError(401, 'Accesso alla console richiesto.');
      res.json({ user: found.user });
    });

    // for «Copia» in the n8n calls of the console
    app.get('/api/admin/api-key', requireAdmin, (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ key: apiKey });
    });
  }

  return { requireKey, requireAdmin, routes };
}
