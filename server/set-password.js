// npm run set-password: sets the password of the admin console (ADMIN_PASSWORD_HASH in .env, only
// the hash is saved). Optional: --user <name> changes ADMIN_USER too. Restart the server after it.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';
import { setEnvValue } from './env-file.js';

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
const MIN_LENGTH = 10;

// one reader for both questions; what is typed is not shown
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
// eslint-disable-next-line no-underscore-dangle
rl._writeToOutput = (text) => { if (!muted) process.stdout.write(text); };
const lines = rl[Symbol.asyncIterator]();

/** Reads a line without showing what is typed. */
async function ask(question) {
  muted = false;
  process.stdout.write(question);
  muted = true;
  const { value = '' } = await lines.next();
  muted = false;
  process.stdout.write('\n');
  return value;
}

const args = process.argv.slice(2);
const userAt = args.indexOf('--user');
const user = userAt >= 0 ? String(args[userAt + 1] || '').trim() : '';
if (userAt >= 0 && !user) {
  console.error('Indica il nome dopo --user.');
  process.exit(1);
}

const password = await ask('Nuova password della console: ');
if (password.length < MIN_LENGTH) {
  console.error(`La password deve avere almeno ${MIN_LENGTH} caratteri.`);
  process.exit(1);
}
if (await ask('Ripetila: ') !== password) {
  console.error('Le due password non coincidono: niente è cambiato.');
  process.exit(1);
}
rl.close();
if (user) setEnvValue(ENV_FILE, 'ADMIN_USER', user);
setEnvValue(ENV_FILE, 'ADMIN_PASSWORD_HASH', hashPassword(password));
console.log(`Password salvata in .env${user ? ` (utente ${user})` : ''}. Riavvia il server per usarla.`);
