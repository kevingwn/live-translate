/**
 * Audio capture -> 24 kHz mono PCM16 frames.
 *
 * One graph, three ways to get a MediaStream into it: the microphone, a shared
 * tab/screen via getDisplayMedia, and a local-only loopback that plays a fixture
 * for testing. All three go through createMediaStreamSource -> pcm16-worklet, so
 * whichever you use exercises the same code path.
 *
 * Exposes the same shape as FileSource (start/stop/onFrame/mediaTimeMs) so
 * nothing downstream needs to know which source is running.
 */

const TARGET_RATE = 24000;
const FRAME_MS = 40;

/** Base64-encode PCM bytes. Chunked: spreading a large array into
 *  String.fromCharCode blows the call stack. */
export function pcmToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Float32 [-1,1] -> little-endian PCM16. Explicit DataView rather than
 *  trusting platform endianness. */
export function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < float32.length; i++) {
    const s = float32[i];
    const c = s < -1 ? -1 : s > 1 ? 1 : s;
    view.setInt16(i * 2, c < 0 ? c * 0x8000 : c * 0x7fff, true);
  }
  return out;
}

export async function listInputDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  } catch {
    return [];
  }
}

/** Thrown when a capture surface was shared without its audio. */
export class NoAudioTrackError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoAudioTrackError';
  }
}

export function describeMicError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Enable it for this site in your browser’s address-bar permissions, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No microphone was found. Plug one in and reload, or switch the audio source to a shared tab.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The microphone is in use by another app. Teams, Zoom and Discord hold it exclusively on Windows — close them and try again.';
    case 'OverconstrainedError':
      return 'That input device rejected the requested settings.';
    default:
      return 'Could not open the microphone: ' + ((err && err.message) || err);
  }
}

export function describeCaptureError(err) {
  if (err instanceof NoAudioTrackError) return err.message;
  switch (err && err.name) {
    case 'NotAllowedError':
      return 'Screen sharing was cancelled, so there is nothing to listen to.';
    case 'NotFoundError':
      return 'No shareable surface was available.';
    case 'NotSupportedError':
    case 'TypeError':
      return 'This browser cannot capture audio from a shared surface. Chrome on desktop can.';
    default:
      return 'Could not start screen capture: ' + ((err && err.message) || err);
  }
}

export function describeSourceError(kind, err) {
  return kind === 'mic' ? describeMicError(err) : describeCaptureError(err);
}

/**
 * The shared capture graph. `acquire()` returns {stream, dispose?} -- the only
 * thing that differs between a microphone, a shared tab and the test loopback.
 */
export function createStreamSource({ kind, acquire, onFrame, onLevel, onError, onEnd }) {
  let ctx = null;
  let stream = null;
  let dispose = null;
  let node = null;
  let analyser = null;
  let sink = null;
  let levelTimer = null;
  let samplesSent = 0;
  let running = false;

  async function start() {
    // Build the context and compile the worklet BEFORE acquiring the stream.
    // addModule is a network fetch plus a compile, and a live source does not
    // wait politely: doing this afterwards drops roughly the first second of
    // audio, which showed up as a missing "Good morning" at the head of the
    // very first end-to-end run.
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_RATE });
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule(new URL('./pcm16-worklet.js', import.meta.url));

    let got;
    try {
      got = await acquire();
    } catch (err) {
      // Don't leak the context when the user cancels the picker.
      try { await ctx.close(); } catch { /* already closing */ }
      ctx = null;
      throw err;
    }
    stream = got.stream;
    dispose = got.dispose || null;

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new NoAudioTrackError(
        'That surface was shared without audio. Start again and make sure “Share tab audio” '
        + '(or “Share system audio” for a whole screen) is ticked in the picker. '
        + 'Sharing a single window cannot capture audio on Windows; pick a tab or the entire screen.'
      );
    }

    // We asked for video only because Chrome will not hand over a display
    // capture without it. Stopping that track leaves the audio track live and
    // saves Chrome encoding frames nobody looks at.
    for (const t of stream.getVideoTracks()) t.stop();

    // Fires when the user hits Chrome's "Stop sharing" bar, or the loopback
    // element reaches its end.
    audioTracks[0].addEventListener('ended', () => { if (onEnd) onEnd(); });

    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm16-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      // Display capture hands back 48 kHz *stereo*. AudioWorkletNode defaults
      // channelCountMode to 'max', which ignores channelCount and would deliver
      // two channels -- the worklet would then read only the left one and
      // silently discard half the audio. 'explicit' forces a proper downmix.
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { targetRate: TARGET_RATE, frameMs: FRAME_MS },
    });

    node.port.onmessage = (e) => {
      if (!running) return;
      const frame = new Int16Array(e.data);
      samplesSent += frame.length;
      onFrame(frame);
    };

    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);

    // A worklet only runs while the graph is pulled toward a destination, so
    // route it through a silent gain node rather than leaving it dangling.
    sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    if (onLevel) {
      const buf = new Uint8Array(analyser.fftSize);
      levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs(buf[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        onLevel(peak);
      }, 100);
    }

    running = true;
    const settings = audioTracks[0].getSettings ? audioTracks[0].getSettings() : {};
    return { sampleRate: ctx.sampleRate, trackRate: settings.sampleRate, channels: settings.channelCount };
  }

  async function stop() {
    running = false;
    if (levelTimer) clearInterval(levelTimer);
    try {
      if (node) node.port.postMessage('flush');
    } catch { /* already torn down */ }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    try {
      if (dispose) dispose();
      if (node) node.disconnect();
      if (sink) sink.disconnect();
      if (ctx && ctx.state !== 'closed') await ctx.close();
    } catch (err) {
      if (onError) onError(err);
    }
  }

  return {
    kind,
    start,
    stop,
    // Media time on the same clock the API reports elapsed_ms against.
    mediaTimeMs: () => (samplesSent / TARGET_RATE) * 1000,
    pause() { running = false; },
  };
}

export function createMicSource({ deviceId, onFrame, onLevel, onError, onEnd }) {
  return createStreamSource({
    kind: 'mic',
    onFrame, onLevel, onError, onEnd,
    acquire: async () => {
      const base = {
        channelCount: 1,
        // Left off deliberately: the translate session applies its own
        // near-field noise reduction, and stacking both thins out speech.
        noiseSuppression: false,
        echoCancellation: true,
        autoGainControl: true,
      };
      if (deviceId) base.deviceId = { exact: deviceId };
      try {
        return { stream: await navigator.mediaDevices.getUserMedia({ audio: base }) };
      } catch (err) {
        if (err && err.name === 'OverconstrainedError') {
          return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }) };
        }
        throw err;
      }
    },
  });
}

/**
 * Capture a shared tab or screen. Microphone-style constraints are deliberately
 * not sent: they are meaningless for a display surface and risk being rejected.
 */
export function createDisplaySource({ onFrame, onLevel, onError, onEnd }) {
  return createStreamSource({
    kind: 'display',
    onFrame, onLevel, onError, onEnd,
    acquire: async () => {
      // `video: false` is a spec-level TypeError, not a Chrome quirk: the
      // getDisplayMedia algorithm rejects outright when video is not requested.
      // So ask for video and drop the track immediately in createStreamSource.
      return {
        stream: await navigator.mediaDevices.getDisplayMedia({
          video: true,
          // Plain `true`, never {exact: ...}: mic-style constraints are not
          // honoured for a display track, and exact values can throw
          // OverconstrainedError for no benefit.
          audio: true,
          displaySurface: 'browser',      // open the picker on the Tab pane
          systemAudio: 'include',         // ...but still offer it for a whole screen
          selfBrowserSurface: 'exclude',  // this tab plays nothing worth capturing
          surfaceSwitching: 'include',
          monitorTypeSurfaces: 'include',
        }),
      };
    },
  });
}

/**
 * Local test loopback: play a file and capture it back as a real MediaStream, so
 * the whole graph runs exactly as it would from a microphone but with known
 * reference audio and no share picker. Never reachable in production -- app.js
 * gates it to localhost, and the fixtures it plays are gitignored.
 */
export function createLoopbackSource({ url, onFrame, onLevel, onError, onEnd }) {
  let el = null;
  return createStreamSource({
    kind: 'loopback',
    onFrame, onLevel, onError, onEnd,
    acquire: async () => {
      el = new Audio(url);
      el.preload = 'auto';
      // Chrome can hand back a silent capture for an element that is muted or
      // at zero volume, so this plays audibly on purpose.
      el.volume = 1;
      document.body.appendChild(el);

      // Deliberately NOT waiting for `canplaythrough`: the TTS fixtures are
      // streaming WAVs whose data size is 0xFFFFFFFF, so the element believes
      // it has ~24 days to buffer and the event never fires. Waiting for
      // playback to actually begin is both sufficient and honest.
      const started = new Promise((resolve, reject) => {
        el.addEventListener('playing', resolve, { once: true });
        el.addEventListener('error', () => reject(new Error('Could not load ' + url)), { once: true });
      });
      el.load();
      await el.play();   // rejects with NotAllowedError without a user gesture
      await Promise.race([
        started,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Playback never started for ' + url)), 5000)),
      ]);

      const capture = el.captureStream || el.mozCaptureStream;
      if (!capture) throw new Error('This browser cannot captureStream() a media element.');
      // Capture after playback has started; capturing earlier can yield a track
      // that never produces samples.
      const stream = capture.call(el);

      // A captured track does not necessarily end when the media does -- it can
      // stay live and silent, which left the first run billing against nothing
      // after the clip finished. Watch the element itself.
      el.addEventListener('ended', () => { if (onEnd) onEnd(); }, { once: true });

      return {
        stream,
        dispose: () => { try { el.pause(); el.remove(); } catch { /* gone already */ } },
      };
    },
  });
}
