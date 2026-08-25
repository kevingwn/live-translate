/**
 * Auth + both realtime sockets. Knows nothing about the DOM; emits normalized
 * callbacks that app.js wires to the transcript view.
 */

const API = 'https://api.openai.com';
const WSS = 'wss://api.openai.com';
const TRANSLATE_MODEL = 'gpt-realtime-translate';
const TRANSCRIBE_MODEL = 'gpt-live-transcribe';

const CLOSE_WATCHDOG_MS = 3000;
const MAX_QUEUED_FRAMES = 750;   // 30s at 40ms per frame
const BACKOFF_MS = [1000, 2000, 4000];

/**
 * Mint a short-lived ek_ secret so the raw sk- key only ever rides one brief
 * fetch instead of a long-lived socket.
 *
 * Returns null (rather than throwing) when the endpoint is not available for
 * this session shape, so the caller can fall back to key-in-subprotocol.
 * Genuine auth failures still throw, since those are the user's to fix.
 */
async function mintEphemeral(apiKey, url, sessionBody) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: sessionBody }),
    });
  } catch (e) {
    return null; // network/CORS trouble: let the socket path report it
  }

  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const err = new Error((body.error && body.error.message) || 'Key rejected (' + res.status + ')');
    err.status = res.status;
    err.code = body.error && body.error.code;
    throw err;
  }
  if (!res.ok) return null;

  const body = await res.json().catch(() => null);
  // Documented shape is a bare {value}; tolerate the nested form too.
  const value = body && (body.value || (body.client_secret && body.client_secret.value));
  return value || null;
}

/**
 * Auth rides in the subprotocol array because browsers cannot set WebSocket
 * headers. The list must be exactly these two entries: adding the
 * openai-beta.realtime-v1 token that most tutorials still show now kills the
 * session immediately with beta_api_shape_disabled.
 */
function subprotocols(token) {
  return ['realtime', 'openai-insecure-api-key.' + token];
}

function isCleanClose(code) {
  return code === 1000 || code === 1005;
}

/** Shared plumbing: connect, queue-until-created, reconnect ladder, close handshake. */
function createSocketClient(spec) {
  const {
    name, url, buildSessionUpdate, appendType, closeType, closeDoneEvent,
    handleEvent, onStatus, onError, mint,
  } = spec;

  let ws = null;
  let ready = false;      // session.created seen: safe to send
  let queue = [];
  let closing = false;
  let disposed = false;
  let attempt = 0;
  let closeWatchdog = null;
  let resolveClosed = null;
  let queueWarned = false;

  function status(state, detail) {
    if (onStatus) onStatus(state, detail);
  }

  function rawSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function send(obj) {
    // The socket can open before session.created arrives; hold until then.
    // Audio now starts flowing before connect is even attempted, so this queue
    // spans the whole handshake rather than a sliver of it. Cap it: if we are
    // still not live after this much audio, the connection is in trouble and
    // unbounded growth helps nobody.
    if (!ready) {
      queue.push(obj);
      if (queue.length > MAX_QUEUED_FRAMES) {
        queue.splice(0, queue.length - MAX_QUEUED_FRAMES);
        if (!queueWarned) {
          queueWarned = true;
          if (onError) {
            onError({
              scope: name,
              message: 'Still connecting after 30s of audio; dropping the oldest frames.',
              code: 'queue_overflow',
              fatal: false,
            });
          }
        }
      }
      return;
    }
    rawSend(obj);
  }

  function reportFatal(err) {
    status('error', err && err.message);
    if (onError) {
      onError({
        scope: name,
        message: (err && err.message) || String(err),
        code: err && err.code,
        fatal: true,
      });
    }
  }

  function finishClose() {
    if (closeWatchdog) { clearTimeout(closeWatchdog); closeWatchdog = null; }
    try { if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000); } catch (e) { /* noop */ }
    status('closed');
    if (resolveClosed) { resolveClosed(); resolveClosed = null; }
  }

  async function connect() {
    status('connecting');
    const token = await mint();
    if (disposed) return;

    ws = new WebSocket(url, subprotocols(token));

    ws.onopen = () => { attempt = 0; };

    ws.onmessage = (ev) => {
      let event;
      try { event = JSON.parse(ev.data); } catch (e) { return; }

      switch (event.type) {
        case 'session.created':
          ready = true;
          rawSend(buildSessionUpdate());
          for (const q of queue) rawSend(q);
          queue = [];
          status('live');
          return;

        case 'session.updated':
          status('live');
          return;

        case 'session.closed':
          finishClose();
          return;

        case 'error': {
          const e = event.error || {};
          // Per the API reference most errors are recoverable and the session
          // stays open, so surface them without tearing anything down.
          if (onError) {
            onError({
              scope: name,
              message: e.message || 'Unknown error',
              code: e.code,
              fatal: e.code === 'invalid_api_key' || e.code === 'beta_api_shape_disabled',
            });
          }
          return;
        }

        default:
          handleEvent(event);
          // Some endpoints have no session.closed; they signal the end of the
          // drain with their own terminal event instead.
          if (closing && closeDoneEvent && event.type === closeDoneEvent) finishClose();
      }
    };

    ws.onclose = (ev) => {
      ready = false;
      if (closing || disposed) { finishClose(); return; }

      if (isCleanClose(ev.code) || attempt >= BACKOFF_MS.length) {
        status('closed', ev.reason);
        return;
      }

      const wait = BACKOFF_MS[attempt++];
      status('reconnecting', wait);
      setTimeout(() => { if (!disposed) connect().catch(reportFatal); }, wait);
    };
  }

  return {
    name,
    async start() { await connect(); },

    appendAudio(base64) {
      if (closing || disposed) return;
      send({ type: appendType, audio: base64 });
    },

    update(patch) { send({ type: 'session.update', session: patch }); },

    /**
     * Graceful close. The trailing transcript arrives *after* session.close is
     * sent, so onmessage stays live until session.closed or the watchdog fires.
     */
    async stop() {
      if (disposed) return;
      closing = true;
      if (!ws || ws.readyState !== WebSocket.OPEN) { disposed = true; finishClose(); return; }

      status('closing');
      const done = new Promise((resolve) => { resolveClosed = resolve; });
      if (closeType) rawSend({ type: closeType });
      else finishClose();

      closeWatchdog = setTimeout(finishClose, CLOSE_WATCHDOG_MS);
      await done;
      disposed = true;
    },

    dispose() {
      disposed = true;
      try { if (ws) ws.close(1000); } catch (e) { /* noop */ }
    },
  };
}

/**
 * gpt-realtime-translate. Note the session.-prefixed event vocabulary, which is
 * unique to this endpoint: every other realtime endpoint uses bare names.
 */
export function createTranslateSession({ apiKey, language, onTarget, onStatus, onError }) {
  let current = language;

  const audioConfig = () => ({
    input: { noise_reduction: { type: 'near_field' } },
    // No input.transcription on purpose: source captions come from the
    // parallel gpt-live-transcribe session, so enabling it here would buy a
    // second transcriber we never read.
    output: { language: current },
  });

  const client = createSocketClient({
    name: 'translate',
    url: WSS + '/v1/realtime/translations?model=' + TRANSLATE_MODEL,
    appendType: 'session.input_audio_buffer.append',
    closeType: 'session.close',
    closeDoneEvent: 'session.closed',
    buildSessionUpdate: () => ({ type: 'session.update', session: { audio: audioConfig() } }),
    mint: async () => {
      const ek = await mintEphemeral(apiKey, API + '/v1/realtime/translations/client_secrets', {
        model: TRANSLATE_MODEL,
        audio: audioConfig(),
      });
      return ek || apiKey;
    },
    handleEvent: (event) => {
      // Translated audio is generated and billed whether or not we ask for it,
      // and there is no modality switch to decline it. Drop it before any
      // allocation: it is roughly 500 kbps we never play.
      if (event.type === 'session.output_audio.delta') return;
      if (event.type === 'session.output_transcript.delta') {
        onTarget({ delta: event.delta || '', elapsedMs: event.elapsed_ms });
      }
    },
    onStatus,
    onError,
  });

  return Object.assign({}, client, {
    setLanguage(next) {
      current = next;
      // Live re-language: the model is fixed at session creation but the
      // target language is not, so this needs no reconnect.
      client.update({ audio: { output: { language: next } } });
    },
  });
}

/**
 * gpt-live-transcribe. Bare event names, and .completed ordering is explicitly
 * not guaranteed, so the caller reconciles by item_id.
 */
export function createTranscribeSession({ apiKey, context, onSource, onStatus, onError }) {
  const cfg = Object.assign({ prompt: '', keywords: [], languages: [], delay: 'low' }, context || {});

  /**
   * Only non-empty fields go on the wire. Verified against the live API:
   *   - `languages: []` is a hard 400 (`empty_array`), and because one bad
   *     field rejects the whole session.update, that single mistake silently
   *     yields an empty source column.
   *   - `turn_detection` is refused outright by this model ("Turn detection is
   *     not supported for this transcription model"), so there is no server VAD
   *     here and no per-utterance .completed unless we commit by hand.
   *   - `keywords` and `delay` are accepted but never echoed back in the
   *     session object, so treat their effect as unproven.
   */
  const buildInput = () => {
    const transcription = { model: TRANSCRIBE_MODEL, delay: cfg.delay };
    if (cfg.prompt) transcription.prompt = cfg.prompt;
    if (cfg.keywords.length) transcription.keywords = cfg.keywords;
    if (cfg.languages.length) transcription.languages = cfg.languages;
    return {
      format: { type: 'audio/pcm', rate: 24000 },
      transcription,
      noise_reduction: { type: 'near_field' },
    };
  };

  const client = createSocketClient({
    name: 'transcribe',
    url: WSS + '/v1/realtime?intent=transcription',
    appendType: 'input_audio_buffer.append',
    // This endpoint has no session.close. Committing the buffer is what forces
    // the model to finish: it emits a terminal .completed carrying the
    // authoritative transcript. Without it the socket was closed the instant
    // the audio stopped, and the last few words never arrived -- the very first
    // end-to-end run lost "watch it settle" off the end of the source column
    // while the translate session, which does drain, rendered it in full.
    closeType: 'input_audio_buffer.commit',
    closeDoneEvent: 'conversation.item.input_audio_transcription.completed',
    buildSessionUpdate: () => ({
      type: 'session.update',
      session: { type: 'transcription', audio: { input: buildInput() } },
    }),
    mint: async () => {
      const ek = await mintEphemeral(apiKey, API + '/v1/realtime/client_secrets', {
        type: 'transcription',
        audio: { input: buildInput() },
      });
      return ek || apiKey;
    },
    handleEvent: (event) => {
      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        onSource({ itemId: event.item_id, delta: event.delta || '' });
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        onSource({ itemId: event.item_id, text: event.transcript || '', final: true });
      }
    },
    onStatus,
    onError,
  });

  return Object.assign({}, client, {
    setContext(next) {
      Object.assign(cfg, next);
      client.update({ type: 'transcription', audio: { input: buildInput() } });
    },
  });
}
