/**
 * Wiring. The only module that touches both the DOM and the sessions.
 */
import {
  createMicSource, createDisplaySource, createLoopbackSource,
  listInputDevices, describeSourceError, pcmToBase64,
} from './audio.js';
import { createFileSource, decodeToMono24k } from './file-source.js';
import { createTranslateSession, createTranscribeSession } from './session.js';
import { createSourceStream, createTargetStream } from './transcript.js';

const RATE_PER_MIN = 0.034 + 0.017; // translate + live transcribe
const IDLE_LIMIT_MS = 60 * 60 * 1000;
const STORE_KEY = 'lt.key';

const $ = (id) => document.getElementById(id);

// Local-only test hook. ?loopback=<fixture> plays fixtures/<fixture>.wav through
// the same MediaStream -> AudioWorklet path a microphone uses, so the capture
// pipeline can be exercised end to end against known reference text with no
// share picker and no human. Gated to localhost: the fixtures are gitignored and
// simply do not exist in a deployed copy.
const LOOPBACK = (() => {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return local ? new URLSearchParams(location.search).get('loopback') : null;
})();

const el = {
  lang: $('lang'), start: $('start'), stop: $('stop'),
  chipSrc: $('chip-src'), chipTgt: $('chip-tgt'), lag: $('lag'), cost: $('cost'),
  meters: $('meters'), metersToggle: $('meters-toggle'), metersSummary: $('meters-summary'),
  setup: $('setup'), stage: $('stage'), notice: $('notice'), log: $('log'),
  key: $('key'), forget: $('forget'),
  device: $('device'), level: $('level'), micOpts: $('mic-opts'), fileOpts: $('file-opts'),
  displayOpts: $('display-opts'), levelWrap: $('level-wrap'), srcUnsupported: $('src-unsupported'),
  drop: $('drop'), file: $('file'), pick: $('pick'), fileInfo: $('file-info'),
  prompt: $('prompt'), keywords: $('keywords'), languages: $('languages'), delay: $('delay'),
  budget: $('budget'),
  srcScroll: $('src-scroll'), tgtScroll: $('tgt-scroll'),
  srcJump: $('src-jump'), tgtJump: $('tgt-jump'),
  srcTitle: $('src-title'), tgtTitle: $('tgt-title'),
};

const sourceStream = createSourceStream(el.srcScroll);
const targetStream = createTargetStream(el.tgtScroll);

let running = false;
let source = null;
let translate = null;
let transcribe = null;
let fileSamples = null;
let fileName = '';

let costTimer = null;
let liveMs = 0;
let lastTick = 0;
let startedAt = 0;
let lagEma = null;

// ---------- small helpers ----------

function log(line) {
  const t = new Date().toISOString().slice(11, 19);
  el.log.textContent += t + '  ' + line + '\n';
  el.log.scrollTop = el.log.scrollHeight;
}

function notify(message) {
  el.notice.textContent = message || '';
  el.notice.hidden = !message;
}

function chip(node, state, label) {
  node.dataset.state = state;
  node.textContent = label;
  syncMeters();
}

/**
 * Keep the collapsed chip meaningful. It is the only meter visible on a narrow
 * screen, so it has to answer "is this working, and what is it costing" without
 * being opened.
 */
function syncMeters() {
  const a = el.chipSrc.dataset.state;
  const b = el.chipTgt.dataset.state;
  const state =
    (a === 'error' || b === 'error') ? 'error'
    : (a === 'live' && b === 'live') ? 'live'
    : [a, b].some((x) => x === 'connecting' || x === 'reconnecting') ? 'connecting'
    : 'idle';

  el.metersToggle.dataset.state = state;
  el.metersSummary.textContent = el.cost.textContent;
  el.metersToggle.setAttribute('aria-label',
    'Status ' + state + ', ' + el.cost.textContent + '. Show detail.');
}

function setMetersOpen(open) {
  el.meters.dataset.open = open ? 'true' : 'false';
  el.metersToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function langName() {
  return el.lang.options[el.lang.selectedIndex].text;
}

// ---------- key storage ----------

function storeMode() {
  const picked = document.querySelector('input[name="store"]:checked');
  return picked ? picked.value : 'none';
}

function loadKey() {
  try {
    const fromSession = sessionStorage.getItem(STORE_KEY);
    if (fromSession) { el.key.value = fromSession; select('store', 'session'); el.forget.hidden = false; return; }
    const fromLocal = localStorage.getItem(STORE_KEY);
    if (fromLocal) { el.key.value = fromLocal; select('store', 'local'); el.forget.hidden = false; }
  } catch (e) { /* storage can be blocked entirely; not fatal */ }
}

function select(name, value) {
  const node = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
  if (node) node.checked = true;
}

function persistKey() {
  const mode = storeMode();
  const value = el.key.value.trim();
  try {
    sessionStorage.removeItem(STORE_KEY);
    localStorage.removeItem(STORE_KEY);
    if (!value) return;
    if (mode === 'session') sessionStorage.setItem(STORE_KEY, value);
    if (mode === 'local') localStorage.setItem(STORE_KEY, value);
    el.forget.hidden = mode === 'none';
  } catch (e) { /* ignore */ }
}

function forgetKey() {
  try { sessionStorage.removeItem(STORE_KEY); localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ }
  el.key.value = '';
  select('store', 'none');
  el.forget.hidden = true;
}

// ---------- cost meter ----------

function fmtClock(ms) {
  const total = Math.floor(ms / 1000);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

function tickCost() {
  const now = performance.now();
  // Measure the real gap rather than incrementing: background tabs throttle
  // this interval to about once a minute and a counter would undercount.
  if (running) liveMs += now - lastTick;
  lastTick = now;

  const cost = (liveMs / 60000) * RATE_PER_MIN;
  el.cost.textContent = fmtClock(liveMs) + ' · $' + cost.toFixed(2);
  syncMeters();

  const cap = parseFloat(el.budget.value);
  if (running && cap > 0 && cost >= cap) {
    notify('Stopped at the $' + cap.toFixed(2) + ' spending guard.');
    stop();
  }
  if (running && now - startedAt > IDLE_LIMIT_MS) {
    notify('Stopped after 60 minutes.');
    stop();
  }
}

// ---------- audio source selection ----------

async function refreshDevices() {
  const devices = await listInputDevices();
  const current = el.device.value;
  el.device.replaceChildren();
  const dflt = document.createElement('option');
  dflt.value = '';
  dflt.textContent = 'Default input';
  el.device.appendChild(dflt);
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    // Labels are empty strings until permission has been granted once.
    opt.textContent = d.label || 'Input ' + (el.device.length);
    el.device.appendChild(opt);
  }
  el.device.value = current;
}

function sourceMode() {
  const picked = document.querySelector('input[name="src"]:checked');
  return picked ? picked.value : 'mic';
}

async function loadFile(file) {
  if (!file) return;
  notify('');
  el.fileInfo.hidden = false;
  el.fileInfo.textContent = 'Decoding ' + file.name + '…';
  try {
    fileSamples = await decodeToMono24k(file);
    fileName = file.name;
    const secs = fileSamples.length / 24000;
    el.fileInfo.textContent = fileName + ' — ' + fmtClock(secs * 1000) + ' at 24 kHz mono';
    log('decoded ' + fileName + ' (' + secs.toFixed(1) + 's)');
  } catch (err) {
    fileSamples = null;
    el.fileInfo.textContent = '';
    el.fileInfo.hidden = true;
    notify('Could not decode that file: ' + (err.message || err));
  }
}

// ---------- run lifecycle ----------

function contextFromForm() {
  const split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  return {
    prompt: el.prompt.value.trim(),
    keywords: split(el.keywords.value),
    languages: split(el.languages.value),
    delay: el.delay.value,
  };
}

function onSessionError(e) {
  log('[' + e.scope + '] ' + (e.code ? e.code + ': ' : '') + e.message);
  if (e.fatal) {
    notify(e.message);
    stop();
  }
}

async function start() {
  const apiKey = el.key.value.trim();
  if (!apiKey) { notify('Paste an OpenAI API key first.'); el.key.focus(); return; }
  if (!LOOPBACK && sourceMode() === 'file' && !fileSamples) {
    notify('Choose an audio file first.'); return;
  }

  notify('');
  persistKey();
  el.start.disabled = true;

  sourceStream.reset();
  targetStream.reset();
  el.srcTitle.textContent = 'Source';
  el.tgtTitle.textContent = 'Translation — ' + langName();

  translate = createTranslateSession({
    apiKey,
    language: el.lang.value,
    onTarget: ({ delta, elapsedMs }) => {
      targetStream.apply({ delta }, elapsedMs != null ? elapsedMs : mediaTime());
      updateLag(elapsedMs);
    },
    onStatus: (state) => chip(el.chipTgt, state, 'target · ' + state),
    onError: onSessionError,
  });

  transcribe = createTranscribeSession({
    apiKey,
    context: contextFromForm(),
    onSource: (evt) => sourceStream.apply(evt, mediaTime()),
    onStatus: (state) => chip(el.chipSrc, state, 'source · ' + state),
    onError: onSessionError,
  });

  const onFrame = (frame) => {
    const b64 = pcmToBase64(frame);
    translate.appendAudio(b64);
    transcribe.appendAudio(b64);
  };

  try {
    const live = {
      onFrame,
      onLevel: (v) => el.level.style.setProperty('--level', v.toFixed(3)),
      onError: (err) => log('audio: ' + err.message),
    };

    if (LOOPBACK) {
      source = createLoopbackSource({
        ...live,
        url: './fixtures/' + LOOPBACK + '.wav',
        onEnd: () => { notify('Loopback fixture finished.'); stop(); },
      });
    } else if (sourceMode() === 'file') {
      source = createFileSource({
        samples: fileSamples,
        onFrame,
        onProgress: (ratio) => { el.srcTitle.textContent = 'Source — ' + Math.round(ratio * 100) + '%'; },
        onEnd: () => { notify('Reached the end of ' + fileName + '.'); stop(); },
      });
    } else if (sourceMode() === 'display') {
      source = createDisplaySource({
        ...live,
        // Chrome's "Stop sharing" bar ends the track; without this the run would
        // sit there live and silent, still being billed.
        onEnd: () => { notify('Screen sharing stopped.'); stop(); },
      });
    } else {
      source = createMicSource({ ...live, deviceId: el.device.value || undefined });
    }

    const info = await source.start();
    log('source=' + source.kind + ' graph=' + info.sampleRate + 'Hz'
        + (info.trackRate ? ' track=' + info.trackRate + 'Hz/' + (info.channels || '?') + 'ch' : ''));
    if (source.kind === 'mic') refreshDevices();
  } catch (err) {
    notify(describeSourceError(source ? source.kind : sourceMode(), err));
    el.start.disabled = false;
    await teardown();
    return;
  }

  // Only now open the sockets. Audio captured while they connect is not lost:
  // appendAudio queues inside each client until session.created arrives.
  try {
    await Promise.all([translate.start(), transcribe.start()]);
  } catch (err) {
    notify(err.message || String(err));
    el.start.disabled = false;
    await teardown();
    return;
  }

  el.setup.hidden = true;
  el.stage.hidden = false;

  running = true;
  startedAt = lastTick = performance.now();
  liveMs = 0;
  lagEma = null;
  costTimer = setInterval(tickCost, 1000);

  el.start.hidden = true;
  el.stop.hidden = false;
  el.start.disabled = false;
}

function mediaTime() {
  return source ? source.mediaTimeMs() : 0;
}

function updateLag(elapsedMs) {
  if (elapsedMs == null || !source) return;
  // elapsed_ms is on the audio timeline, and so is our send clock, so the
  // difference is the genuine translation lag rather than a wall-clock guess.
  const raw = Math.max(0, source.mediaTimeMs() - elapsedMs);
  lagEma = lagEma == null ? raw : lagEma * 0.8 + raw * 0.2;
  el.lag.hidden = false;
  el.lag.textContent = 'Δ ' + (lagEma / 1000).toFixed(1) + 's';
}

async function teardown() {
  const jobs = [];
  if (source) jobs.push(source.stop());
  // Stop feeding first, then let the sockets drain: the trailing transcript
  // arrives after session.close is sent.
  await Promise.all(jobs).catch(() => {});
  const closers = [];
  if (translate) closers.push(translate.stop());
  if (transcribe) closers.push(transcribe.stop());
  await Promise.all(closers).catch(() => {});
  targetStream.flush();
  source = null; translate = null; transcribe = null;
}

async function stop() {
  if (!running) return;
  running = false;
  el.stop.disabled = true;
  if (costTimer) { clearInterval(costTimer); costTimer = null; }
  tickCost();

  await teardown();

  el.stop.hidden = true;
  el.stop.disabled = false;
  el.start.hidden = false;
  el.setup.hidden = false;
  chip(el.chipSrc, 'idle', 'source');
  chip(el.chipTgt, 'idle', 'target');
  el.level.style.setProperty('--level', '0');
  log('stopped');
}

// ---------- events ----------

el.start.addEventListener('click', () => { start().catch((e) => { notify(String(e)); el.start.disabled = false; }); });
el.stop.addEventListener('click', () => { stop(); });
el.metersToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  setMetersOpen(el.meters.dataset.open !== 'true');
});
// A popover that will not dismiss is worse than no popover.
document.addEventListener('click', (e) => {
  if (!el.meters.contains(e.target)) setMetersOpen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setMetersOpen(false);
});

el.forget.addEventListener('click', forgetKey);
el.key.addEventListener('change', persistKey);
for (const r of document.querySelectorAll('input[name="store"]')) r.addEventListener('change', persistKey);

el.lang.addEventListener('change', () => {
  el.tgtTitle.textContent = 'Translation — ' + langName();
  if (running && translate) {
    translate.setLanguage(el.lang.value);
    targetStream.flush();
    targetStream.divider('— now translating into ' + langName() + ' —');
    log('target language -> ' + el.lang.value);
  }
});

/**
 * Disable capture sources this browser cannot provide, and say why.
 *
 * getDisplayMedia does not exist on mobile browsers at all -- neither iOS
 * Safari nor Android Chrome implement screen or tab capture -- so offering
 * "Shared tab" there would fail only at Start, after the user had already
 * pasted a key.
 */
function detectCapabilities() {
  const md = navigator.mediaDevices;
  const notes = [];

  const disable = (value, why) => {
    const radio = document.querySelector('input[name="src"][value="' + value + '"]');
    if (!radio) return;
    radio.disabled = true;
    const label = radio.closest('label');
    if (label) label.style.opacity = '0.45';
    if (radio.checked) select('src', 'file');
    notes.push(why);
  };

  if (!(md && typeof md.getDisplayMedia === 'function')) {
    disable('display', 'Shared tab needs desktop Chrome or Edge — mobile browsers do not '
      + 'implement screen or tab capture.');
  }
  if (!(md && typeof md.getUserMedia === 'function')) {
    disable('mic', 'Microphone capture needs a secure context (https or localhost).');
  }

  if (notes.length) {
    el.srcUnsupported.textContent = notes.join(' ');
    el.srcUnsupported.hidden = false;
    log('unsupported sources: ' + notes.length);
  }
}

function syncSourcePanels() {
  const mode = sourceMode();
  el.micOpts.hidden = mode !== 'mic';
  el.displayOpts.hidden = mode !== 'display';
  el.fileOpts.hidden = mode !== 'file';
  // The file source paces frames from a decoded buffer and never reports a
  // level, so the meter would sit at zero and read as a fault.
  el.levelWrap.hidden = mode === 'file';
}

for (const r of document.querySelectorAll('input[name="src"]')) {
  r.addEventListener('change', syncSourcePanels);
}
detectCapabilities();
syncSourcePanels();
setMetersOpen(false);
syncMeters();

el.pick.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => loadFile(el.file.files[0]));
el.drop.addEventListener('dragover', (e) => { e.preventDefault(); el.drop.classList.add('over'); });
el.drop.addEventListener('dragleave', () => el.drop.classList.remove('over'));
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  el.drop.classList.remove('over');
  loadFile(e.dataTransfer.files[0]);
});

sourceStream.onPin((pinned) => { el.srcJump.hidden = pinned; });
targetStream.onPin((pinned) => { el.tgtJump.hidden = pinned; });
el.srcJump.addEventListener('click', () => sourceStream.scrollToLive());
el.tgtJump.addEventListener('click', () => targetStream.scrollToLive());
el.srcScroll.addEventListener('scroll', () => { el.srcJump.hidden = sourceStream.isPinned(); });
el.tgtScroll.addEventListener('scroll', () => { el.tgtJump.hidden = targetStream.isPinned(); });

window.addEventListener('beforeunload', (e) => {
  if (!running) return;
  e.preventDefault();
  e.returnValue = '';
});

window.addEventListener('pagehide', () => {
  // No time for the close handshake, but better than a dangling session.
  if (translate) translate.dispose();
  if (transcribe) transcribe.dispose();
});

if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  refreshDevices();
}

loadKey();
if (LOOPBACK) {
  notify('Loopback test mode: audio will come from fixtures/' + LOOPBACK + '.wav, '
         + 'not from the source selected above.');
  log('loopback=' + LOOPBACK);
}
log('ready');
