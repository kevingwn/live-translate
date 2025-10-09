const apiKeyInput = document.querySelector('#apiKey');
const toggleBtn = document.querySelector('#toggle');
const statusEl = document.querySelector('#status');
const transcriptionEl = document.querySelector('#transcription');
const translationEl = document.querySelector('#translation');
const settingsBtn = document.querySelector('#settings');
const settingsDialog = document.querySelector('#settingsDialog');
const settingsForm = document.querySelector('#settingsForm');
const modelSelect = document.querySelector('#modelSelect');
const transcriptionModelSelect = document.querySelector('#transcriptionModel');
const instructionText = document.querySelector('#instructionText');
const turnTypeSelect = document.querySelector('#turnType');
const prefixPaddingInput = document.querySelector('#prefixPadding');
const silenceDurationInput = document.querySelector('#silenceDuration');
const interruptResponseInput = document.querySelector('#interruptResponse');
const autoCommitInput = document.querySelector('#autoCommit');

const DEFAULT_INSTRUCTIONS = `You are a professional simultaneous interpreter. Listen to the speaker's audio and translate everything into natural, fluent Traditional Chinese as quickly as possible. Deliver concise sentences and update your transcription continuously as confidence improves.`;
const DEFAULT_SETTINGS = Object.freeze({
  model: 'gpt-realtime',
  transcriptionModel: 'gpt-4o-transcribe',
  instructions: DEFAULT_INSTRUCTIONS,
  turnDetection: {
    type: 'server_vad',
    interruptResponse: false,
    prefixPaddingMs: 100,
    silenceDurationMs: 100,
  },
  autoCommitThresholdMs: 3000,
});

const cloneSettings = (settings) => JSON.parse(JSON.stringify(settings));
let sessionSettings = cloneSettings(DEFAULT_SETTINGS);

let pc = null;
let dc = null;
let localStream = null;
let remoteAudio = null;
let isRunning = false;
let autoCommitTimer = null;

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

function openSettings() {
  if (!settingsDialog) return;
  populateSettingsForm();
  settingsDialog.hidden = false;
  document.body.style.overflow = 'hidden';
  settingsDialog.querySelector('select, textarea, input')?.focus();
}

function closeSettings() {
  if (!settingsDialog) return;
  settingsDialog.hidden = true;
  document.body.style.overflow = '';
}

function populateSettingsForm() {
  if (!settingsForm) return;
  modelSelect.value = sessionSettings.model;
  transcriptionModelSelect.value = sessionSettings.transcriptionModel;
  instructionText.value = sessionSettings.instructions;
  turnTypeSelect.value = sessionSettings.turnDetection.type;
  prefixPaddingInput.value = sessionSettings.turnDetection.prefixPaddingMs;
  silenceDurationInput.value = sessionSettings.turnDetection.silenceDurationMs;
  interruptResponseInput.checked = Boolean(sessionSettings.turnDetection.interruptResponse);
  autoCommitInput.value = sessionSettings.autoCommitThresholdMs;
  updateTurnDetectionFieldState();
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return fallback;
}

function updateSessionSettingsFromForm(formData) {
  const model = formData.get('model') || sessionSettings.model || DEFAULT_SETTINGS.model;
  const transcriptionModelRaw = formData.get('transcriptionModel');
  const transcriptionModel =
    (typeof transcriptionModelRaw === 'string' && transcriptionModelRaw.trim()) ||
    sessionSettings.transcriptionModel ||
    DEFAULT_SETTINGS.transcriptionModel;
  const rawInstructions = formData.get('instructions');
  const instructions =
    (typeof rawInstructions === 'string' && rawInstructions.trim()) ||
    sessionSettings.instructions ||
    DEFAULT_SETTINGS.instructions;
  const turnType = formData.get('turnType') || sessionSettings.turnDetection.type || DEFAULT_SETTINGS.turnDetection.type;
  const prefixPadding = parseNonNegativeInt(
    formData.get('prefixPadding'),
    sessionSettings.turnDetection.prefixPaddingMs ?? DEFAULT_SETTINGS.turnDetection.prefixPaddingMs
  );
  const silenceDuration = parseNonNegativeInt(
    formData.get('silenceDuration'),
    sessionSettings.turnDetection.silenceDurationMs ?? DEFAULT_SETTINGS.turnDetection.silenceDurationMs
  );
  const interruptResponse = formData.get('interruptResponse') === 'on';
  const autoCommit = parseNonNegativeInt(
    formData.get('autoCommit'),
    sessionSettings.autoCommitThresholdMs ?? DEFAULT_SETTINGS.autoCommitThresholdMs
  );

  sessionSettings = {
    model,
    transcriptionModel,
    instructions,
    turnDetection: {
      type: turnType,
      interruptResponse,
      prefixPaddingMs: prefixPadding,
      silenceDurationMs: silenceDuration,
    },
    autoCommitThresholdMs: autoCommit,
  };
}

function buildSessionConfiguration() {
  const { model, instructions, transcriptionModel, turnDetection } = sessionSettings;
  const audioInput = {};

  if (transcriptionModel) {
    audioInput.transcription = { model: transcriptionModel };
  }

  if (turnDetection?.type === 'server_vad') {
    audioInput.turn_detection = {
      type: 'server_vad',
      interrupt_response: Boolean(turnDetection.interruptResponse),
      prefix_padding_ms: turnDetection.prefixPaddingMs,
      silence_duration_ms: turnDetection.silenceDurationMs,
    };
  } else {
    audioInput.turn_detection = null;
  }

  return {
    type: 'realtime',
    model,
    output_modalities: ['text'],
    instructions,
    audio: {
      input: audioInput,
    },
  };
}

function applySettingsToActiveSession() {
  if (!dc || dc.readyState !== 'open') {
    return;
  }
  sendRealtimeEvent({
    type: 'session.update',
    session: buildSessionConfiguration(),
  });
  if (isRunning) {
    setStatus('Settings updated.');
  }
}

function updateTurnDetectionFieldState() {
  if (!turnTypeSelect) {
    return;
  }
  const disabled = turnTypeSelect.value === 'none';
  prefixPaddingInput.disabled = disabled;
  silenceDurationInput.disabled = disabled;
  interruptResponseInput.disabled = disabled;
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

function clearAutoCommitTimer() {
  if (autoCommitTimer !== null) {
    window.clearTimeout(autoCommitTimer);
    autoCommitTimer = null;
  }
}

function scheduleAutoCommitTimer() {
  if (!sessionSettings.autoCommitThresholdMs) return;
  autoCommitTimer = window.setTimeout(() => {
    if (window?.console?.debug) {
      console.debug('input_audio_buffer.commit (auto)');
    }
    sendRealtimeEvent({ type: 'input_audio_buffer.commit' });
    scheduleAutoCommitTimer();
  }, sessionSettings.autoCommitThresholdMs);
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
    clearAutoCommitTimer();
    scheduleAutoCommitTimer();
    setStatus('Speech detected…');
    showPanel(panels.transcription);
    return;
  }

  if (type === 'input_audio_buffer.speech_stopped') {
    clearAutoCommitTimer();
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
    ephemeralKey = await mintEphemeralKey(apiKey, sessionSettings.model);
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
      applySettingsToActiveSession();
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

async function mintEphemeralKey(apiKey, model) {
  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model
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
  clearAutoCommitTimer();
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

settingsBtn?.addEventListener('click', () => {
  openSettings();
});

settingsDialog?.addEventListener('click', (event) => {
  if (event.target?.dataset?.dismiss !== undefined) {
    closeSettings();
  }
});

[...settingsDialog?.querySelectorAll('[data-dismiss]') || []].forEach((element) => {
  element.addEventListener('click', closeSettings);
});

settingsForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(settingsForm);
  updateSessionSettingsFromForm(formData);
  closeSettings();
  applySettingsToActiveSession();
});

turnTypeSelect?.addEventListener('change', updateTurnDetectionFieldState);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && settingsDialog && !settingsDialog.hidden) {
    closeSettings();
  }
});

resetDisplays();
setStatus('Idle');
populateSettingsForm();
