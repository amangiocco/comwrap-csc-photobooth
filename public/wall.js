// Video wall: square cards, 6 per row, newest at top-left; older ones shift right and wrap.
// The wall starts with a row of placeholder cards (e.g. a YouTube video) that new videos push along.
// A video arriving live is first presented centre stage (see runShowcase).
// the page is /<event>/wall or /<event>/print
const slug = decodeURIComponent(location.pathname.split('/').filter(Boolean)[0] || '');
const COLUMNS = 6; // keep in sync with --columns in wall.html
const GAP = 0.0025; // gap between cards, as a fraction of the width (--gap: .25cqw)
const grid = document.getElementById('grid');
const scroller = document.getElementById('scroller');
const message = document.getElementById('message');

let videos = []; // newest first
let placeholder = null;
let active = false;
const cards = new Map(); // key -> element; elements are never moved, only reordered with CSS
let firstRender = true;

function say(text) {
  message.textContent = text || '';
  message.classList.toggle('show', Boolean(text));
}

/** How many cards fit the first screen, counting the last row even if it is only partly visible. */
function capacity() {
  const gap = scroller.clientWidth * GAP;
  const size = (scroller.clientWidth - gap * (COLUMNS + 1)) / COLUMNS;
  const rows = Math.max(1, Math.ceil((scroller.clientHeight - gap) / (size + gap)));
  return rows * COLUMNS;
}

function videoElement(url) {
  const video = document.createElement('video');
  Object.assign(video, {
    src: url, muted: true, autoplay: true, loop: true, playsInline: true, preload: 'auto',
  });
  video.play().catch(() => {});
  return video;
}

function mediaElement(item) {
  if (!item.youtube) return videoElement(item.url);
  const iframe = document.createElement('iframe');
  const id = encodeURIComponent(item.youtube);
  iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}`
    + '&controls=0&playsinline=1&rel=0&disablekb=1&iv_load_policy=3';
  iframe.allow = 'autoplay; encrypted-media';
  iframe.tabIndex = -1;
  iframe.loading = 'lazy';
  return iframe;
}

// videos play only while their card is on screen: files are paused, YouTube players are started
// (one at a time, see startYoutube) and go back to their still cover when scrolled away
const visibility = new IntersectionObserver((entries) => {
  entries.forEach(({ target, isIntersecting }) => {
    target.dataset.visible = String(isIntersecting);
    if (target.dataset.youtube) {
      if (isIntersecting) startYoutube(target);
      else setYoutubeLive(target, false);
      return;
    }
    const video = target.querySelector('video');
    if (!video) return;
    if (isIntersecting) video.play().catch(() => {});
    else video.pause();
  });
}, { root: scroller });

// Every visible YouTube card plays, but the players start one at a time: a page opening twenty of
// them at once jams the browser. Until its turn a card shows the still cover.
const YOUTUBE_STAGGER_MS = 500;
const youtubeQueue = [];
let youtubeTimer = null;

function startYoutube(card) {
  if (card.dataset.live === 'true' || youtubeQueue.includes(card)) return;
  youtubeQueue.push(card);
  if (!youtubeTimer) nextYoutube();
}

function nextYoutube() {
  youtubeTimer = null;
  // cards removed or scrolled away while waiting are skipped
  let card = youtubeQueue.shift();
  while (card && (!card.isConnected || card.dataset.visible !== 'true')) card = youtubeQueue.shift();
  if (!card) return;
  setYoutubeLive(card, true);
  // a pause after every start, also when nothing is waiting yet: the next card waits for it
  youtubeTimer = setTimeout(nextYoutube, YOUTUBE_STAGGER_MS);
}

function youtubeCover(id) {
  const img = document.createElement('img');
  img.src = `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
  img.alt = '';
  img.className = 'cover';
  return img;
}

function setYoutubeLive(card, live) {
  if (card.dataset.live === String(live)) return;
  card.dataset.live = String(live);
  const { youtube } = card.dataset;
  card.replaceChildren(live ? mediaElement({ youtube }) : youtubeCover(youtube));
}

function createCard(item) {
  const card = document.createElement('div');
  card.className = firstRender ? 'card' : 'card new';
  if (item.youtube) {
    card.dataset.youtube = item.youtube;
    setYoutubeLive(card, false); // the observer starts it once it is on screen
  } else {
    card.append(mediaElement(item));
  }
  visibility.observe(card);
  return card;
}

const EASE = 'cubic-bezier(.65, 0, .35, 1)';

function render() {
  const items = [];
  if (active) {
    videos.forEach((v) => items.push({ key: v.id, url: v.url, youtube: v.youtubeId }));
    // the initial cards behave like the oldest videos: pushed along by new ones, and gone once
    // they leave the first screen
    const firstScreen = capacity();
    for (let i = 0; placeholder && i < COLUMNS && items.length < firstScreen; i += 1) {
      items.push(placeholder.type === 'youtube'
        ? { key: `placeholder-${i}`, youtube: placeholder.id }
        : { key: `placeholder-${i}`, url: placeholder.url });
    }
  }
  const before = new Map();
  cards.forEach((card, key) => before.set(key, card.getBoundingClientRect()));
  const keep = new Set(items.map((item) => item.key));
  cards.forEach((card, key) => {
    if (!keep.has(key)) {
      visibility.unobserve(card);
      card.remove();
      cards.delete(key);
    }
  });
  items.forEach((item, index) => {
    let card = cards.get(item.key);
    if (!card) {
      card = createCard(item);
      cards.set(item.key, card);
      grid.append(card);
    }
    card.style.order = index;
  });
  // cards that changed place slide there from where they were
  if (!firstRender) {
    cards.forEach((card, key) => {
      const from = before.get(key);
      if (!from) return;
      const to = card.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (dx || dy) {
        card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 800, easing: EASE });
      }
    });
  }
  firstRender = false;
}

// --- showcase: a new video first appears centred, framed, with «<userid>, ecco il tuo video»,
// then flies into the first card of the grid ---------------------------------------------------
const stage = document.getElementById('showcase');
const stageTitle = stage.querySelector('.title');
const stageFrame = stage.querySelector('.frame');
const stageMedia = stage.querySelector('.media');
let showcaseMs = 8000;
const queue = []; // videos waiting for their showcase
let showing = null;
let showToken = 0;

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const inShowcase = (id) => showing?.id === id || queue.some((v) => v.id === id);

/** Hides the stage at once (no fade, or the frame would be seen jumping back to the centre). */
function hideStage() {
  stage.style.transition = 'none';
  stage.classList.remove('show', 'leaving');
  stageFrame.getAnimations().forEach((animation) => animation.cancel());
  stageMedia.replaceChildren();
  void stage.offsetWidth; // eslint-disable-line no-void
  stage.style.transition = '';
}

/** Moves the videos waiting for a showcase straight into the grid (event off, showcase disabled). */
function flushShowcase() {
  showToken += 1;
  const waiting = [...(showing ? [showing] : []), ...queue];
  queue.length = 0;
  showing = null;
  hideStage();
  waiting.forEach((video) => {
    if (!videos.some((v) => v.id === video.id)) videos.unshift(video);
  });
}

async function runShowcase() {
  // out of sight (another tab, or a window covering this one) the timers are slowed down to one
  // a minute: the showcase waits until the wall is seen again
  if (showing || !queue.length || document.hidden) return;
  showing = queue.shift();
  const video = showing;
  showToken += 1;
  const my = showToken;
  stageTitle.textContent = video.userId ? `${video.userId}, ecco il tuo video` : 'Ecco il tuo video';
  stageMedia.replaceChildren(mediaElement({ url: video.url, youtube: video.youtubeId }));
  stage.classList.add('show');
  scroller.scrollTo({ top: 0, behavior: 'smooth' }); // the video will land in the first card
  await wait(showcaseMs);
  if (my !== showToken) return;
  scroller.scrollTop = 0;

  videos.unshift(video);
  render();
  const card = cards.get(video.id);
  card.classList.remove('new');
  card.style.visibility = 'hidden';
  const from = stageFrame.getBoundingClientRect();
  const to = card.getBoundingClientRect();
  stage.classList.add('leaving');
  const flight = stageFrame.animate([
    { transform: 'none' },
    { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width})` },
  ], { duration: 1100, easing: EASE, fill: 'forwards' });
  await flight.finished.catch(() => {});
  card.style.visibility = '';
  if (my !== showToken) return;
  showing = null;
  hideStage();
  runShowcase();
}

function addVideo(video) {
  if (videos.some((v) => v.id === video.id) || inShowcase(video.id)) return;
  if (!showcaseMs || !active) {
    videos.unshift(video);
    render();
    return;
  }
  queue.push(video);
  runShowcase();
}

function removeVideo(id) {
  const queued = queue.findIndex((v) => v.id === id);
  if (queued !== -1) queue.splice(queued, 1);
  if (showing?.id === id) {
    showToken += 1;
    showing = null;
    hideStage();
    runShowcase();
  }
  videos = videos.filter((v) => v.id !== id);
  render();
}

let live = false; // the WebSocket is connected
let loaded = false;
let pollTimer = null;

// one reload at a time, in order: an answer asked for before a video arrived must never come
// after a newer one and take the video off the wall
let syncing = null;
let syncAgain = false;
function resync() {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = (async () => {
    try {
      do {
        syncAgain = false;
        await reload(); // eslint-disable-line no-await-in-loop
      } while (syncAgain);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

async function reload() {
  const response = await fetch(`/api/events/${encodeURIComponent(slug)}/wall`, { cache: 'no-store' });
  if (!response.ok) {
    active = false;
    flushShowcase();
    videos = [];
    render();
    say(response.status === 404 ? `Evento «${slug}» non trovato` : 'Server non raggiungibile');
    return;
  }
  const data = await response.json();
  placeholder = data.placeholder;
  showcaseMs = Math.max(0, Number(data.showcaseSeconds ?? 8)) * 1000;
  active = data.active;
  const all = data.videos.slice().reverse(); // newest first
  // videos the wall had not seen yet (missed while the live connection was down): they get
  // their showcase like the ones announced live
  const known = new Set(videos.map((v) => v.id));
  const arrived = loaded && active ? all.filter((v) => !known.has(v.id) && !inShowcase(v.id)) : [];
  // a video flying from the showcase into its card is in the grid already: it stays there
  videos = all.filter((v) => known.has(v.id) || (!inShowcase(v.id) && !arrived.includes(v)));
  if (!active) flushShowcase();
  render();
  arrived.reverse().forEach(addVideo); // oldest first
  loaded = true;
  say(live ? '' : 'Non collegato in diretta: i nuovi video arrivano con qualche secondo di ritardo');
}

// without the live connection the wall asks the server every few seconds
function poll() {
  clearTimeout(pollTimer);
  if (live) return;
  pollTimer = setTimeout(() => resync().catch(() => say('Server non raggiungibile')).finally(poll), 5000);
}

function connect() {
  openLive(slug, {
    onOpen: () => {
      live = true;
      clearTimeout(pollTimer);
      resync().catch(() => say('Server non raggiungibile'));
    },
    // closed or refused (e.g. event deleted): show what the server says, then it reconnects
    onClose: () => {
      live = false;
      resync().catch(() => say('Server non raggiungibile')).finally(poll);
    },
    on: {
      status(data) {
        active = Boolean(data.active) && !data.deleted;
        if (!active) flushShowcase();
        if (data.deleted) videos = [];
        render();
      },
      video: addVideo,
      removed: (data) => removeVideo(data.id),
      // something the wall shows changed (sample cards on or off): reload it
      settings: () => resync().catch(() => {}),
    },
  });
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 200);
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
document.addEventListener('click', () => {
  toggleFullscreen();
  grid.querySelectorAll('video').forEach((video) => video.play().catch(() => {}));
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});

// mouse: cursor and scrollbar appear while it moves; after a minute untouched, back to the top
let pointerTimer;
let idleTimer;
function touched() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => scroller.scrollTo({ top: 0, behavior: 'smooth' }), 60000);
}
document.addEventListener('mousemove', () => {
  document.body.classList.add('pointer');
  clearTimeout(pointerTimer);
  pointerTimer = setTimeout(() => document.body.classList.remove('pointer'), 2500);
  touched();
});
['wheel', 'touchstart', 'keydown'].forEach((type) => document.addEventListener(type, touched, { passive: true }));

// keep the screen awake while the wall is visible
let wakeLock = null;
async function keepAwake() {
  try {
    if (document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock?.request('screen');
      wakeLock?.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or not allowed */ }
}
document.addEventListener('visibilitychange', keepAwake);
// out of sight in the middle of a showcase: it starts again from the beginning once seen again
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    runShowcase();
    return;
  }
  if (!showing) return;
  const video = showing;
  showToken += 1;
  showing = null;
  hideStage();
  if (videos.some((v) => v.id === video.id)) {
    // already flying into its card: it simply stays there
    const card = cards.get(video.id);
    if (card) card.style.visibility = '';
  } else {
    queue.unshift(video);
  }
});
keepAwake();

connect();
