# Live Translate

Bilingual live transcription in a single static page. Speak into your microphone — or drop in an
audio file — and watch two transcripts stream side by side: what was said, and what it means in
another language.

There is no backend. The page runs entirely in your browser and talks straight to the OpenAI API
with your own key, which makes it deployable to GitHub Pages as plain files.

```
┌──────────────────────────┬──────────────────────────┐
│  SOURCE                  │  TRANSLATION — Spanish   │
├──────────────────────────┼──────────────────────────┤
│ 0:04  Good morning       │ 0:05  Buenos días a      │
│       everyone, and      │       todos, y gracias   │
│       thanks for joining │       por acompañarnos ▍ │
└──────────────────────────┴──────────────────────────┘
```

## What it costs

Two models run in parallel on the same audio:

| Model | Job | Price |
|---|---|---|
| `gpt-realtime-translate` | translated transcript | $0.034 / min |
| `gpt-live-transcribe` | source transcript | $0.017 / min |
| | **total** | **$0.051 / min** (~$3.06/hr) |

Billing is per minute of audio **sent**, so an idle-but-running tab still costs money. The app has a
spending guard (default $2.00) and a 60-minute auto-stop for exactly that reason. The meter in the
header is an estimate and ignores tier discounts.

## Run it locally

No build step, no dependencies, no npm.

```bash
python tools/serve.py          # http://localhost:8000/
```

`localhost` counts as a secure context, so microphone access works. Opening `index.html` as a
`file://` URL will **not** work — ES modules and `getUserMedia` both require a real origin.

Use `tools/serve.py` rather than `python -m http.server`. On Windows, Python takes MIME types from
the registry, where `.js` is often mapped to `text/plain`; browsers refuse to execute an ES module
served as `text/plain`, so the page loads its HTML and CSS and then does nothing at all, with no
visible error. `tools/serve.py` forces the correct types (and disables caching, which matters while
iterating). GitHub Pages serves `.js` correctly, so this only affects local development.

If you already loaded the page under `python -m http.server`, the browser has the modules cached as
`text/plain` and will keep refusing them even after you switch servers. One hard reload
(<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>) clears it.

## Deploy to GitHub Pages

```bash
git init -b main
git add -A
git commit -m "Live bilingual transcription (BYOK)"
```

Create an empty repo named `live-translate` on github.com, then:

```bash
git remote add origin https://github.com/<you>/live-translate.git
git push -u origin main
```

In the repo: **Settings ▸ Pages ▸ Source: Deploy from a branch ▸ Branch: `main` ▸ Folder: `/ (root)`
▸ Save.** The site is live at `https://<you>.github.io/live-translate/` in about a minute, and every
later push redeploys in ~30 seconds.

The empty `.nojekyll` file at the root is required — without it Pages runs the tree through Jekyll,
which silently drops paths beginning with an underscore. Every asset path in the app is relative for
the same reason: an absolute `/styles.css` resolves outside the project subpath and 404s.

## About your API key

The key goes to `api.openai.com` and nowhere else. There is no server in this project, so there is
nothing to log it and no one to trust but OpenAI and yourself.

Storage is an explicit choice, defaulting to **don't remember**:

| Option | Where it lives |
|---|---|
| Don't remember | Page memory only. Gone on reload. |
| This tab | `sessionStorage`. Gone when the tab closes. |
| This device | `localStorage`. Persists until cleared. |

**The one that deserves a warning is "This device."** Every project published under
`https://<you>.github.io` shares a single browser origin, so any other page you have ever hosted on
that account can read a key stored there. A custom domain or a dedicated GitHub account avoids it;
otherwise prefer one of the first two options.

The page ships a strict Content-Security-Policy that permits network access to OpenAI only, loads no
third-party scripts, fonts or analytics, and never puts transcript text through `innerHTML`. That
closes the obvious exfiltration routes, but be clear-eyed: anyone who managed to inject script into
this page could still smuggle the key out through OpenAI's own API. The mitigation that actually
bounds your risk is scope — create a dedicated OpenAI project, issue a key with a spend limit, use it
here, and revoke it when you are done.

## Capturing without a microphone

The **Shared tab** source captures audio from a browser tab or your whole screen via
`getDisplayMedia()`, so you can caption and translate anything that plays — a foreign-language
video, a recorded call, a meeting — and it works on a machine with no microphone at all.

Two things about Chrome's share picker are easy to get wrong:

- **You must tick the audio box.** "Share tab audio" (tab) or "Share system audio" (entire screen)
  is a separate control from picking the surface. Miss it and Chrome returns a stream with no audio
  track at all — no error — so the app checks for that and says which box to tick, rather than
  sitting there transcribing silence. Chrome remembers your last choice and pre-ticks accordingly,
  which cuts both ways: convenient once set, easy to inherit an old untick without noticing.
- **Sharing a single window captures no audio on Windows.** Pick a tab or the entire screen.

Chrome keeps a "sharing" bar visible for the whole session — that is unavoidable, since the capture
stays alive. Pressing Stop there ends the transcript cleanly.

Display capture delivers **48 kHz stereo**, which the worklet downmixes and resamples to the
24 kHz mono the API expects. That downmix is load-bearing: `AudioWorkletNode` defaults
`channelCountMode` to `'max'`, which would hand the processor two channels and quietly drop one.

### Loopback (local development only)

`?loopback=<fixture>` plays `fixtures/<fixture>.wav` through the identical
`MediaStream → AudioWorklet` path a microphone uses, with no share picker and no human:

```
http://localhost:8000/?loopback=01-english-monologue
```

Because the fixtures carry exact reference text, the resulting transcript is self-checking. The hook
is gated to `localhost`, and the fixtures are gitignored, so it does not exist in a deployed copy.

## On mobile

The layout works: cards collapse to one column, and the two transcripts stack vertically with
independent scrolling, which reads better on a narrow screen than side-by-side would. Fields are
16px so iOS Safari does not force-zoom on focus, tap targets are 44px, the page is sized in `dvh`
rather than `vh` so the collapsing address bar does not clip it, and the transcript columns set
`overscroll-behavior: contain` so scrolling up cannot trigger pull-to-refresh and reload a live run.

What does **not** work on a phone is the capture:

- **Shared tab is unavailable.** Neither iOS Safari nor Android Chrome implements `getDisplayMedia`.
  The app feature-detects this, disables the option and explains why, rather than letting you paste
  a key and fail at Start.
- **Sessions end when the screen does.** Mobile browsers suspend `AudioContext` on backgrounding or
  screen lock, which stops a live transcript. There is no clean fix; it is a real constraint on
  using this on a phone for anything long.

Microphone and audio-file sources work normally.

## Testing with audio files

Recorded input is repeatable in a way that speaking into a mic is not, so a run can be compared to
the last one. Generate a fixed set of clips:

```bash
export OPENAI_API_KEY=sk-...        # PowerShell: $env:OPENAI_API_KEY="sk-..."
python tools/make_fixtures.py
```

This writes four clips to `fixtures/` (gitignored), each aimed at one documented model behavior:

| Clip | What it proves |
|---|---|
| `01-english-monologue` | Baseline en→es. Both columns fill steadily. |
| `02-spanish-monologue` | Run with target = Spanish. The right column should stay **empty**. |
| `03-code-switched` | Spanglish. Translation goes choppy in one direction only. |
| `04-jargon-and-acronyms` | Entity accuracy. Run with Topic empty, then filled. |

Files are played at normal speed, exactly as if spoken — these are realtime models, so there is no
fast-forward.

## Behaviors that look like bugs but aren't

- **An empty translation column.** `gpt-realtime-translate` deliberately says nothing when the
  speech is already in the target language. English in, English out, silence. Fixture 02 exercises
  this on purpose.
- **Choppy output on mixed-language speech.** The model translates the parts that need it and stays
  quiet through the rest, so Spanglish → English reads as gaps. Fixture 03.
- **Names and product terms come out wrong in the left column.** Put the subject matter in **Topic**.
  In testing that was what fixed `AC-42`; **Keywords** is accepted by the API but never echoed back
  in the session object and changed nothing measurable, so don't rely on it.
- **The columns don't line up row for row.** They can't: the translation lags, and it goes silent
  during target-language speech. Both columns are stamped from the same audio clock instead, and the
  `Δ` pill in the header shows the current lag.
- **Language detection resets after a reconnect.** There is no session resume. A dropped socket
  starts a fresh session that re-detects the source language from scratch.

## How it works

```
  Microphone ──┐
               ├─► AudioContext 24 kHz ─► AudioWorklet ─► PCM16 ─┬─► gpt-realtime-translate ─► right
  Audio file ──┘   (resampled + mono)                            └─► gpt-live-transcribe    ─► left
```

One audio pipeline feeds two independent WebSocket sessions. Both connect over
`Sec-WebSocket-Protocol` (browsers cannot set WebSocket headers), using a short-lived `ek_` client
secret minted immediately beforehand, so the long-lived `sk-` key only ever rides one brief `fetch`.

### What the API actually accepts

These were established by probing the live API, and several contradict the published guides. They
are the reason `tools/smoke_test.py` exists — run it after any change to `js/session.js`:

```bash
pip install websockets            # the only dev dependency, not needed by the app
python tools/smoke_test.py 15     # streams a fixture through both endpoints
```

- **`turn_detection` is refused** by `gpt-live-transcribe` (*"Turn detection is not supported for
  this transcription model"*), so there is no server VAD. Every delta in an uncommitted stretch
  carries the **same `item_id`**, and `.completed` never fires unless you send
  `input_audio_buffer.commit` yourself. Both columns therefore segment locally, in `js/transcript.js`.
- **`languages: []` is a 400**, not an ignored empty value. Because one bad field rejects the entire
  `session.update`, that single mistake yields a permanently empty source column with no other
  symptom. Only non-empty fields go on the wire.
- **`keywords` and `delay` are accepted but never echoed** in the returned session object, and an
  A/B run over the jargon fixture showed no difference. `prompt` *is* echoed and does help.
- **`/v1/realtime/transcription_sessions` is a 404** despite being listed as the model's endpoint.
  Transcription secrets mint at `/v1/realtime/client_secrets` with `{session:{type:"transcription"}}`.
- **The TTS fixtures are streaming WAVs** whose RIFF and data sizes are both `0xFFFFFFFF`. Chrome
  clamps to the real byte length; `decodeToMono24k` sizes its buffer from the decoded frame count
  rather than `duration` so a stricter decoder cannot trigger a huge allocation.

Two more details worth knowing if you plan to modify this:

- The translations endpoint uses **`session.`-prefixed** event names — `session.update`,
  `session.input_audio_buffer.append`, `session.output_transcript.delta`. Every other realtime
  endpoint uses bare names. Mixing them up fails silently.
- The subprotocol array must be exactly `["realtime", "openai-insecure-api-key." + token]`. Adding
  the `openai-beta.realtime-v1` entry that most tutorials still show now kills the session with
  `beta_api_shape_disabled`.

### Files

| | |
|---|---|
| `index.html` · `styles.css` | Shell, CSP, two-column layout |
| `js/app.js` | Lifecycle, UI wiring, cost meter, spending guard |
| `js/session.js` | Auth, both socket clients, reconnect, close handshake |
| `js/audio.js` · `js/pcm16-worklet.js` | Mic capture, resampling, PCM16 encoding |
| `js/file-source.js` | Decode and pace an audio file at 1× |
| `js/transcript.js` | Delta accumulation, segmentation, batched rendering |
| `tools/serve.py` | Local dev server with correct JS MIME types (dev only) |
| `tools/make_fixtures.py` | Test clip generator (dev only) |
| `tools/smoke_test.py` | Verifies the realtime wire contract (dev only) |

## Limits

Translation targets one of thirteen languages — Spanish, Portuguese, French, Japanese, Russian,
Chinese, German, Korean, Hindi, Indonesian, Vietnamese, Italian, English — from 70+ detected source
languages. Changing the target mid-run works without reconnecting.

No word-level timestamps, no speaker labels, no confidence scores; `gpt-live-transcribe` doesn't
provide them. The translated *audio* the API returns is discarded — this app is about text — and
discarding it saves no money, because billing is on input.

On a tier-1 account the limit is 50 audio-minutes per minute, and two concurrent sessions consume it
twice as fast.
