const apiKeyInput = document.querySelector('#apiKey');
const toggleBtn = document.querySelector('#toggle');
const statusEl = document.querySelector('#status');
const transcriptionEl = document.querySelector('#transcription');
const translationEl = document.querySelector('#translation');

const TRANSLATOR_PROMPT = `You are a professional simultaneous interpreter. Listen to the speaker's audio and translate everything into natural, fluent Tranditional Chinese as quickly as possible. Deliver concise sentences and update your transcription continuously as confidence improves.`;

let pc = null;
let dc = null;
let localStream = null;
let remoteAudio = null;
let isRunning = false;

const createSegment = (overrides = {}) => ({
  text: '',
  final: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

const createPanel = (element, placeholder) => {
  const store = new Map();
  const setActive = (active) => {
    element.dataset.active = active ? 'true' : 'false';
  };
  return {
    element,
    placeholder,
    store,
    setActive,
    activate() {
      setActive(true);
    },
    reset() {
      store.clear();
      element.textContent = placeholder;
      element.scrollTop = 0;
      setActive(false);
    },
    render() {
      renderPanel(store, element, placeholder);
    },
  };
};

const panels = {
  translation: createPanel(translationEl, 'Waiting for translation…'),
  transcription: createPanel(transcriptionEl, 'Waiting for speech…'),
};

const translationStore = panels.translation.store;
const transcriptionStore = panels.transcription.store;

const withSegment = (store, key, mutator) => {
  const entry = store.get(key) || createSegment();
  mutator(entry);
  entry.updatedAt = Date.now();
  store.set(key, entry);
  return entry;
};

const noop = () => {};

const showPanel = (panel) => {
  panel.activate();
  panel.render();
};

const showPanels = (...panelList) => {
  panelList.forEach(showPanel);
};

const mutatePanel = (panel, key, mutator = noop) => {
  withSegment(panel.store, key, mutator);
  showPanel(panel);
};

const getResponseId = (payload) => payload?.response?.id || payload?.response_id;

const safeConsoleError = (...args) => {
  if (window?.console?.error) {
    console.error(...args);
  }
};

function setStatus(message) {
  statusEl.textContent = message;
}

function resetDisplays() {
  panels.translation.reset();
  panels.transcription.reset();
}

function renderPanel(store, targetEl, placeholder) {
  if (store.size === 0) {
    targetEl.textContent = placeholder;
    targetEl.scrollTop = 0;
    return;
  }

  const segments = Array.from(store.values())
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(({ text = '', final }) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return '';
      }
      return final ? trimmed : `${trimmed} …`;
    })
    .filter(Boolean);

  targetEl.textContent = segments.join('\n>> ');
  requestAnimationFrame(() => {
    targetEl.scrollTop = targetEl.scrollHeight;
  });
}

function handleServerEvent(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (err) {
    safeConsoleError('Non-JSON event', event.data);
    return;
  }

  if (window?.console?.debug) {
    console.debug('server.event', message);
  }

  const { type } = message;

  if (type === 'session.created') {
    setStatus('Session ready — listening…');
    return;
  }

  if (type === 'error' || type === 'session.error' || message.error) {
    const detail = message.message || message.error?.message || 'Unknown error from Realtime API.';
    setStatus(`Error: ${detail}`);
    return;
  }

  if (type === 'input_audio_buffer.speech_started') {
    setStatus('Speech detected…');
    showPanel(panels.transcription);
    return;
  }

  if (type === 'input_audio_buffer.speech_stopped') {
    setStatus('Processing…');
    return;
  }

  if (type === 'response.done') {
    const doneId = getResponseId(message);
    if (doneId && translationStore.has(doneId) && message?.response?.status === 'cancelled') {
      mutatePanel(panels.translation, doneId, (entry) => {
        entry.final = true;
      });
    }
    setStatus('Listening…');
    return;
  }

  if (
    type === 'conversation.item.input_audio_transcription.delta' ||
    type === 'conversation.item.input_audio_transcription.completed'
  ) {
    const itemId = message?.item_id || 'unknown';
    const contentIndex = message?.content_index ?? 0;
    const key = `${itemId}:${contentIndex}`;

    if (type.endsWith('.delta')) {
      const chunk = message.delta;
      if (!chunk) {
        return;
      }
      mutatePanel(panels.transcription, key, (entry) => {
        entry.text += chunk;
      });
      return;
    }

    const transcript = message.transcript;
    mutatePanel(panels.transcription, key, (entry) => {
      if (transcript) {
        entry.text = transcript;
      }
      entry.final = true;
    });
    return;
  }

  const responseId = getResponseId(message);
  if (!responseId) {
    return;
  }

  if (type === 'response.created') {
    mutatePanel(panels.translation, responseId);
    return;
  }

  if (type === 'response.output_text.delta') {
    const chunk = message.delta;
    if (!chunk) {
      return;
    }
    mutatePanel(panels.translation, responseId, (entry) => {
      entry.text += chunk;
    });
    return;
  }

  if (type === 'response.output_text.done') {
    const full = message.text;
    mutatePanel(panels.translation, responseId, (entry) => {
      if (full) {
        entry.text = full;
      }
      entry.final = true;
    });
  }
}

async function startSession() {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus('Enter your OpenAI API key to start.');
    apiKeyInput.focus();
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('getUserMedia is not supported in this browser.');
    return;
  }

  setStatus('Minting ephemeral token…');
  apiKeyInput.disabled = true;
  toggleBtn.disabled = true;
  toggleBtn.textContent = 'Connecting…';
  resetDisplays();

  let ephemeralKey;
  try {
    ephemeralKey = await mintEphemeralKey(apiKey);
  } catch (err) {
    safeConsoleError(err);
    resetUiAfterFailure(err.message || 'Failed to mint ephemeral token.');
    return;
  }

  setStatus('Ephemeral token acquired — requesting microphone…');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
  } catch (err) {
    safeConsoleError(err);
    resetUiAfterFailure('Microphone permission was denied.');
    return;
  }

  setStatus('Initializing connection…');

  try {
    pc = new RTCPeerConnection();
    remoteAudio = new Audio();
    remoteAudio.autoplay = true;

    pc.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        setStatus('Connected — listening…');
        showPanels(panels.transcription, panels.translation);
      }
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        stopSession('Connection closed.');
      }
    };

    localStream.getAudioTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });

    dc = pc.createDataChannel('oai-events');
    dc.addEventListener('message', handleServerEvent);
    dc.addEventListener('open', () => {
      // Ensure the session sticks to text output and translation instructions.
      sendRealtimeEvent({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          output_modalities: ['text'],
          audio: {
            input: {
              transcription: {
                model: 'gpt-4o-transcribe'
              },
              turn_detection: {
                type: 'server_vad',
                interrupt_response: false,
                prefix_padding_ms: 100,
                silence_duration_ms: 100,
              }
            }
          },
          instructions: TRANSLATOR_PROMPT,
        }
      });
      setStatus('Session ready — listening…');
      showPanels(panels.transcription, panels.translation);
    });
    dc.addEventListener('close', () => {
      if (isRunning) {
        setStatus('Data channel closed.');
      }
    });
    dc.addEventListener('error', (event) => {
      safeConsoleError('Realtime data channel error', event);
    });

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);

    setStatus('Connecting to Realtime API…');

    const answerSdp = await createRealtimeSession(ephemeralKey, offer.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    isRunning = true;
    toggleBtn.disabled = false;
    toggleBtn.textContent = 'Stop';
    setStatus('Finalizing connection…');
    showPanels(panels.transcription, panels.translation);
  } catch (err) {
    safeConsoleError(err);
    resetUiAfterFailure(err.message || 'Failed to start session.');
  }
}

const readError = (response) =>
  response.text().then((text) => {
    try {
      const parsed = JSON.parse(text);
      return parsed?.error?.message || parsed?.message || text;
    } catch (err) {
      return text;
    }
  });

async function assertOk(response) {
  if (response.ok) {
    return response;
  }
  throw new Error((await readError(response)) || `OpenAI API error (${response.status})`);
}

async function mintEphemeralKey(apiKey) {
  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: 'gpt-realtime'
	  }
    }),
  });

  const data = await (await assertOk(response)).json();
  const ephemeralKey = data?.value;

  if (!ephemeralKey) {
    throw new Error('Realtime API did not return an ephemeral token.');
  }

  return ephemeralKey;
}

async function createRealtimeSession(ephemeralKey, offerSdp) {
  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    body: offerSdp,
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      'Content-Type': 'application/sdp',
    },
  });

  return await (await assertOk(response)).text();
}

function sendRealtimeEvent(payload) {
  if (!dc || dc.readyState !== 'open') {
    return;
  }
  try {
    dc.send(JSON.stringify(payload));
  } catch (err) {
    safeConsoleError('Failed to send realtime event', err);
  }
}

function cleanupConnections() {
  if (dc) {
    try {
      dc.close();
    } catch (_) {}
  }
  if (pc) {
    try {
      pc.close();
    } catch (_) {}
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  if (remoteAudio) {
    remoteAudio.srcObject = null;
  }
  dc = null;
  pc = null;
  localStream = null;
  remoteAudio = null;
}

function resetUiAfterFailure(message) {
  stopSession(message);
  resetDisplays();
}

function stopSession(message = 'Stopped.') {
  const statusMessage = message === 'Stopped.' && !isRunning ? 'Idle' : message;
  isRunning = false;
  cleanupConnections();
  apiKeyInput.disabled = false;
  toggleBtn.disabled = false;
  toggleBtn.textContent = 'Start listening';
  panels.translation.setActive(false);
  panels.transcription.setActive(false);
  setStatus(statusMessage);
}

toggleBtn.addEventListener('click', () => {
  if (isRunning) {
    stopSession();
  } else {
    startSession();
  }
});

resetDisplays();
setStatus('Idle');
