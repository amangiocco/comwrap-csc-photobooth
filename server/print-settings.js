// Print settings of an event: paper size, orientation, border style, margins, how the picture fits
// the sheet and how the driver scales it. Shared by the server (validation, admin) and the print
// agent (print/layout.js), which applies them to every sheet.
import { HttpError } from './store.js';

// portrait sizes in millimetres; «template» takes the size of the composed picture
export const PAPERS = {
  '10x15': { label: 'Foto 10×15 cm (4×6″)', widthMm: 101.6, heightMm: 152.4 },
  '9x13': { label: 'Foto 9×13 cm (3,5×5″)', widthMm: 88.9, heightMm: 127 },
  '13x18': { label: 'Foto 13×18 cm (5×7″)', widthMm: 127, heightMm: 177.8 },
  '15x20': { label: 'Foto 15×20 cm (6×8″)', widthMm: 152.4, heightMm: 203.2 },
  '20x30': { label: 'Foto 20×30 cm (8×12″)', widthMm: 203.2, heightMm: 304.8 },
  A6: { label: 'A6 (10,5×14,8 cm)', widthMm: 105, heightMm: 148 },
  A5: { label: 'A5 (14,8×21 cm)', widthMm: 148, heightMm: 210 },
  A4: { label: 'A4 (21×29,7 cm)', widthMm: 210, heightMm: 297 },
  template: { label: 'Come il template', widthMm: null, heightMm: null },
  custom: { label: 'Personalizzato', widthMm: null, heightMm: null },
};

export const ORIENTATIONS = {
  auto: 'Automatico (come la foto)',
  portrait: 'Verticale',
  landscape: 'Orizzontale',
};

export const BORDERS = {
  none: 'Senza bordo (al vivo)',
  uniform: 'Bordo uniforme',
  instant: 'Stile istantanea (fascia in basso più alta)',
};

export const FITS = {
  contain: 'Intera, senza tagli',
  cover: 'Riempi il foglio (taglia i bordi)',
};

export const SCALES = {
  fit: 'Adatta all\'area stampabile',
  noscale: 'Dimensione reale',
};

export const DEFAULT_PRINT_SETTINGS = {
  paper: '10x15',
  widthMm: 101.6,
  heightMm: 152.4,
  orientation: 'auto',
  fit: 'contain',
  border: 'none',
  borderMm: 4,
  borderColor: '#ffffff',
  margins: {
    top: 0, right: 0, bottom: 0, left: 0,
  },
  scale: 'fit',
  driverPaper: '',
};

const LIMITS = { size: [20, 1000], margin: [0, 50], border: [0, 50] };

/**
 * Settings with every field valid. With `strict` a wrong field is a 400 listing the problems,
 * otherwise it falls back to the default (for settings already stored).
 */
export function normalizePrintSettings(input, { strict = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const problems = [];
  const pick = (value, allowed, fallback, label) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (Object.hasOwn(allowed, value)) return value;
    problems.push(label);
    return fallback;
  };
  const number = (value, [min, max], fallback, label) => {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(String(value).replace(',', '.'));
    if (Number.isFinite(n) && n >= min && n <= max) return Math.round(n * 10) / 10;
    problems.push(label);
    return fallback;
  };
  const d = DEFAULT_PRINT_SETTINGS;
  const paper = pick(source.paper, PAPERS, d.paper, 'formato carta');
  const preset = PAPERS[paper];
  const settings = {
    paper,
    widthMm: preset.widthMm ?? (paper === 'custom' ? number(source.widthMm, LIMITS.size, d.widthMm, 'larghezza') : null),
    heightMm: preset.heightMm ?? (paper === 'custom' ? number(source.heightMm, LIMITS.size, d.heightMm, 'altezza') : null),
    orientation: pick(source.orientation, ORIENTATIONS, d.orientation, 'orientamento'),
    fit: pick(source.fit, FITS, d.fit, 'adattamento'),
    border: pick(source.border, BORDERS, d.border, 'bordo'),
    borderMm: number(source.borderMm, LIMITS.border, d.borderMm, 'spessore del bordo'),
    borderColor: /^#[0-9a-f]{6}$/i.test(source.borderColor || '') ? source.borderColor.toLowerCase() : d.borderColor,
    margins: {},
    scale: pick(source.scale, SCALES, d.scale, 'scala'),
    driverPaper: String(source.driverPaper || '').trim().slice(0, 60),
  };
  if (source.borderColor && settings.borderColor !== String(source.borderColor).toLowerCase()) problems.push('colore del bordo');
  ['top', 'right', 'bottom', 'left'].forEach((side) => {
    settings.margins[side] = number(source.margins?.[side], LIMITS.margin, 0, `margine ${side}`);
  });
  if (strict && problems.length) {
    throw new HttpError(400, `Impostazioni di stampa non valide: ${problems.join(', ')}.`);
  }
  return settings;
}

const mm = (value) => `${String(value).replace('.', ',')} mm`;

/** Words for the print dialog: { paper, border, margins, fit, orientation }. */
export function describePrintSettings(settings) {
  const { top, right, bottom, left } = settings.margins;
  const same = top === right && right === bottom && bottom === left;
  let margins = same ? mm(top) : `alto ${top} · destra ${right} · basso ${bottom} · sinistra ${left} mm`;
  if (same && top === 0) margins = 'Nessuno';
  let border = BORDERS[settings.border];
  if (settings.border !== 'none') border += `, ${mm(settings.borderMm)}${settings.borderColor !== '#ffffff' ? ` ${settings.borderColor}` : ''}`;
  return {
    paper: PAPERS[settings.paper].label,
    border,
    margins: String(margins).replace(/\./g, ','),
    fit: FITS[settings.fit],
    orientation: ORIENTATIONS[settings.orientation],
  };
}

/** The lists for the admin form. */
export const PRINT_OPTIONS = {
  papers: Object.entries(PAPERS).map(([value, p]) => ({
    value, label: p.label, widthMm: p.widthMm, heightMm: p.heightMm,
  })),
  orientations: ORIENTATIONS,
  borders: BORDERS,
  fits: FITS,
  scales: SCALES,
  defaults: DEFAULT_PRINT_SETTINGS,
};
