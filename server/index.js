// Entry point: loads .env (creating the API key and the console password on first run), finds a free port, prints the URLs,
// starts the print service (print/agent.js) next to the server.
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { format } from 'node:util';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { attachLive, createApp } from './app.js';
import { hashPassword } from './auth.js';
import { parseTrustProxy } from './https.js';
import { setEnvValue } from './env-file.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');

dotenv.config({ path: ENV_FILE, quiet: true });

/** Generates PHOTOBOOTH_API_KEY, appends it to .env and returns it. */
function ensureApiKey() {
  if (process.env.PHOTOBOOTH_API_KEY) return { key: process.env.PHOTOBOOTH_API_KEY, created: false };
  const key = randomBytes(24).toString('base64url');
  setEnvValue(ENV_FILE, 'PHOTOBOOTH_API_KEY', key);
  return { key, created: true };
}

/** Console password: if .env has none, generates one and saves only its hash (ADMIN_PASSWORD_HASH). */
function ensureAdminPassword() {
  if (process.env.ADMIN_PASSWORD_HASH) return { hash: process.env.ADMIN_PASSWORD_HASH, password: '' };
  const password = randomBytes(12).toString('base64url');
  setEnvValue(ENV_FILE, 'ADMIN_PASSWORD_HASH', hashPassword(password));
  return { hash: process.env.ADMIN_PASSWORD_HASH, password };
}

function isFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

async function findPort(start, host) {
  for (let port = start; port < start + 100; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isFree(port, host)) return port;
  }
  throw new Error(`Nessuna porta libera tra ${start} e ${start + 99}.`);
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => iface.address);
}

const { key, created } = ensureApiKey();
const admin = ensureAdminPassword();
const adminUser = (process.env.ADMIN_USER || '').trim() || 'admin';
// «::» listens on IPv6 and IPv4 together: «localhost» (IPv6 first on Windows) answers at once
const host = process.env.HOST || '::';
const requestedPort = Number(process.env.PORT) || 0;
// port 80 by default; if it is taken, the first free one from 4700
let port = requestedPort;
if (!port) port = await isFree(80, host) ? 80 : await findPort(4700, host);
const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB) || 500;
// the address in links and n8n examples: PUBLIC_URL, else localhost with the port in use
const localUrl = `http://localhost:${port}`;
const publicUrl = ((process.env.PUBLIC_URL || '').trim() || localUrl).replace(/\/+$/, '');
const placeholder = process.env.WALL_PLACEHOLDER ?? 'https://www.youtube.com/watch?v=LXb3EKWsInQ';
const showcase = Number(process.env.WALL_SHOWCASE_SECONDS);
const showcaseSeconds = Number.isFinite(showcase) && process.env.WALL_SHOWCASE_SECONDS !== '' ? showcase : 8;

const retention = Number(process.env.LOG_RETENTION_DAYS);
const logRetentionDays = Number.isFinite(retention) && retention > 0 ? retention : 2;

// HTTPS here (certificate in .env) and/or done by a proxy in front (AWS): the console then requires it
const certFile = (process.env.HTTPS_CERT || '').trim();
const keyFile = (process.env.HTTPS_KEY || '').trim();
let tls = null;
if (certFile || keyFile) {
  try {
    tls = { cert: readFileSync(path.resolve(ROOT, certFile)), key: readFileSync(path.resolve(ROOT, keyFile)) };
  } catch (error) {
    console.error(`HTTPS_CERT / HTTPS_KEY in .env: impossibile leggere il certificato (${error.message}).`);
    process.exit(1);
  }
}
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
// port 443 by default; if it is taken, the first free one from 4743
let httpsPort = Number(process.env.HTTPS_PORT) || 0;
if (tls && !httpsPort) httpsPort = await isFree(443, host) ? 443 : await findPort(4743, host);
let httpsInfo = null;
if (tls) httpsInfo = { port: httpsPort };
else if (trustProxy !== undefined) httpsInfo = { port: 443 };

const {
  app, hub, store, logger,
} = createApp({
  dataDir, apiKey: key, adminUser, adminPasswordHash: admin.hash, maxUploadMb, placeholder, publicUrl, showcaseSeconds, logRetentionDays,
  trustProxy, https: httpsInfo,
});

// what the server and the print service write on the console goes in the log too (tab Log of
// the admin), with the API key and a new console password masked
const secrets = [key, admin.password].filter(Boolean);
for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
  const write = console[method].bind(console);
  console[method] = (...args) => {
    write(...args);
    const text = secrets.reduce((out, secret) => out.split(secret).join('***'), format(...args)).trim();
    if (!text) return;
    const agentLine = /^\[stampa\] ?/.exec(text);
    logger.add({ level, type: agentLine ? 'stampa' : 'sistema', msg: agentLine ? text.slice(agentLine[0].length) : text });
  };
}
const secureServer = tls ? https.createServer(tls, app) : null;
const secureReady = secureServer ? new Promise((resolve) => { secureServer.listen(httpsPort, host, resolve); }) : null;

const server = app.listen(port, host, async () => {
  await secureReady;
  const httpUrls = [localUrl, ...lanAddresses().map((ip) => `http://${ip}:${port}`)];
  const httpsSuffix = httpsPort === 443 ? '' : `:${httpsPort}`;
  const httpsUrls = tls ? ['localhost', ...lanAddresses()].map((h) => `https://${h}${httpsSuffix}`) : [];
  const urls = [...new Set([publicUrl, ...httpUrls])];
  // the console only on https when there is one (from this PC http still works)
  const adminUrls = httpsInfo
    ? [...new Set([...(/^https:/.test(publicUrl) ? [publicUrl] : []), ...httpsUrls, localUrl])]
    : urls;
  console.log('Photobooth avviato.');
  if (!requestedPort && port !== 80) console.log('  (porta 80 occupata: uso la prima libera da 4700)');
  if (tls && !process.env.HTTPS_PORT && httpsPort !== 443) console.log('  (porta 443 occupata: HTTPS sulla prima libera da 4743)');
  console.log(`  Admin:  ${adminUrls.map((u) => `${u}/admin`).join('\n          ')}`);
  if (httpsInfo) console.log('          (console solo su https; da questo PC anche su http)');
  console.log(`  Wall:   ${urls[0]}/<evento>/wall`);
  console.log(`  Stampe: ${urls[0]}/<evento>/print`);
  console.log(`  Dati:   ${dataDir}`);
  if (created) {
    console.log('\nChiave API generata e salvata in .env (non verrà più mostrata):');
    console.log(`  ${key}\n`);
  }
  if (admin.password) {
    console.log('\nPassword della console generata (in .env solo il suo hash, non verrà più mostrata):');
    console.log(`  utente ${adminUser}, password ${admin.password}`);
    console.log('  Per cambiarla: npm run set-password\n');
  }
  console.log('Ctrl+C per fermare.');
  startPrintAgent(localUrl);
});

// The print service starts together with the server (one command), as a child process: a problem
// there never stops the server. PRINT_AGENT=0 when it runs on another PC (server on AWS).
const AGENT_FILE = path.join(ROOT, 'print', 'agent.js');
let agent = null;
let closing = false;
function startPrintAgent(serverUrl) {
  if (/^(0|false|no)$/i.test(String(process.env.PRINT_AGENT || '').trim())) {
    console.log('Servizio di stampa non avviato qui (PRINT_AGENT=0): avvialo sul PC con la stampante con npm run print.');
    return;
  }
  const startedAt = Date.now();
  agent = spawn(process.execPath, [AGENT_FILE], {
    cwd: ROOT,
    env: { ...process.env, PRINT_SERVER_URL: serverUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (stream, write) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      lines.forEach((line) => write(`[stampa] ${line}`));
    });
  };
  prefix(agent.stdout, console.log);
  prefix(agent.stderr, console.error);
  agent.on('exit', (code) => {
    agent = null;
    if (closing) return;
    // stopped at once = configuration to fix (key, printer name): no restart loop
    if (Date.now() - startedAt < 5000) {
      console.error(`[stampa] servizio fermato (codice ${code}): correggi .env e riavvia, il server resta acceso.`);
      return;
    }
    console.error(`[stampa] servizio terminato (codice ${code}): riparte tra 5 secondi.`);
    setTimeout(() => { if (!closing) startPrintAgent(serverUrl); }, 5000).unref();
  });
}

attachLive(server, { store, hub, logger });
if (secureServer) attachLive(secureServer, { store, hub, logger });

for (const s of [server, secureServer].filter(Boolean)) {
  s.on('error', (error) => {
    console.error(`Impossibile avviare il server: ${error.message}`);
    process.exit(1);
  });
}

function shutdown() {
  if (closing) process.exit(1);
  closing = true;
  console.log('\nChiusura in corso…');
  agent?.kill();
  hub.closeAll();
  secureServer?.close();
  secureServer?.closeAllConnections?.();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
