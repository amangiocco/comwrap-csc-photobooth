// Print preview page: the picture just composed for printing, large, with its print status, and the
// previous ones on the side; every new print also opens a classic print dialog. Live through the
// event's WebSocket (live.js: `print`, `print-removed`).
// the page is /<event>/wall or /<event>/print
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '');
const $ = (selector) => document.querySelector(selector);

const STATUS = {
  queued: 'In coda',
  printing: 'In stampa…',
  printed: 'Stampata',
  saved: 'Solo anteprima (nessuna stampante)',
  failed: 'Errore di stampa',
};

let prints = []; // newest first
let selectedId = null; // shown large; null = always the newest
let shownUrl = null;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function render() {
  const ready = prints.filter((p) => p.previewUrl);
  const current = ready.find((p) => p.id === selectedId) || ready[0];
  $('#current').hidden = !current;
  $('#empty').hidden = Boolean(current);
  if (current) {
    const img = $('#current img');
    if (current.previewUrl !== shownUrl) {
      img.src = current.previewUrl;
      img.classList.remove('enter');
      void img.offsetWidth; // eslint-disable-line no-void
      img.classList.add('enter');
      shownUrl = current.previewUrl;
    }
    $('#current').classList.toggle('printing', current.status === 'printing');
    $('#status').innerHTML = `
      <span class="name">${escapeHtml(current.userId || 'Foto')}</span>
      <span class="pill ${escapeHtml(current.status)}">${escapeHtml(STATUS[current.status] || current.status)}</span>
      ${current.error ? `<span class="muted">${escapeHtml(current.error)}</span>` : ''}`;
  } else {
    $('#status').innerHTML = '';
  }
  const waiting = prints.filter((p) => !p.previewUrl && (p.status === 'queued' || p.status === 'printing')).length;
  $('#queue').hidden = !waiting;
  $('#queue').textContent = `${waiting} in preparazione`;
  $('#history').innerHTML = ready.map((p) => `
    <button class="thumb ${p === current ? 'selected' : ''}" data-id="${escapeHtml(p.id)}">
      <img src="${escapeHtml(p.previewUrl)}" alt="" loading="lazy">
      <span>${escapeHtml(p.userId || 'Foto')} · ${escapeHtml(STATUS[p.status] || p.status)}</span>
    </button>`).join('');
}

// --- print dialog: opens with every new preview (also a reprint); with a printer it closes by
// itself shortly after the job has gone to the printer, otherwise it waits for «Chiudi» -------------
const AUTO_CLOSE_MS = 1500;
let dialogId = null;
let closeTimer = null;

function closeDialog() {
  clearTimeout(closeTimer);
  dialogId = null;
  $('#dialog').classList.remove('open');
}

function updateDialog(print) {
  if (print.id !== dialogId) return;
  const noPrinter = !print.printer || print.printer.startsWith('(');
  const status = $('#d-status');
  status.className = `d-status ${print.status}`;
  if (print.status === 'printed') {
    status.innerHTML = '<span class="check">✓</span> Stampa avviata';
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeDialog, AUTO_CLOSE_MS);
  } else if (print.status === 'saved') {
    status.innerHTML = 'Nessuna stampante collegata: il foglio è solo in anteprima.';
  } else if (print.status === 'failed') {
    status.textContent = `Errore: ${print.error || 'stampa non riuscita'}`;
  } else {
    status.innerHTML = `<span class="spinner"></span> ${noPrinter ? 'Preparazione…' : 'Invio alla stampante…'}`;
  }
}

function openDialog(print) {
  clearTimeout(closeTimer);
  dialogId = print.id;
  const { paper } = print;
  const portrait = !paper || paper.heightMm >= paper.widthMm;
  $('#dialog .sheet').style.aspectRatio = paper ? `${paper.widthMm} / ${paper.heightMm}` : '2 / 3';
  $('#dialog .sheet img').src = print.previewUrl;
  const noPrinter = !print.printer || print.printer.startsWith('(');
  $('#d-printer').textContent = noPrinter ? 'Nessuna stampante (solo anteprima)' : print.printer;
  $('#d-copies').textContent = String(print.copies || 1);
  $('#d-sheets').textContent = `${print.copies || 1} ${print.copies > 1 ? 'fogli' : 'foglio'}`;
  const layout = print.layout || {};
  const size = paper
    ? `${(paper.widthMm / 10).toLocaleString('it-IT')} × ${(paper.heightMm / 10).toLocaleString('it-IT')} cm`
    : 'come il template';
  $('#d-paper').textContent = layout.paper && !layout.paper.startsWith('Personalizzato') ? `${layout.paper} · ${size}` : size;
  $('#d-orientation').textContent = portrait ? 'Verticale' : 'Orizzontale';
  $('#d-border').textContent = layout.border || 'Senza bordo (al vivo)';
  $('#d-margins').textContent = layout.margins || 'Nessuno';
  $('#d-fit').textContent = layout.fit || 'Intera, senza tagli';
  $('#d-user').textContent = print.userId || '—';
  $('#dialog').classList.add('open');
  updateDialog(print);
}

$('#d-close').addEventListener('click', closeDialog);
$('#dialog').addEventListener('click', (e) => {
  if (e.target.id === 'dialog') closeDialog();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDialog();
});

function upsert(print) {
  const index = prints.findIndex((p) => p.id === print.id);
  const before = index === -1 ? null : prints[index];
  // a new picture: first preview of this photo, or a new one after a reprint
  const isNewPreview = print.previewUrl && print.previewAt !== before?.previewAt;
  if (index === -1) prints.unshift(print);
  else prints[index] = print;
  prints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (isNewPreview) {
    selectedId = null; // it always comes to the front
    openDialog(print);
  } else {
    updateDialog(print);
  }
  render();
}

async function resync() {
  const response = await fetch(`/api/events/${encodeURIComponent(slug)}/prints`, { cache: 'no-store' });
  if (!response.ok) {
    $('#empty').textContent = response.status === 404 ? `Evento «${slug}» non trovato` : 'Server non raggiungibile';
    prints = [];
    render();
    return;
  }
  const data = await response.json();
  document.title = `${data.name} · stampe`;
  $('#empty').textContent = 'In attesa della prima stampa…';
  prints = data.prints;
  render();
}

function connect() {
  openLive(slug, {
    onOpen: () => resync().catch(() => {}),
    onClose: () => resync().catch(() => {}),
    on: {
      print: upsert,
      'print-removed': ({ id }) => {
        prints = prints.filter((p) => p.id !== id);
        if (selectedId === id) selectedId = null;
        if (dialogId === id) closeDialog();
        render();
      },
      status(data) {
        if (data.deleted) resync().catch(() => {});
      },
    },
  });
}

$('#history').addEventListener('click', (e) => {
  const button = e.target.closest('[data-id]');
  if (!button) return;
  selectedId = button.dataset.id === prints.find((p) => p.previewUrl)?.id ? null : button.dataset.id;
  render();
});

connect();
