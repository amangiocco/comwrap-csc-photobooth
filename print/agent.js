// Print agent: runs on the PC with the printer. It polls the server's print queue, merges each photo
// into the PSD template, saves the result in PRINT_OUTPUT_DIR and sends it to PRINTER_NAME.
// The PC only makes outgoing calls, so it works with the server anywhere (LAN, AWS...).
// The printer is any printer installed in Windows, USB ones included (PRINTER_NAME).
//   npm run print              start the agent
//   npm run print -- --printers   list the printers of this PC
import path from 'node:path';
import os from 'node:os';
import {
  mkdir, mkdtemp, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { compose, loadTemplate } from './compose.js';
import { layoutSheet } from './layout.js';
import { DEFAULT_PRINT_SETTINGS } from '../server/print-settings.js';

// longest side of the preview sent to the server for the print page
const PREVIEW_SIZE = 1200;

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A PDF page exactly as large as the picture, so the printer gets its real size. */
export async function toPdf(jpeg) {
  const { width, height, density } = await sharp(jpeg).metadata();
  const dpi = density || 300;
  const doc = await PDFDocument.create();
  const image = await doc.embedJpg(jpeg);
  const page = doc.addPage([(width / dpi) * 72, (height / dpi) * 72]);
  page.drawImage(image, {
    x: 0, y: 0, width: page.getWidth(), height: page.getHeight(),
  });
  return Buffer.from(await doc.save());
}

// pdf-to-printer is CommonJS: its functions sit on the default export
const printerLib = async () => (await import('pdf-to-printer')).default;

async function windowsPrint(pdfFile, {
  printer, copies, paperSize, scale = 'fit',
}) {
  await (await printerLib()).print(pdfFile, {
    printer, copies, scale, ...(paperSize ? { paperSize } : {}),
  });
}

/** The template file: `templatePath` itself, or the newest .psd if it is a folder; null if none. */
async function findTemplate(templatePath) {
  let info;
  try {
    info = await stat(templatePath);
  } catch {
    return null;
  }
  if (!info.isDirectory()) return { file: templatePath, info };
  const found = await Promise.all((await readdir(templatePath))
    .filter((name) => name.toLowerCase().endsWith('.psd'))
    .map(async (name) => ({ file: path.join(templatePath, name), info: await stat(path.join(templatePath, name)) })));
  return found.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)[0] || null;
}

/** Windows printers with their port, to tell the USB ones apart. */
async function printerPorts() {
  try {
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command',
      'Get-Printer | Select-Object Name, PortName | ConvertTo-Json -Compress']);
    return new Map([].concat(JSON.parse(stdout)).map((p) => [p.Name, p.PortName || '']));
  } catch {
    return new Map();
  }
}

/**
 * Texts for the template placeholders: {name} is the userid as sent (capitals included), the
 * scores have at least two digits (as «01»).
 */
export function printValues(item) {
  const values = { name: String(item.userId || '') };
  Object.entries(item.scores || {}).forEach(([key, value]) => {
    values[key.toLowerCase()] = String(value).padStart(2, '0');
  });
  return values;
}

const safe = (text) => String(text || '').normalize('NFD').replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/**
 * options: { server, apiKey, printer, paperSize, templatePath, photoLayers, outputDir, keepFiles, cacheDir,
 *   print, log }
 * `templatePath`: the local template, for events with no template uploaded from the admin.
 * `cacheDir`: where the templates uploaded from the admin are downloaded.
 * `keepFiles`: also write every sheet (JPEG, and the PDF if printed) in `outputDir`.
 * `printer` empty: pictures are only saved. `print(pdfFile, { printer, copies, paperSize })` prints.
 * `templatePath`: a .psd file, or a folder where the newest .psd is used.
 */
export function createAgent({
  server, apiKey, printer = '', paperSize = '', templatePath, photoLayers, outputDir, keepFiles = false,
  cacheDir = path.join(os.tmpdir(), 'photobooth-templates'), print = windowsPrint, log = console.log,
}) {
  const base = server.replace(/\/+$/, '');
  const headers = { 'x-api-key': apiKey, 'x-print-agent': os.hostname(), 'x-printer': printer || '(solo anteprima)' };
  let template = null;
  let templateStamp = null;
  // templates uploaded from the admin, by event: { version, tpl }
  const remote = new Map();

  async function api(method, url, body) {
    const response = await fetch(base + url, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  }

  /**
   * The template uploaded for the item's event: downloaded with its fonts into the cache the first
   * time a version is seen, then kept in memory. Older versions of that event are removed.
   */
  async function eventTemplate(item) {
    const { version, fileUrl, fonts = [] } = item.template;
    const known = remote.get(item.slug);
    if (known?.version === version) return known.tpl;
    const eventDir = path.join(cacheDir, safe(item.slug) || 'evento');
    const dir = path.join(eventDir, safe(version));
    const fontsDir = path.join(dir, 'fonts');
    await mkdir(fontsDir, { recursive: true });
    const file = path.join(dir, 'template.psd');
    await writeFile(file, Buffer.from(await (await api('GET', fileUrl)).arrayBuffer()));
    for (const font of fonts) {
      // eslint-disable-next-line no-await-in-loop
      await writeFile(path.join(fontsDir, path.basename(font.name)), Buffer.from(await (await api('GET', font.url)).arrayBuffer()));
    }
    const tpl = await loadTemplate(file, { fontsDir, ...(photoLayers ? { photoLayers } : {}) });
    remote.set(item.slug, { version, tpl });
    const others = (await readdir(eventDir)).filter((name) => name !== safe(version));
    await Promise.all(others.map((name) => rm(path.join(eventDir, name), { recursive: true, force: true })));
    log(`Template dell'evento ${item.eventName} aggiornato dall'admin: ${tpl.width}×${tpl.height} px, ${fonts.length} font.`);
    tpl.warnings.forEach((warning) => log(`  attenzione: ${warning}`));
    return tpl;
  }

  /** The template of the local folder, read again whenever the PSD file changes; null if none. */
  async function currentTemplate() {
    const found = await findTemplate(templatePath);
    if (!found) {
      if (templateStamp !== 'missing') log(`Nessun template PSD in ${templatePath}: stampo la foto da sola.`);
      templateStamp = 'missing';
      template = null;
      return null;
    }
    const { file, info } = found;
    const stamp = `${file}:${info.mtimeMs}:${info.size}`;
    if (stamp !== templateStamp) {
      template = await loadTemplate(file, photoLayers ? { photoLayers } : {});
      templateStamp = stamp;
      const where = template.photoLayer ? `foto al posto del livello «${template.photoLayer}»` : 'foto sotto tutto il template';
      log(`Template caricato: ${path.basename(file)}, ${template.width}×${template.height} px a ${template.dpi} dpi, ${where}.`);
      template.warnings.forEach((warning) => log(`  attenzione: ${warning}`));
    }
    return template;
  }

  async function printOne(item) {
    try {
      await api('POST', `/api/print/photos/${item.id}/claim`);
    } catch (error) {
      if (error.status === 409 || error.status === 404) return null; // taken by someone else, or deleted
      throw error;
    }
    const label = `${item.eventName} · ${item.userId || item.id.slice(0, 8)}`;
    try {
      const photo = Buffer.from(await (await api('GET', item.fileUrl)).arrayBuffer());
      const tpl = item.template ? await eventTemplate(item) : await currentTemplate();
      const picture = tpl ? await compose(photo, tpl, printValues(item)) : await sharp(photo).rotate().jpeg({ quality: 95 }).toBuffer();
      // on the paper in use: size, orientation, margins, border (settings of the event)
      const settings = item.printSettings || DEFAULT_PRINT_SETTINGS;
      const sheet = await layoutSheet(picture, settings);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = [stamp, safe(item.userId), item.id.slice(0, 8)].filter(Boolean).join('-');
      // a copy of every sheet only if asked (PRINT_KEEP_FILES): the server keeps the original
      // photo for reprints and a light preview, so nothing else needs to stay on disk
      let jpegFile = null;
      const dir = path.join(outputDir, item.slug);
      if (keepFiles) {
        await mkdir(dir, { recursive: true });
        jpegFile = path.join(dir, `${name}.jpg`);
        await writeFile(jpegFile, sheet.jpeg);
      }
      // preview for the print page, small (it is only looked at on a screen), with how the sheet is
      // laid out; printing goes on even if it fails
      const preview = await sharp(sheet.jpeg)
        .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      await fetch(`${base}/api/print/photos/${item.id}/preview`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'image/jpeg',
          'x-print-layout': encodeURIComponent(JSON.stringify(sheet.layout)),
        },
        body: preview,
      }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
        .catch((error) => log(`Anteprima non inviata: ${error.message}`));
      if (printer) {
        // the PDF lives only while the printer takes it, unless the sheets are kept
        const pdfDir = keepFiles ? dir : await mkdtemp(path.join(os.tmpdir(), 'photobooth-print-'));
        const pdfFile = path.join(pdfDir, `${name}.pdf`);
        try {
          await writeFile(pdfFile, await toPdf(sheet.jpeg));
          await print(pdfFile, {
            printer,
            copies: item.copies || 1,
            paperSize: settings.driverPaper || paperSize,
            scale: settings.scale || 'fit',
          });
        } finally {
          if (!keepFiles) await rm(pdfDir, { recursive: true, force: true });
        }
        log(`Stampata: ${label} (${item.copies || 1} copie) su ${printer}`);
      } else {
        log(`Nessuna stampante configurata: ${label} solo in anteprima${jpegFile ? `, copia in ${jpegFile}` : ''}.`);
      }
      await api('POST', `/api/print/photos/${item.id}/result`, { ok: true, printed: Boolean(printer), output: jpegFile });
      return jpegFile || item.id;
    } catch (error) {
      log(`Errore con ${label}: ${error.message}`);
      await api('POST', `/api/print/photos/${item.id}/result`, { ok: false, error: error.message }).catch(() => {});
      return null;
    }
  }

  /** Prints everything in the queue, one at a time; returns the files kept (or the photo ids). */
  async function runOnce() {
    const queue = await (await api('GET', '/api/print/queue')).json();
    const done = [];
    for (const item of queue) {
      // eslint-disable-next-line no-await-in-loop
      const file = await printOne(item);
      if (file) done.push(file);
    }
    return done;
  }

  let stopped = false;
  async function start(pollSeconds = 3) {
    let offline = false;
    while (!stopped) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await runOnce();
        if (offline) log('Server di nuovo raggiungibile.');
        offline = false;
      } catch (error) {
        if (!offline) log(`Server non raggiungibile (${base}): ${error.message}. Riprovo…`);
        if (error.status === 401) log('La chiave API non è valida: controlla PHOTOBOOTH_API_KEY.');
        offline = true;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, pollSeconds * 1000); });
    }
  }

  return {
    runOnce, start, stop: () => { stopped = true; }, currentTemplate,
  };
}

async function main() {
  dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
  const printers = (await (await printerLib()).getPrinters()).map((p) => p.name);
  if (process.argv.includes('--printers')) {
    const ports = await printerPorts();
    console.log('Stampanti di questo PC (copia il nome in PRINTER_NAME nel file .env):');
    printers.forEach((name) => console.log(`  ${name}${/^USB/i.test(ports.get(name) || '') ? '   ← USB' : ''}`));
    return;
  }
  const apiKey = process.env.PHOTOBOOTH_API_KEY;
  if (!apiKey) {
    console.error('Manca PHOTOBOOTH_API_KEY nel file .env (la stessa chiave del server).');
    process.exit(1);
  }
  const printer = (process.env.PRINTER_NAME || '').trim();
  if (printer && !printers.includes(printer)) {
    console.error(`La stampante «${printer}» non esiste su questo PC. Quelle disponibili:`);
    printers.forEach((name) => console.error(`  ${name}`));
    process.exit(1);
  }
  const server = process.env.PRINT_SERVER_URL || 'http://localhost';
  const agent = createAgent({
    server,
    apiKey,
    printer,
    paperSize: (process.env.PRINT_PAPER_SIZE || '').trim(),
    templatePath: path.resolve(ROOT, process.env.PRINT_TEMPLATE || 'templates'),
    photoLayers: process.env.PRINT_PHOTO_LAYER ? process.env.PRINT_PHOTO_LAYER.split(',') : undefined,
    outputDir: path.resolve(ROOT, process.env.PRINT_OUTPUT_DIR || 'data/prints'),
    keepFiles: /^(1|true|si|sì|yes)$/i.test(String(process.env.PRINT_KEEP_FILES || '').trim()),
  });
  console.log('Servizio di stampa avviato.');
  console.log(`  Server:     ${server}`);
  console.log(`  Stampante:  ${printer || 'nessuna: le foto restano solo in anteprima'}`);
  console.log(`  Copie:      ${/^(1|true|si|sì|yes)$/i.test(String(process.env.PRINT_KEEP_FILES || '').trim()) ? `ogni foglio anche in ${path.resolve(ROOT, process.env.PRINT_OUTPUT_DIR || 'data/prints')}` : 'nessuna copia dei fogli su disco (PRINT_KEEP_FILES=1 per tenerle)'}`);
  await agent.currentTemplate().catch((error) => console.log(`  Template non leggibile: ${error.message}`));
  console.log('Ctrl+C per fermare.');
  process.on('SIGINT', () => process.exit(0));
  await agent.start(Number(process.env.PRINT_POLL_SECONDS) || 3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
