// Console login for the tests: createApp({ ..., adminPasswordHash: ADMIN_HASH }), then
// adminCookie(base) gives the Cookie header of a logged-in session.
import { hashPassword } from '../../server/auth.js';

export const ADMIN_USER = 'admin';
export const ADMIN_PASSWORD = 'password-di-prova';
export const ADMIN_HASH = hashPassword(ADMIN_PASSWORD);

export async function adminCookie(base, { user = ADMIN_USER, password = ADMIN_PASSWORD } = {}) {
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, password }),
  });
  if (!response.ok) throw new Error(`login ${response.status}`);
  return response.headers.get('set-cookie').split(';')[0];
}
