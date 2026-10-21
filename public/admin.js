// Admin page, in three tabs. Eventi: one accordion per event (on/off, print template and paper,
// mail template, n8n calls, videos, photos to print). Email: the SMTP account of the server.
// Stampa: print service status and the queue of each event. Log: activity and API calls of the
// server (kept 2 days), with filters and download. Login with user and password: the session is an
// HttpOnly cookie, no key is kept in the browser (the API key is asked to the server only to copy it).
const $ = (selector) => document.querySelector(selector);
const OPEN_STORAGE = 'photobooth.open';
const TAB_STORAGE = 'photobooth.tab';
let lastRender = '';

// open accordions, remembered in this browser (a convenience: works without storage too)
const openDetails = new Set((() => {
  try { return JSON.parse(localStorage.getItem(OPEN_STORAGE) || '[]'); } catch { return []; }
})());
function saveOpen() {
  try { localStorage.setItem(OPEN_STORAGE, JSON.stringify([...openDetails])); } catch { /* storage unavailable */ }
}

// --- tabs: Eventi, Email, Stampa, Log ---------------------------------------------------------------
function showTab(name) {
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const tab = tabs.find((t) => t.dataset.tab === name) || tabs[0];
  if (!tab) return;
  tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
  document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
  try { localStorage.setItem(TAB_STORAGE, tab.dataset.tab); } catch { /* storage unavailable */ }
  // after the script has run (loggedIn and the log code are defined further down)
  if (tab.dataset.tab === 'log') setTimeout(() => { if (loggedIn) loadLogs(); });
}
document.querySelector('.tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) showTab(tab.dataset.tab);
});
showTab((() => { try { return localStorage.getItem(TAB_STORAGE); } catch { return null; } })());

// the API key the console kept here before the login: not used any more
try { localStorage.removeItem('photobooth.apiKey'); } catch { /* storage unavailable */ }
let loggedIn = false;
// address of the server (PUBLIC_URL, else localhost with its port), used in links and n8n examples
let base = location.origin;
let infoLoaded = false;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let messageTimer;
function notify(text, isError = false) {
  const box = $('#message');
  box.textContent = text;
  box.classList.toggle('error', isError);
  box.classList.add('show');
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => box.classList.remove('show'), isError ? 5000 : 2500);
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  checkSession(response);
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Errore HTTP ${response.status}`);
  return data;
}

/** A 401 means the session expired (12 hours unused, or the server restarted): back to the login. */
function checkSession(response) {
  if (response.status !== 401) return;
  if (loggedIn) showLogin('Sessione scaduta: rientra.');
  throw new Error('Accesso alla console richiesto.');
}

function showLogin(reason) {
  loggedIn = false;
  apiKey = '';
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#logout').hidden = true;
  if (reason) notify(reason, true);
  $('#login-form').elements.user.focus();
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
}

// asked to the server only for «Copia» in the n8n calls, then kept for this page
let apiKey = '';
async function readApiKey() {
  if (!apiKey) ({ key: apiKey } = await api('GET', '/api/admin/api-key'));
  return apiKey;
}

// --- calls n8n can make, as curl commands (bash: Git Bash, macOS, Linux) ----------------------
const MAIL_SAMPLE = {
  to: 'mario.rossi@esempio.it',
  subject: '{userid}, ecco la tua card',
  userid: 'Mario Rossi',
  link: 'https://main--sito--org.aem.page/mario-rossi',
  total: '87',
};
function mailExampleFields(event) {
  const names = ['to', 'subject', 'userid', 'link', ...(event.mailTemplate?.placeholders || [])];
  return [...new Set(names)].filter((name) => name === 'to' || name === 'subject' || !MAIL_RESERVED.has(name))
    .map((name) => [name, MAIL_SAMPLE[name] ?? '...']);
}

/** The calls, in groups: { group, calls: [{ title, note, cmd }] }. */
function n8nCalls(event) {
  const b = base;
  const s = encodeURIComponent(event.slug);
  const key = '  -H "x-api-key: $PHOTOBOOTH_API_KEY"';
  const jsonBody = (data) => `  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(data)}'`;
  const join = (...parts) => parts.join(' \\\n');
  const scores = { total: 87, technique: 90, fun: 95, style: 78, performance: 85 };
  const mailFields = mailExampleFields(event);
  return [
    {
      group: 'Video sul wall',
      calls: [
        {
          title: 'Video come file',
          note: 'n8n: nodo HTTP Request, Body «Form-Data», parametro «n8n Binary File» (qualsiasi nome di campo). MP4, WebM, MOV, M4V, OGV.',
          cmd: `curl -X POST "${b}/${s}/wall" \\\n${join(key, '  -F "video=@video.mp4"', '  -F "userid=Mario Rossi"', '  -F "title=Il video di Mario"')}`,
        },
        {
          title: 'Video da URL',
          note: 'Il server scarica il video dall\'indirizzo (deve rispondere subito: se dà 404 la chiamata riceve 502).',
          cmd: `curl -X POST "${b}/${s}/wall" \\\n${key} \\\n${jsonBody({ url: 'https://esempio.it/video.mp4', userid: 'Mario Rossi', title: 'Il video di Mario' })}`,
        },
        {
          title: 'Video YouTube',
          note: 'Un link YouTube non si scarica: il wall lo incorpora.',
          cmd: `curl -X POST "${b}/${s}/wall" \\\n${key} \\\n${jsonBody({ url: 'https://www.youtube.com/watch?v=LXb3EKWsInQ', userid: 'Mario Rossi' })}`,
        },
      ],
    },
    {
      group: 'Foto da stampare',
      calls: [
        {
          title: 'Foto come file',
          note: 'JPEG, PNG o WebP. Obbligatori userid e i 5 punteggi (0–999); copies da 1 a 10 (facoltativo). La risposta contiene l\'id della foto.',
          cmd: `curl -X POST "${b}/${s}/print" \\\n${join(key, '  -F "foto=@scatto.jpg"', '  -F "userid=Mario Rossi"',
            ...Object.entries(scores).map(([k, v]) => `  -F "${k}=${v}"`), '  -F "copies=1"')}`,
        },
        {
          title: 'Foto da URL',
          note: 'Come sopra, con la foto scaricata dal server.',
          cmd: `curl -X POST "${b}/${s}/print" \\\n${key} \\\n${jsonBody({ url: 'https://esempio.it/scatto.jpg', userid: 'Mario Rossi', ...scores, copies: 1 })}`,
        },
        {
          title: 'Stato delle stampe',
          note: 'Pubblico, senza chiave. Per ogni foto: status (queued, printing, printed, saved, failed) e previewUrl, la card composta col PSD (utile da passare alla mail come URL).',
          cmd: `curl "${b}/api/events/${s}/prints"`,
        },
        {
          title: 'Ristampa una foto',
          note: 'Rimette in coda la foto con quell\'id.',
          cmd: `curl -X POST "${b}/api/events/${s}/photos/ID_FOTO/reprint" \\\n${key}`,
        },
      ],
    },
    {
      group: 'Email',
      calls: [
        {
          title: 'Mail con la card come file',
          note: 'Obbligatori to, subject (l\'oggetto, anche con {segnaposto}), userid (nome e cognome), link (pagina EDS) e card. Facoltativi cc e bcc; gli altri campi riempiono gli altri {segnaposto} del modello.',
          cmd: `curl -X POST "${b}/${s}/mail" \\\n${join(key, ...mailFields.map(([k, v]) => `  -F "${k}=${v}"`), '  -F "card=@card.jpg"')}`,
        },
        {
          title: 'Mail con la card da URL',
          note: 'La card scaricata dal server dall\'indirizzo nel campo card (per esempio il previewUrl delle stampe, con l\'indirizzo del server davanti).',
          cmd: `curl -X POST "${b}/${s}/mail" \\\n${key} \\\n${jsonBody({ ...Object.fromEntries(mailFields), card: `${b}/previews/${event.slug}/ID_FOTO.jpg` })}`,
        },
      ],
    },
    {
      group: 'Evento',
      calls: [
        { title: 'Accendi l\'evento', note: 'Spento non accetta video, foto né mail (409) e il wall è nero.', cmd: `curl -X PATCH "${b}/api/events/${s}" \\\n${key} \\\n${jsonBody({ active: true })}` },
        { title: 'Spegni l\'evento', note: '', cmd: `curl -X PATCH "${b}/api/events/${s}" \\\n${key} \\\n${jsonBody({ active: false })}` },
        { title: 'Card di esempio sul wall', note: 'true le mostra, false le toglie.', cmd: `curl -X PATCH "${b}/api/events/${s}" \\\n${key} \\\n${jsonBody({ showPlaceholder: true })}` },
        { title: 'Stato del wall', note: 'Pubblico, senza chiave: acceso o spento e i video mostrati.', cmd: `curl "${b}/api/events/${s}/wall"` },
        { title: 'Server raggiungibile', note: 'Pubblico: risponde {"ok":true}.', cmd: `curl "${b}/api/health"` },
      ],
    },
    {
      group: 'Pulizia',
      calls: [
        { title: 'Elimina un video', note: 'L\'id è nella risposta dell\'invio.', cmd: `curl -X DELETE "${b}/api/events/${s}/videos/ID_VIDEO" \\\n${key}` },
        { title: 'Elimina tutti i video', note: 'Toglie anche le card di esempio dal wall.', cmd: `curl -X DELETE "${b}/api/events/${s}/videos" \\\n${key}` },
        { title: 'Elimina una foto', note: '', cmd: `curl -X DELETE "${b}/api/events/${s}/photos/ID_FOTO" \\\n${key}` },
        { title: 'Elimina tutte le foto', note: '', cmd: `curl -X DELETE "${b}/api/events/${s}/photos" \\\n${key}` },
      ],
    },
  ];
}

function renderN8n(event) {
  const key = `${event.slug}:n8n`;
  const groups = n8nCalls(event).map((g) => `
    <h4>${escapeHtml(g.group)}</h4>
    ${g.calls.map((c) => `
      <div class="call">
        <div class="row"><strong>${escapeHtml(c.title)}</strong>
          <button class="small" data-action="copy-cmd" data-cmd="${escapeHtml(c.cmd)}" title="Copia il comando con la chiave già inserita">Copia</button></div>
        ${c.note ? `<p class="muted">${escapeHtml(c.note)}</p>` : ''}
        <pre>${escapeHtml(c.cmd)}</pre>
      </div>`).join('')}`).join('');
  return accordion(key, 'Chiamate da n8n', `
    <p class="muted">Chiave nell'header <code>x-api-key</code> (o <code>Authorization: Bearer</code>). Con l'evento spento le chiamate di invio ricevono <code>409</code>.
      I comandi sono per bash (Git Bash su Windows, macOS, Linux); «Copia» inserisce la chiave al posto di <code>$PHOTOBOOTH_API_KEY</code>.
      Sostituisci <code>ID_FOTO</code> / <code>ID_VIDEO</code> con l'id restituito dall'invio.</p>
    <div class="row">
      <span class="muted">Indirizzo del server: <code>${escapeHtml(base)}</code>. Se n8n gira in Docker, al posto di <code>localhost</code> usa <code>host.docker.internal</code>.</span>
      <button class="small" data-action="copy-key">Copia chiave</button>
    </div>
    ${groups}`);
}

const PHOTO_STATUS = {
  queued: ['In coda', ''],
  printing: ['In stampa', 'on'],
  printed: ['Stampata', 'on'],
  saved: ['Solo anteprima, senza stampante', ''],
  failed: ['Errore', 'error'],
};

function renderPhotos(event) {
  const cards = [...event.photos].reverse().map((photo) => {
    const [label, tone] = PHOTO_STATUS[photo.status] || [photo.status, ''];
    return `
    <div class="video">
      <img class="thumb" alt="" data-photo="${escapeHtml(photo.fileUrl)}">
      <div class="meta">
        <span class="title">${escapeHtml(photo.userId || photo.originalName || 'Foto')}</span>
        <span><span class="badge ${tone}">${escapeHtml(label)}</span> <span class="muted">× ${photo.copies || 1}</span></span>
        <span class="muted">${new Date(photo.createdAt).toLocaleString('it-IT')}</span>
        ${photo.scores ? `<span class="muted">${Object.entries(photo.scores).map(([k, v]) => `${escapeHtml(k)} ${escapeHtml(v)}`).join(' · ')}</span>` : ''}
        ${photo.error ? `<span class="error-text">${escapeHtml(photo.error)}</span>` : ''}
        <div class="row">
          <button class="small" data-action="reprint" data-slug="${escapeHtml(event.slug)}" data-id="${escapeHtml(photo.id)}">Ristampa</button>
          <button class="small danger" data-action="delete-photo" data-slug="${escapeHtml(event.slug)}" data-id="${escapeHtml(photo.id)}">Elimina</button>
        </div>
      </div>
    </div>`;
  }).join('');
  return accordion(`${event.slug}:photos`, `Foto da stampare <span class="muted">· ${event.photos.length}</span>`, `
      ${event.photos.length ? `<div class="row"><button class="small danger" data-action="clear-photos" data-slug="${escapeHtml(event.slug)}" data-count="${event.photos.length}">Elimina tutte le foto</button></div>` : ''}
      ${cards ? `<div class="videos">${cards}</div>` : '<p class="muted">Ancora nessuna foto.</p>'}`);
}

/** A <details> that remembers whether it is open across refreshes (and reloads of the page). */
function accordion(key, summary, body) {
  return `
    <details data-key="${escapeHtml(key)}" ${openDetails.has(key) ? 'open' : ''}>
      <summary>${summary}</summary>
      ${body}
    </details>`;
}

// photo files need the key, so thumbnails are fetched and kept as blob URLs
const thumbs = new Map();
function loadThumbs() {
  document.querySelectorAll('img[data-photo]').forEach(async (img) => {
    const url = img.dataset.photo;
    if (!thumbs.has(url)) {
      thumbs.set(url, fetch(url)
        .then((r) => (r.ok ? r.blob() : Promise.reject()))
        .then((blob) => URL.createObjectURL(blob))
        .catch(() => { thumbs.delete(url); return ''; }));
    }
    img.src = await thumbs.get(url);
  });
}

function renderPrintStatus(agent) {
  const box = $('#print-status');
  const age = agent ? (Date.now() - Date.parse(agent.lastSeenAt)) / 1000 : Infinity;
  const status = age < 15
    ? `<span class="badge on">STAMPA COLLEGATA</span> <span class="muted">${escapeHtml(agent.name)} · ${escapeHtml(agent.printer)}</span>`
    : `<span class="badge">STAMPA NON COLLEGATA</span> <span class="muted">${agent ? `ultimo contatto ${new Date(agent.lastSeenAt).toLocaleTimeString('it-IT')}` : 'il servizio non si è ancora fatto vivo'}</span>`;
  const html = `
    <div class="row"><h2>Servizio di stampa</h2> ${status}</div>
    <p class="muted">Parte insieme al server con <code>npm start</code> e stampa sulla stampante indicata in <code>PRINTER_NAME</code> (file <code>.env</code>;
      l'elenco delle stampanti con <code>npm run print -- --printers</code>). Senza stampante le foto restano solo in anteprima.
      Con il server su AWS: <code>PRINT_AGENT=0</code> sul server e <code>npm run print</code> sul PC con la stampante.</p>
    <p class="muted">Template di stampa e impostazioni della carta si scelgono in ogni evento (tab Eventi).</p>`;
  if (box.innerHTML !== html) box.innerHTML = html;
}

const QUEUE_COLUMNS = ['queued', 'printing', 'printed', 'saved', 'failed'];

function renderPrintQueue(events) {
  const rows = events.slice().reverse().map((event) => {
    const count = Object.fromEntries(QUEUE_COLUMNS.map((s) => [s, event.photos.filter((p) => p.status === s).length]));
    const failed = count.failed ? `<span class="error-text">${count.failed}</span>` : '0';
    return `
      <tr>
        <td><strong>${escapeHtml(event.name)}</strong> <span class="badge ${event.active ? 'on' : ''}">${event.active ? 'ACCESO' : 'SPENTO'}</span></td>
        <td>${count.queued}</td><td>${count.printing}</td><td>${count.printed}</td><td>${count.saved}</td><td>${failed}</td>
        <td class="muted">${escapeHtml(event.template?.originalName || 'PSD del PC di stampa')} · ${escapeHtml(printOptions ? settingsSummary(event.printSettings) : '')}</td>
        <td><a class="button small" href="${escapeHtml(event.printUrl)}" target="_blank" rel="noopener">Anteprima stampe</a></td>
      </tr>`;
  }).join('');
  $('#print-queue').innerHTML = events.length ? `
    <div class="card">
      <h2>Coda per evento</h2>
      <div style="overflow-x: auto; margin-top: 10px">
        <table class="queue-table">
          <thead><tr><th>Evento</th><th>In coda</th><th>In stampa</th><th>Stampate</th><th>Solo anteprima</th><th>Errori</th><th>Template · carta</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="muted">Le singole foto (ristampa, elimina) sono nell'evento, sezione «Foto da stampare».</p>
    </div>` : '<p class="muted">Nessun evento.</p>';
}

function renderEvent(event) {
  const wall = `${base}${event.wallUrl}`;
  const videos = [...event.videos].reverse().map((video) => `
    <div class="video">
      ${video.youtubeId
    ? `<a href="https://www.youtube.com/watch?v=${encodeURIComponent(video.youtubeId)}" target="_blank" rel="noopener"><img class="thumb" alt="YouTube" src="https://i.ytimg.com/vi/${encodeURIComponent(video.youtubeId)}/hqdefault.jpg"></a>`
    : `<video src="${escapeHtml(video.url)}" preload="metadata" muted controls playsinline></video>`}
      <div class="meta">
        <span class="title" title="${escapeHtml(video.title || video.originalName)}">${escapeHtml(video.title || video.originalName || 'Senza titolo')}</span>
        <span class="muted">${video.userId ? `${escapeHtml(video.userId)} · ` : ''}${new Date(video.createdAt).toLocaleString('it-IT')}${video.size ? ` · ${formatSize(video.size)}` : ''}</span>
        <button class="small danger" data-action="delete-video" data-slug="${escapeHtml(event.slug)}" data-id="${escapeHtml(video.id)}">Elimina</button>
      </div>
    </div>`).join('');
  const key = `event:${event.slug}`;
  return `
    <details class="card event" data-key="${escapeHtml(key)}" ${openDetails.has(key) ? 'open' : ''}>
      <summary>
        <span class="chevron" aria-hidden="true"></span>
        <button class="switch ${event.active ? 'on' : ''}" data-action="toggle" data-slug="${escapeHtml(event.slug)}" data-active="${event.active}"
          title="${event.active ? 'Spegni' : 'Accendi'}" aria-label="${event.active ? 'Spegni' : 'Accendi'} ${escapeHtml(event.name)}"></button>
        <span class="grow">
          <h2>${escapeHtml(event.name)}</h2>
          <span class="muted">${escapeHtml(event.slug)} · ${event.videos.length} video · ${event.photos.length} foto · ${event.screens} schermi collegati${event.mailTemplate ? ' · email pronta' : ''}</span>
        </span>
        <span class="badge ${event.active ? 'on' : ''}">${event.active ? 'ACCESO' : 'SPENTO'}</span>
      </summary>
      <div class="row toolbar">
        <a class="button" href="${escapeHtml(event.wallUrl)}" target="_blank" rel="noopener">Apri wall</a>
        <button data-action="copy" data-text="${escapeHtml(wall)}">Copia link wall</button>
        <a class="button" href="${escapeHtml(event.printUrl)}" target="_blank" rel="noopener">Anteprima stampe</a>
        <span class="grow"></span>
        <button class="danger" data-action="delete-event" data-slug="${escapeHtml(event.slug)}" data-name="${escapeHtml(event.name)}">Elimina evento</button>
      </div>
      ${renderTemplate(event)}
      ${renderPrintSettings(event)}
      ${renderMailTemplate(event)}
      ${renderN8n(event)}
      ${accordion(`${event.slug}:videos`, `Video <span class="muted">· ${event.videos.length}</span>`, `
        <div class="row">
          ${event.placeholderAvailable ? `<label class="check" title="Le card con il video di esempio (WALL_PLACEHOLDER) finché la prima riga del wall non è piena">
            <input type="checkbox" data-action="toggle-placeholder" data-slug="${escapeHtml(event.slug)}" ${event.showPlaceholder ? 'checked' : ''}> Card di esempio sul wall</label>` : ''}
          ${event.videos.length ? `<button class="small danger" data-action="clear-videos" data-slug="${escapeHtml(event.slug)}" data-count="${event.videos.length}">Elimina tutti i video</button>` : ''}
        </div>
        ${videos ? `<div class="videos">${videos}</div>` : '<p class="muted">Ancora nessun video.</p>'}`)}
      ${renderPhotos(event)}
    </details>`;
}

// --- print settings of an event: paper, orientation, border, margins, fit ---------------------
let printOptions = null;
const editing = new Set(); // forms with unsaved changes: their values are kept when the page updates

const options = (map, selected) => Object.entries(map).map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');

function settingsSummary(s) {
  const paper = printOptions?.papers.find((p) => p.value === s.paper)?.label || s.paper;
  const border = s.border === 'none' ? 'senza bordo' : `${printOptions?.borders[s.border].toLowerCase()} ${s.borderMm} mm`;
  const m = s.margins;
  const margins = [m.top, m.right, m.bottom, m.left].every((v) => v === 0) ? 'senza margini' : `margini ${m.top}/${m.right}/${m.bottom}/${m.left} mm`;
  return `${paper} · ${border} · ${margins}`;
}

// --- print template of the event (PSD and fonts), changed at runtime -------------------------------
function renderTemplate(event) {
  const t = event.template;
  const key = `${event.slug}:template`;
  const slug = escapeHtml(event.slug);
  const upload = (kind, label, accept, multiple) => `
    <label class="button small file">${label}
      <input type="file" hidden data-upload="${kind}" data-slug="${slug}" accept="${accept}" ${multiple ? 'multiple' : ''}>
    </label>`;
  if (!t) {
    return `
    <details data-key="${escapeHtml(key)}" ${openDetails.has(key) ? 'open' : ''}>
      <summary>Template di stampa <span class="muted">· nessuno: si usa il PSD nella cartella templates del PC di stampa</span></summary>
      <div class="template">
        <p class="muted">Carica il PSD (e se servono i font .otf/.ttf, anche insieme): viene controllato e usato dalla stampa successiva, senza riavviare nulla.</p>
        <div class="row">${upload('template', 'Carica PSD e font', '.psd,.otf,.ttf', true)}</div>
      </div>
    </details>`;
  }
  const i = t.info || {};
  const cm = (px) => ((px / (i.dpi || 300)) * 2.54).toFixed(1).replace('.', ',');
  const texts = (i.texts || []).map((x) => `<li>${escapeHtml(x.layer)} <span class="muted">· ${escapeHtml(x.font)}</span> ${x.found ? '<span class="ok-text">✓ font presente</span>' : '<span class="error-text">✗ font mancante</span>'}</li>`).join('');
  const fonts = t.fonts.map((f) => `<li>${escapeHtml(f.file)} <span class="muted">${formatSize(f.size)}</span>
      <button class="small danger" data-action="delete-font" data-slug="${slug}" data-file="${escapeHtml(f.file)}">Togli</button></li>`).join('');
  const warnings = (i.warnings || []).map((w) => `<li>${escapeHtml(w)}</li>`).join('');
  return `
    <details data-key="${escapeHtml(key)}" ${openDetails.has(key) ? 'open' : ''}>
      <summary>Template di stampa <span class="muted">· ${escapeHtml(t.originalName)}${warnings ? ' · <span class="error-text">da controllare</span>' : ''}</span></summary>
      <div class="template">
        <img class="template-preview" alt="Anteprima del template" data-photo="${escapeHtml(t.previewUrl)}">
        <div>
          <p><strong>${escapeHtml(t.originalName)}</strong> <span class="muted">· ${formatSize(t.size)} · caricato il ${new Date(t.uploadedAt).toLocaleString('it-IT')}</span></p>
          <p class="muted">${i.width}×${i.height} px · ${i.dpi} dpi · ${cm(i.width)}×${cm(i.height)} cm · ${i.photoLayer ? `foto al posto del livello «${escapeHtml(i.photoLayer)}»` : 'nessun livello per la foto: va sotto tutto il template'}</p>
          ${texts ? `<h4>Testi variabili</h4><ul class="plain">${texts}</ul>` : '<p class="muted">Nessun testo variabile ({name}, {total}…).</p>'}
          <h4>Font caricati</h4>${fonts ? `<ul class="plain">${fonts}</ul>` : '<p class="muted">Nessuno.</p>'}
          ${warnings ? `<h4>Da controllare</h4><ul class="warnings">${warnings}</ul>` : ''}
          <div class="row">
            ${upload('template', 'Sostituisci PSD', '.psd,.otf,.ttf', true)}
            ${upload('fonts', 'Aggiungi font', '.otf,.ttf', true)}
            <button class="small danger" data-action="delete-template" data-slug="${slug}">Rimuovi template</button>
          </div>
          <p class="muted">L'anteprima usa una foto e valori di esempio. Le modifiche valgono dalla stampa successiva.</p>
        </div>
      </div>
    </details>`;
}

async function uploadTemplateFiles(input) {
  const { slug, upload } = input.dataset;
  const files = [...input.files];
  if (!files.length) return;
  const form = new FormData();
  files.forEach((file) => form.append('file', file, file.name));
  const total = files.reduce((n, f) => n + f.size, 0);
  notify(`Caricamento di ${files.length} file (${formatSize(total)}) e controllo del template…`);
  try {
    const target = { template: 'template', fonts: 'template/fonts', mail: 'mail-template' }[upload];
    const response = await fetch(`/api/events/${slug}/${target}`, {
      method: 'POST', body: form,
    });
    checkSession(response);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Errore HTTP ${response.status}`);
    openDetails.add(upload === 'mail' ? `${slug}:mail` : `${slug}:template`);
    notify({
      fonts: 'Font aggiunti.',
      template: 'Template caricato: vale dalla prossima stampa.',
      mail: 'Modello email caricato: vale dal prossimo invio.',
    }[upload]);
    lastRender = '';
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
}

function renderPrintSettings(event) {
  if (!printOptions) return '';
  const s = event.printSettings;
  const key = `${event.slug}:print`;
  const num = (name, value, label, extra = '') => `<label>${label}<input name="${name}" type="number" min="0" step="0.1" value="${escapeHtml(value ?? '')}" ${extra}></label>`;
  return `
    <details data-key="${escapeHtml(key)}" ${openDetails.has(key) ? 'open' : ''}>
      <summary>Impostazioni di stampa <span class="muted">· ${escapeHtml(settingsSummary(s))}</span></summary>
      <form class="print-settings" data-slug="${escapeHtml(event.slug)}" data-edit="${escapeHtml(event.slug)}">
        <div class="settings-grid">
          <label>Formato carta<select name="paper">${options(Object.fromEntries(printOptions.papers.map((p) => [p.value, p.label])), s.paper)}</select></label>
          ${num('widthMm', s.widthMm ?? '', 'Larghezza (mm)', 'data-when="custom"')}
          ${num('heightMm', s.heightMm ?? '', 'Altezza (mm)', 'data-when="custom"')}
          <label>Orientamento<select name="orientation">${options(printOptions.orientations, s.orientation)}</select></label>
          <label>Adattamento<select name="fit">${options(printOptions.fits, s.fit)}</select></label>
          <label>Bordo<select name="border">${options(printOptions.borders, s.border)}</select></label>
          ${num('borderMm', s.borderMm, 'Spessore bordo (mm)', 'data-when="border"')}
          <label data-when="border">Colore bordo<input name="borderColor" type="color" value="${escapeHtml(s.borderColor)}"></label>
          ${num('top', s.margins.top, 'Margine alto (mm)')}
          ${num('right', s.margins.right, 'Margine destro (mm)')}
          ${num('bottom', s.margins.bottom, 'Margine basso (mm)')}
          ${num('left', s.margins.left, 'Margine sinistro (mm)')}
          <label>Scala della stampante<select name="scale">${options(printOptions.scales, s.scale)}</select></label>
          <label>Formato nel driver (facoltativo)<input name="driverPaper" value="${escapeHtml(s.driverPaper)}" placeholder="es. 4x6, Postcard"></label>
        </div>
        <div class="sheet-preview" aria-hidden="true"><div class="paper"><div class="frame"><div class="inner"><div class="pic"></div></div></div></div></div>
        <div class="row">
          <button class="primary">Salva</button>
          <button type="button" data-action="reset-print" data-slug="${escapeHtml(event.slug)}">Valori predefiniti</button>
          <span class="muted">Si applicano dalla prossima stampa (anche alle ristampe).</span>
        </div>
      </form>
    </details>`;
}

function readSettings(form) {
  const f = form.elements;
  return {
    paper: f.paper.value,
    widthMm: f.widthMm.value,
    heightMm: f.heightMm.value,
    orientation: f.orientation.value,
    fit: f.fit.value,
    border: f.border.value,
    borderMm: f.borderMm.value,
    borderColor: f.borderColor.value,
    margins: {
      top: f.top.value, right: f.right.value, bottom: f.bottom.value, left: f.left.value,
    },
    scale: f.scale.value,
    driverPaper: f.driverPaper.value,
  };
}

/** Shows the fields that apply and draws the sheet to scale (the template picture is 2:3). */
function updateSettingsForm(form) {
  const s = readSettings(form);
  form.querySelectorAll('[data-when="custom"]').forEach((el) => { (el.closest('label') || el).hidden = s.paper !== 'custom'; });
  form.querySelectorAll('[data-when="border"]').forEach((el) => { (el.closest('label') || el).hidden = s.border === 'none'; });
  const preset = printOptions.papers.find((p) => p.value === s.paper);
  const picture = { w: 2, h: 3 };
  let w = Number(preset.widthMm || s.widthMm) || 101.6;
  let h = Number(preset.heightMm || s.heightMm) || 152.4;
  if (s.paper === 'template') { w = 137.2; h = 205.7; }
  const landscape = s.orientation === 'landscape' || (s.orientation === 'auto' && picture.w > picture.h);
  if (landscape !== w > h && w !== h) [w, h] = [h, w];
  const n = (v) => Math.max(0, Number(v) || 0);
  const border = s.border === 'none' ? 0 : n(s.borderMm);
  const bottom = s.border === 'instant' ? border * 3.5 : border;
  const paper = form.querySelector('.paper');
  paper.style.aspectRatio = `${w} / ${h}`;
  const pct = (v, total) => `${(v / total) * 100}%`;
  const frame = form.querySelector('.frame');
  Object.assign(frame.style, {
    left: pct(n(s.margins.left), w),
    right: pct(n(s.margins.right), w),
    top: pct(n(s.margins.top), h),
    bottom: pct(n(s.margins.bottom), h),
    background: border ? s.borderColor : 'transparent',
    padding: `${pct(border, w)} ${pct(border, w)} ${pct(bottom, w)}`,
  });
  // the picture (2:3) in the space left inside margins and border: whole, or filling it
  const innerW = w - n(s.margins.left) - n(s.margins.right) - 2 * border;
  const innerH = h - n(s.margins.top) - n(s.margins.bottom) - border - bottom;
  const pic = form.querySelector('.pic');
  if (innerW <= 0 || innerH <= 0) {
    pic.style.width = '0';
    pic.style.height = '0';
    return;
  }
  const ratio = picture.w / picture.h;
  const wider = innerW / innerH > ratio;
  const whole = s.fit !== 'cover';
  // whole: limited by the tighter side; fill: by the looser one (the rest is cut)
  const byHeight = whole ? wider : !wider;
  pic.style.height = byHeight ? '100%' : `${((innerW / ratio) / innerH) * 100}%`;
  pic.style.width = byHeight ? `${((innerH * ratio) / innerW) * 100}%` : '100%';
}

function initSettingsForms() {
  document.querySelectorAll('form.print-settings').forEach(updateSettingsForm);
}

// --- mail account (one for the server) -----------------------------------------------------------
let mailConfig = null;
// outcome of the last save / check / test, shown under the form until the next one
let mailStatus = { text: '', tone: 'muted' };
let mailTestTo = '';

function renderMailAccount() {
  const box = $('#mail-account');
  const c = mailConfig;
  if (!c) {
    box.innerHTML = '';
    return;
  }
  const field = (name, label, value, attrs = '') => `<label>${label}<input name="${name}" value="${escapeHtml(value ?? '')}" ${attrs}></label>`;
  const status = c.configured
    ? `<span class="badge on">EMAIL CONFIGURATA</span> <span class="muted">${escapeHtml(c.fromName ? `${c.fromName} <${c.fromAddress}>` : c.fromAddress)} · ${escapeHtml(c.host)}</span>`
    : '<span class="badge">EMAIL NON CONFIGURATA</span> <span class="muted">imposta l\'account SMTP per inviare le mail da n8n</span>';
  box.innerHTML = `
      <div class="row"><h2>Account email</h2> ${status}</div>
      <p class="muted">Un solo account per il server, usato da tutti gli eventi. Il modello della mail si carica in ogni evento (tab Eventi).</p>
      <form class="mail-account">
        <div class="settings-grid">
          ${field('host', 'Server SMTP', c.host, 'placeholder="es. smtp.office365.com" required')}
          ${field('port', 'Porta', c.port, 'type="number" min="1" max="65535" placeholder="automatica"')}
          <label>Sicurezza<select name="security">${options(c.securityOptions, c.security)}</select></label>
          ${field('user', 'Utente', c.user, 'autocomplete="off" placeholder="di solito l\'indirizzo email"')}
          <label>Password<input name="password" type="password" autocomplete="new-password"
            placeholder="${c.passwordSet ? 'impostata: lascia vuoto per non cambiarla' : ''}"></label>
          ${field('fromAddress', 'Mittente (indirizzo)', c.fromAddress, 'type="email" required')}
          ${field('fromName', 'Mittente (nome)', c.fromName, 'placeholder="es. Comwrap Photobooth"')}
          ${field('replyTo', 'Risposte a (facoltativo)', c.replyTo, 'type="email"')}
        </div>
        ${c.passwordSet ? '<label class="check"><input type="checkbox" name="clearPassword"> Togli la password salvata</label>' : ''}
        <div class="row">
          <button class="primary">Salva</button>
          <button type="button" data-action="mail-verify">Prova la connessione</button>
          <span class="muted">La password resta solo sul server. Le prove salvano prima i dati del modulo.</span>
        </div>
        <div class="row">
          <input name="testTo" type="email" placeholder="Indirizzo per la mail di prova" value="${escapeHtml(mailTestTo)}">
          <button type="button" data-action="mail-test">Invia mail di prova</button>
        </div>
        <p class="mail-result ${mailStatus.tone}" role="status">${escapeHtml(mailStatus.text)}</p>
      </form>`;
}

async function loadMailConfig() {
  try {
    mailConfig = await api('GET', '/api/mail/config');
    renderMailAccount();
  } catch (error) {
    notify(error.message, true);
  }
}

/** Saves what is in the form (the checks and the test use the saved account). */
async function saveMailAccount(form) {
  const f = form.elements;
  mailTestTo = f.testTo.value.trim();
  mailConfig = await api('PUT', '/api/mail/config', {
    host: f.host.value,
    port: f.port.value,
    security: f.security.value,
    user: f.user.value,
    password: f.password.value,
    clearPassword: Boolean(f.clearPassword?.checked),
    fromAddress: f.fromAddress.value,
    fromName: f.fromName.value,
    replyTo: f.replyTo.value,
  });
}

/** Runs one step on the account form: the outcome stays written under it, the buttons wait. */
async function mailAccountStep(form, waiting, step) {
  const result = form.querySelector('.mail-result');
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  result.className = 'mail-result muted';
  result.textContent = waiting;
  try {
    mailStatus = { text: await step(), tone: 'ok-text' };
  } catch (error) {
    mailStatus = { text: error.message, tone: 'error-text' };
  }
  renderMailAccount();
  notify(mailStatus.text, mailStatus.tone === 'error-text');
}

$('#mail-account').addEventListener('submit', (e) => {
  e.preventDefault();
  mailAccountStep(e.target, 'Salvataggio…', async () => {
    await saveMailAccount(e.target);
    return 'Account email salvato.';
  });
});

$('#mail-account').addEventListener('click', (e) => {
  const button = e.target.closest('[data-action]');
  if (!button) return;
  const form = button.closest('form');
  if (button.dataset.action === 'mail-verify') {
    mailAccountStep(form, 'Salvataggio e connessione al server SMTP (fino a 15 secondi)…', async () => {
      await saveMailAccount(form);
      await api('POST', '/api/mail/verify');
      return `Connessione riuscita a ${mailConfig.host}: l'account funziona.`;
    });
  } else if (button.dataset.action === 'mail-test') {
    mailAccountStep(form, 'Salvataggio e invio della mail di prova…', async () => {
      const to = form.elements.testTo.value.trim();
      if (!to) throw new Error('Scrivi l\'indirizzo a cui mandare la mail di prova.');
      await saveMailAccount(form);
      await api('POST', '/api/mail/test', { to });
      return `Mail di prova inviata a ${to}: controlla la casella (anche lo spam).`;
    });
  }
});

// --- mail template of an event (HTML and images) ---------------------------------------------------
// fields of the call that are not plain template values ({card} becomes the image)
const MAIL_RESERVED = new Set(['to', 'cc', 'bcc', 'subject', 'params', 'card', 'cardUrl']);
const MAIL_REQUIRED_HINT = {
  userid: '<code>{userid}</code> (nome e cognome) non compare nel modello',
  card: '<code>{card}</code> non compare: la card arriva solo come allegato. Per mostrarla usa <code>&lt;img src="{card}"&gt;</code>',
  link: '<code>{link}</code> non compare: il link alla pagina EDS non è nella mail. Usa <code>&lt;a href="{link}"&gt;</code>',
};

function renderMailTemplate(event) {
  const t = event.mailTemplate;
  const key = `${event.slug}:mail`;
  const slug = escapeHtml(event.slug);
  const upload = (label) => `
    <label class="button small file">${label}
      <input type="file" hidden data-upload="mail" data-slug="${slug}" accept=".html,.htm,.png,.jpg,.jpeg,.gif,.webp,.svg" multiple>
    </label>`;
  if (!t) {
    return `
    <details data-key="${escapeHtml(key)}" ${openDetails.has(key) ? 'open' : ''}>
      <summary>Email <span class="muted">· nessun modello: le chiamate a /mail ricevono 409</span></summary>
      <div class="template">
        <p class="muted">Carica il file HTML della mail insieme alle immagini che usa (<code>src="logo.png"</code>, anche in sottocartelle):
          vengono allegate alla mail. La chiamata di n8n porta <code>{userid}</code> (nome e cognome), <code>{link}</code> (la pagina EDS)
          e la card: nel modello si mostra con <code>&lt;img src="{card}"&gt;</code> e arriva anche come allegato.
          Altri testi <code>{nome}</code> o <code>{{nome}}</code> si riempiono con gli altri campi della chiamata.
          L'oggetto arriva con la chiamata (<code>subject</code>), anche con segnaposto.</p>
        <div class="row">${upload('Carica HTML e immagini')}</div>
      </div>
    </details>`;
  }
  const images = t.images.map((name) => `<li>${escapeHtml(name)}
      <button class="small danger" data-action="delete-mail-image" data-slug="${slug}" data-file="${escapeHtml(name)}">Togli</button></li>`).join('');
  // the test fills each placeholder with its own name: the real values come from the service
  const values = t.placeholders.filter((name) => !MAIL_RESERVED.has(name));
  return `
    <details data-key="${escapeHtml(key)}" ${openDetails.has(key) ? 'open' : ''}>
      <summary>Email <span class="muted">· ${escapeHtml(t.originalName)}</span></summary>
      <div class="template mail">
        <iframe class="mail-preview" title="Anteprima della mail" sandbox="" data-mail-preview="${escapeHtml(t.previewUrl)}" data-version="${escapeHtml(t.uploadedAt + t.images.join())}"></iframe>
        <div>
          <p><strong>${escapeHtml(t.originalName)}</strong> <span class="muted">· caricato il ${new Date(t.uploadedAt).toLocaleString('it-IT')}</span></p>
          <p class="muted">L'oggetto non è nel modello: lo manda il servizio nella chiamata (<code>subject</code>).</p>
          <h4>Segnaposto</h4>
          ${t.placeholders.length ? `<p class="muted">${t.placeholders.map((n) => `<code>{${escapeHtml(n)}}</code>`).join(' ')}<br>
            I valori (nome e cognome, card, link EDS…) arrivano dalla chiamata del servizio; senza valore restano vuoti.</p>` : '<p class="muted">Nessuno: la mail è uguale per tutti.</p>'}
          ${(t.unused || []).length ? `<h4>Da controllare</h4><ul class="warnings">${t.unused.map((n) => `<li>${MAIL_REQUIRED_HINT[n] || escapeHtml(n)}</li>`).join('')}</ul>` : ''}
          <h4>Immagini allegate</h4>${images ? `<ul class="plain">${images}</ul>` : '<p class="muted">Nessuna.</p>'}
          <div class="row" style="margin-top: 10px">
            ${upload('Sostituisci HTML o aggiungi immagini')}
            <button class="small danger" data-action="delete-mail-template" data-slug="${slug}">Rimuovi modello</button>
          </div>
          <h4>Invia una prova</h4>
          <form class="mail-send" data-slug="${slug}" data-edit="${slug}:mail-send" data-placeholders="${escapeHtml(JSON.stringify(values))}">
            <div class="row">
              <input name="to" type="email" required placeholder="Indirizzo a cui mandare la prova">
              <input name="subject" required value="Prova: {userid}, ecco la tua card" title="Oggetto della prova (nella chiamata vera lo manda il servizio)">
              <button class="small primary" ${event.active ? '' : 'disabled'}>Invia prova</button>
            </div>
            <p class="muted">${event.active
    ? 'Arriva la mail vera con questo oggetto, una card di esempio e un link di prova; al posto degli altri valori compaiono i nomi dei segnaposto ({userid}…). Nulla viene salvato.'
    : 'Accendi l\'evento per inviare.'}</p>
          </form>
        </div>
      </div>
    </details>`;
}

// the preview needs the key: fetched once per version of the template, shown with srcdoc
const mailPreviews = new Map();
function loadMailPreviews() {
  document.querySelectorAll('iframe[data-mail-preview]').forEach(async (frame) => {
    const id = `${frame.dataset.mailPreview}|${frame.dataset.version}`;
    if (!mailPreviews.has(id)) {
      mailPreviews.set(id, fetch(frame.dataset.mailPreview)
        .then((r) => (r.ok ? r.text() : Promise.reject()))
        .catch(() => { mailPreviews.delete(id); return '<p style="font-family:sans-serif">Anteprima non disponibile.</p>'; }));
    }
    frame.srcdoc = await mailPreviews.get(id);
  });
}

/** A 2:3 card for the test mail, drawn here: the real one comes from the service. */
function sampleCard() {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 900;
  const g = canvas.getContext('2d');
  const fill = g.createLinearGradient(0, 0, 600, 900);
  fill.addColorStop(0, '#ff3d8b');
  fill.addColorStop(0.55, '#7b2ff7');
  fill.addColorStop(1, '#1d1d5c');
  g.fillStyle = fill;
  g.fillRect(0, 0, 600, 900);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.font = 'bold 56px system-ui, sans-serif';
  g.fillText('CARD', 300, 430);
  g.font = '28px system-ui, sans-serif';
  g.fillText('di esempio', 300, 480);
  return new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
}

/** The test mail: the same call as n8n, with a sample card and the placeholders' own names. */
async function sendTestMail(form) {
  const { slug } = form.dataset;
  const to = form.elements.to.value.trim();
  const call = new FormData();
  call.append('to', to);
  call.append('subject', form.elements.subject.value);
  JSON.parse(form.dataset.placeholders).forEach((name) => call.append(name, `{${name}}`));
  call.set('userid', '{userid}');
  call.set('link', `${base}/${slug}/wall`);
  call.append('card', await sampleCard(), 'card-di-esempio.png');
  notify('Invio in corso…');
  const response = await fetch(`/${slug}/mail`, { method: 'POST', body: call });
  checkSession(response);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Errore HTTP ${response.status}`);
  notify(`Mail di prova inviata a ${to}.`);
  editing.delete(form.dataset.edit);
  lastRender = '';
  await refresh();
}

async function refresh() {
  if (!loggedIn) return;
  let events;
  try {
    const info = await api('GET', '/api/info');
    if (!infoLoaded) {
      base = info.publicUrl || location.origin;
      infoLoaded = true;
    }
    printOptions = info.printOptions;
    renderPrintStatus(info.printAgent);
    events = await api('GET', '/api/events');
    if (!mailConfig) loadMailConfig();
  } catch (error) {
    if (loggedIn) notify(error.message, true);
    return;
  }
  showApp();
  renderPrintQueue(events);
  setLogEvents(events);
  const signature = JSON.stringify(events);
  if (signature === lastRender) return;
  lastRender = signature;
  $('#empty').hidden = events.length > 0;
  // the page always updates (new videos, photos…): what is being typed in a form survives it
  const edits = readEdits();
  $('#events').innerHTML = events.slice().reverse().map(renderEvent).join('');
  restoreEdits(edits);
  loadThumbs();
  loadMailPreviews();
  initSettingsForms();
}

/** Values of the forms with unsaved changes, and where the cursor is. */
function readEdits() {
  const forms = new Map();
  document.querySelectorAll('#events form[data-edit]').forEach((form) => {
    if (!editing.has(form.dataset.edit)) return;
    forms.set(form.dataset.edit, [...form.elements].filter((el) => el.name)
      .map((el) => [el.name, el.type === 'checkbox' ? el.checked : el.value]));
  });
  const el = document.activeElement;
  const form = el?.closest?.('#events form[data-edit]');
  const focus = form && el.name ? {
    form: form.dataset.edit, name: el.name, start: el.selectionStart, end: el.selectionEnd,
  } : null;
  return { forms, focus };
}

function restoreEdits({ forms, focus }) {
  const find = (key) => [...document.querySelectorAll('#events form[data-edit]')].find((f) => f.dataset.edit === key);
  forms.forEach((values, key) => {
    const form = find(key);
    if (!form) {
      editing.delete(key); // the form is gone (event or template removed)
      return;
    }
    values.forEach(([name, value]) => {
      const el = form.elements[name];
      if (!el || el.type === 'file') return;
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
    });
  });
  const el = focus && find(focus.form)?.elements[focus.name];
  if (!el) return;
  el.focus({ preventScroll: true });
  try { el.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
}

$('#events').addEventListener('change', (e) => {
  if (e.target.matches('input[data-upload]')) uploadTemplateFiles(e.target);
});

$('#events').addEventListener('input', (e) => {
  const form = e.target.closest('form[data-edit]');
  if (!form) return;
  editing.add(form.dataset.edit);
  if (form.matches('.print-settings')) updateSettingsForm(form);
});

$('#events').addEventListener('submit', async (e) => {
  const form = e.target.closest('form.print-settings, form.mail-send');
  if (!form) return;
  e.preventDefault();
  if (!form.matches('.print-settings')) {
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await sendTestMail(form);
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
    return;
  }
  try {
    await api('PATCH', `/api/events/${form.dataset.slug}`, { printSettings: readSettings(form) });
    editing.delete(form.dataset.slug);
    lastRender = '';
    notify('Impostazioni di stampa salvate.');
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
});

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    notify('Copiato.');
  } catch {
    window.prompt('Copia:', text);
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const response = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: form.elements.user.value.trim(), password: form.elements.password.value }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    notify(data.error || `Errore HTTP ${response.status}`, true);
    form.elements.password.select();
    return;
  }
  form.elements.password.value = '';
  loggedIn = true;
  lastRender = '';
  mailConfig = null;
  await refresh();
});

$('#logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const event = await api('POST', '/api/events', {
      name: form.name.value,
      slug: form.slug.value.trim() || undefined,
    });
    form.reset();
    openDetails.add(`event:${event.slug}`);
    saveOpen();
    notify(`Evento «${event.name}» creato (spento).`);
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
});

$('#events').addEventListener('toggle', (e) => {
  const { key } = e.target.dataset;
  if (!key) return;
  if (e.target.open) openDetails.add(key);
  else openDetails.delete(key);
  saveOpen();
}, true);

$('#events').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-action]');
  if (!button) return;
  // the on/off switch sits in the title of the accordion: it must not open or close it
  if (button.closest('summary')) e.preventDefault();
  const { action, slug } = button.dataset;
  try {
    if (action === 'copy') return copy(button.dataset.text);
    if (action === 'copy-key') return copy(await readApiKey());
    if (action === 'copy-cmd') return copy(button.dataset.cmd.replaceAll('$PHOTOBOOTH_API_KEY', await readApiKey()));
    if (action === 'toggle') {
      const event = await api('PATCH', `/api/events/${slug}`, { active: button.dataset.active !== 'true' });
      notify(`«${event.name}» ${event.active ? 'acceso' : 'spento'}.`);
    } else if (action === 'delete-event') {
      if (!window.confirm(`Eliminare l'evento «${button.dataset.name}» e tutti i suoi video?`)) return;
      await api('DELETE', `/api/events/${slug}`);
      notify('Evento eliminato.');
    } else if (action === 'toggle-placeholder') {
      await api('PATCH', `/api/events/${slug}`, { showPlaceholder: button.checked });
      notify(button.checked ? 'Card di esempio mostrate sul wall.' : 'Card di esempio tolte dal wall.');
    } else if (action === 'delete-template') {
      if (!window.confirm('Rimuovere il template di questo evento? La stampa userà il PSD nella cartella templates del PC.')) return;
      await api('DELETE', `/api/events/${slug}/template`);
      notify('Template rimosso.');
    } else if (action === 'delete-font') {
      await api('DELETE', `/api/events/${slug}/template/fonts/${encodeURIComponent(button.dataset.file)}`);
      notify('Font tolto.');
    } else if (action === 'delete-mail-template') {
      if (!window.confirm('Rimuovere il modello email di questo evento? Le chiamate a /mail riceveranno 409 finché non ne carichi un altro.')) return;
      await api('DELETE', `/api/events/${slug}/mail-template`);
      notify('Modello email rimosso.');
    } else if (action === 'delete-mail-image') {
      await api('DELETE', `/api/events/${slug}/mail-template/images/${encodeURIComponent(button.dataset.file)}`);
      notify('Immagine tolta.');
    } else if (action === 'clear-videos' || action === 'clear-photos') {
      const what = action === 'clear-videos' ? 'tutti i video' : 'tutte le foto';
      const extra = action === 'clear-videos' ? ' Spariscono anche le card di esempio dal wall (le puoi riattivare).' : '';
      if (!window.confirm(`Eliminare ${what} dell'evento (${button.dataset.count})? I file vengono cancellati dal disco e non si possono recuperare.${extra}`)) return;
      const { removed } = await api('DELETE', `/api/events/${slug}/${action === 'clear-videos' ? 'videos' : 'photos'}`);
      notify(`${removed} ${action === 'clear-videos' ? 'video eliminati' : 'foto eliminate'}.`);
    } else if (action === 'reset-print') {
      if (!window.confirm('Riportare le impostazioni di stampa ai valori predefiniti (10×15, senza bordo né margini)?')) return;
      await api('PATCH', `/api/events/${slug}`, { printSettings: {} });
      editing.delete(slug);
      lastRender = '';
      notify('Impostazioni di stampa ripristinate.');
    } else if (action === 'reprint') {
      await api('POST', `/api/events/${slug}/photos/${button.dataset.id}/reprint`);
      notify('Foto rimessa in coda di stampa.');
    } else if (action === 'delete-photo') {
      if (!window.confirm('Eliminare questa foto?')) return;
      await api('DELETE', `/api/events/${slug}/photos/${button.dataset.id}`);
      notify('Foto eliminata.');
    } else if (action === 'delete-video') {
      if (!window.confirm('Eliminare questo video?')) return;
      await api('DELETE', `/api/events/${slug}/videos/${button.dataset.id}`);
      notify('Video eliminato.');
    }
    await refresh();
  } catch (error) {
    notify(error.message, true);
  }
});

// --- log: GET /api/logs (newest first), new entries every 5 s while the tab is open ----------
const LOG_LEVELS = { info: 'Info', warn: 'Avviso', error: 'Errore' };
let logTypes = {};
let logNewest = 0;
let logOldest = 0;
let logLoading = false;
let logQuery = '';
const logForm = $('#log-filters');

function logParams(extra = {}) {
  const params = new URLSearchParams();
  ['level', 'type', 'event', 'q'].forEach((name) => {
    const value = logForm.elements[name].value.trim();
    if (value) params.set(name, value);
  });
  Object.entries(extra).forEach(([k, v]) => params.set(k, v));
  return params;
}

function setLogEvents(events) {
  const select = logForm.elements.event;
  const wanted = ['', ...events.map((e) => e.slug)];
  if (wanted.join() === [...select.options].map((o) => o.value).join()) return;
  const { value } = select;
  select.innerHTML = wanted.map((slug) => {
    const name = slug ? `${events.find((e) => e.slug === slug).name} (${slug})` : 'Tutti';
    return `<option value="${escapeHtml(slug)}">${escapeHtml(name)}</option>`;
  }).join('');
  select.value = wanted.includes(value) ? value : '';
}

function logTime(time) {
  const d = new Date(time);
  const hms = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return hms;
  return `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} ${hms}`;
}

function logRow(e, isNew) {
  const call = e.method ? `${e.method} ${e.path} → ${e.status} · ${e.ms} ms` : '';
  return `<tr data-id="${Number(e.id)}" class="${escapeHtml(e.level)}${isNew ? ' new' : ''}">
    <td class="when" title="${escapeHtml(new Date(e.time).toLocaleString('it-IT'))}">${escapeHtml(logTime(e.time))}</td>
    <td class="lvl">${escapeHtml(LOG_LEVELS[e.level] || e.level)}</td>
    <td>${escapeHtml(logTypes[e.type] || e.type)}</td>
    <td>${escapeHtml(e.event || '')}</td>
    <td class="msg">${escapeHtml(e.msg)}${e.agent ? ` <span class="muted">(${escapeHtml(e.agent)})</span>` : ''}</td>
    <td class="call">${escapeHtml(call)}</td>
    <td class="muted">${escapeHtml(e.ip || '')}</td>
  </tr>`;
}

function logSummary(retentionDays) {
  const shown = $('#log-rows').children.length;
  $('#log-empty').hidden = shown > 0;
  $('#log-summary').textContent = `${shown} voci mostrate · i log restano ${retentionDays} giorni, poi si cancellano da soli. `
    + 'Non sono registrate le letture periodiche riuscite (aggiornamento di admin, wall e servizio di stampa), '
    + 'né chiavi, contenuti delle chiamate o indirizzi email.';
}

/** mode: 'reset' (from the newest, filters changed), 'new' (after the newest shown), 'more' (older). */
async function loadLogs(mode = 'reset') {
  if (logLoading) return;
  const query = logParams().toString();
  if (mode === 'new' && (query !== logQuery || !logNewest)) mode = 'reset';
  logLoading = true;
  try {
    const extra = { new: { after: logNewest }, more: { before: logOldest } }[mode] || {};
    const data = await api('GET', `/api/logs?${logParams({ ...extra, limit: 300 })}`);
    logTypes = data.types || logTypes;
    const typeSelect = logForm.elements.type;
    if (typeSelect.options.length === 1) {
      typeSelect.insertAdjacentHTML('beforeend', Object.entries(logTypes)
        .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join(''));
    }
    const rows = $('#log-rows');
    const html = data.entries.map((e) => logRow(e, mode === 'new')).join('');
    if (mode === 'reset') {
      rows.innerHTML = html;
      logQuery = query;
      logNewest = data.entries[0]?.id || 0;
      logOldest = data.entries.at(-1)?.id || 0;
      $('#log-more').hidden = !data.more;
    } else if (mode === 'new') {
      rows.insertAdjacentHTML('afterbegin', html);
      if (data.entries.length) logNewest = data.entries[0].id;
      // a long session: the oldest rows go, «Carica voci più vecchie» brings them back
      if (rows.children.length > 3000) {
        while (rows.children.length > 3000) rows.lastElementChild.remove();
        logOldest = Number(rows.lastElementChild.dataset.id) || logOldest;
        $('#log-more').hidden = false;
      }
    } else {
      rows.insertAdjacentHTML('beforeend', html);
      if (data.entries.length) logOldest = data.entries.at(-1).id;
      $('#log-more').hidden = !data.more;
    }
    logSummary(data.retentionDays);
  } catch (error) {
    notify(error.message, true);
  } finally {
    logLoading = false;
  }
}

async function downloadLogs(format) {
  const response = await fetch(`/api/logs/download?${logParams({ format })}`);
  if (response.status === 401) {
    showLogin('Sessione scaduta: rientra.');
    return;
  }
  if (!response.ok) throw new Error(`Errore HTTP ${response.status}`);
  const name = /filename="?([^";]+)"?/.exec(response.headers.get('content-disposition') || '')?.[1] || `photobooth-log.${format}`;
  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let logSearchTimer;
logForm.addEventListener('input', (e) => {
  if (e.target.name === 'live') return;
  clearTimeout(logSearchTimer);
  logSearchTimer = setTimeout(() => loadLogs(), e.target.name === 'q' ? 300 : 0);
});
logForm.addEventListener('submit', (e) => e.preventDefault());
document.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-log]');
  if (!button) return;
  try {
    if (button.dataset.log === 'more') await loadLogs('more');
    else await downloadLogs(button.dataset.format);
  } catch (error) {
    notify(error.message, true);
  }
});
setInterval(() => {
  if (loggedIn && !$('[data-panel="log"]').hidden && logForm.elements.live.checked && !document.hidden) loadLogs('new');
}, 5000);

// already logged in (the session cookie is still valid)?
fetch('/api/admin/session').then((response) => {
  if (!response.ok) return showLogin();
  loggedIn = true;
  return refresh();
}).catch(() => showLogin('Server non raggiungibile.'));
setInterval(refresh, 5000);
