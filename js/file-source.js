/**
 * Audio file -> 24 kHz mono PCM16 frames, paced at 1x real time.
 *
 * These are realtime models: bulk-dumping a file breaks the translate
 * session's pacing, so frames go out on a drift-corrected schedule exactly as
 * if someone were speaking them. Same interface as createMicSource.
 */
import { floatToPcm16 } from './audio.js';

const TARGET_RATE = 24000;
const FRAME_MS = 40;
const FRAME_SAMPLES = (TARGET_RATE * FRAME_MS) / 1000; // 960
// A backgrounded tab throttles timers to ~1 Hz. Without a cap we would then
// "catch up" by dumping a second of audio at once, which is exactly the
// faster-than-realtime burst we are trying to avoid. Let the clock slip instead.
const MAX_BURST_FRAMES = 10;
// Decoded audio is held as Float32 at 24 kHz: 60 minutes is ~345 MB resident,
// and would take 60 minutes to stream and cost about $3 to process.
const MAX_MINUTES = 60;

/** Decode any browser-supported container, then resample + downmix to 24 kHz
 *  mono in a single offline render. */
export async function decodeToMono24k(file) {
  const bytes = await file.arrayBuffer();

  const tmp = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await tmp.decodeAudioData(bytes);
  } finally {
    try { await tmp.close(); } catch { /* Safari may already have closed it */ }
  }

  // Derive the length from the decoded frame count rather than `duration`.
  // OpenAI's TTS returns a streaming WAV whose RIFF and data sizes are both
  // 0xFFFFFFFF; Chrome clamps that to the real byte length, but a decoder that
  // trusted the header would report ~24 days and blow up the allocation below.
  const length = Math.max(1, Math.ceil((decoded.length * TARGET_RATE) / decoded.sampleRate));
  const maxLength = MAX_MINUTES * 60 * TARGET_RATE;
  if (length > maxLength) {
    throw new Error(
      `That file decodes to ${Math.round(length / TARGET_RATE / 60)} minutes, over the `
      + `${MAX_MINUTES}-minute limit. It also plays at 1x, so it would take that long to transcribe.`
    );
  }

  const off = new OfflineAudioContext(1, length, TARGET_RATE);
  const node = off.createBufferSource();
  node.buffer = decoded;
  node.connect(off.destination);
  node.start();
  const rendered = await off.startRendering();

  return rendered.getChannelData(0);
}

export function createFileSource({ samples, onFrame, onProgress, onEnd }) {
  let timer = null;
  let running = false;
  let cursor = 0;      // read position in `samples`
  let framesSent = 0;
  let startedAt = 0;

  function tick() {
    if (!running) return;

    const elapsed = performance.now() - startedAt;
    const due = Math.floor(elapsed / FRAME_MS) + 1;
    let budget = MAX_BURST_FRAMES;

    while (framesSent < due && budget-- > 0 && cursor < samples.length) {
      const end = Math.min(cursor + FRAME_SAMPLES, samples.length);
      onFrame(floatToPcm16(samples.subarray(cursor, end)));
      cursor = end;
      framesSent++;
    }

    if (onProgress) onProgress(cursor / samples.length, mediaTimeMs());

    if (cursor >= samples.length) {
      running = false;
      clearInterval(timer);
      if (onEnd) onEnd();
    }
  }

  function mediaTimeMs() {
    return (cursor / TARGET_RATE) * 1000;
  }

  return {
    kind: 'file',
    durationMs: (samples.length / TARGET_RATE) * 1000,
    async start() {
      running = true;
      startedAt = performance.now();
      framesSent = 0;
      timer = setInterval(tick, FRAME_MS / 2);
      return { sampleRate: TARGET_RATE };
    },
    async stop() {
      running = false;
      if (timer) clearInterval(timer);
    },
    pause() { running = false; },
    mediaTimeMs,
  };
}
