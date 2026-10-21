// HTTPS for the console. Two ways, also together: locally the server has its own certificate
// (HTTPS_CERT, HTTPS_KEY in .env, e.g. made with mkcert), on AWS a proxy in front does HTTPS (load
// balancer, Caddy, nginx: TRUST_PROXY, so req.secure and req.ip come from X-Forwarded-*).
// When HTTPS is there the console works only on it: the page over http goes to https and a login
// over http is refused, so the password never crosses the network in clear. From this PC (loopback)
// http still works; the calls with the API key (n8n, print service) and the wall are not touched.
import { HttpError } from './store.js';

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/** TRUST_PROXY as Express wants it: «1» = one proxy in front, «true», or addresses / «loopback». */
export function parseTrustProxy(value) {
  const text = String(value ?? '').trim();
  if (!text || /^(0|false|no)$/i.test(text)) return undefined;
  if (/^(true|yes)$/i.test(text)) return true;
  return /^\d+$/.test(text) ? Number(text) : text;
}

/** options: { port: the HTTPS port browsers reach (443 behind a proxy), publicUrl } */
export function requireHttps({ port = 443, publicUrl = '' } = {}) {
  const base = /^https:\/\//i.test(publicUrl) ? publicUrl.replace(/\/+$/, '') : '';
  const target = (req) => base || `https://${req.hostname}${port === 443 ? '' : `:${port}`}`;
  return (req, res, next) => {
    if (req.secure || LOOPBACK.test(req.ip || '')) return next();
    if ((req.method === 'GET' || req.method === 'HEAD') && (req.path === '/' || req.path === '/admin')) {
      return res.redirect(301, `${target(req)}/admin`);
    }
    if (req.path === '/api/admin/login') {
      return next(new HttpError(403, `Accedi da ${target(req)}/admin: su http la password passerebbe in chiaro.`));
    }
    return next();
  };
}
