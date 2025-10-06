# Live Translate

A minimal, mobile-friendly browser app that streams microphone audio to OpenAI's Realtime API, surfaces live Tranditional Chinese translations, and shows the original transcription side-by-side. Designed for static hosting (for example, GitHub Pages).

## Features
- One-tap start/stop microphone capture with clear status updates.
- Client-side Realtime API connection over WebRTC; no custom backend required.
- Live translation stream powered by `gpt-realtime`.
- Separate original-language transcription stream via `gpt-4o-transcribe`.
- API key input stays on-device and is never persisted.

## Prerequisites
- An OpenAI API key with access to the `gpt-realtime` model.
- A modern browser that supports WebRTC (Chrome, Edge, Safari, Firefox) on mobile or desktop.

## Local usage
1. Clone this repository.
2. Open `index.html` in a supported browser (using a local web server is recommended to avoid autoplay restrictions).
3. Paste your OpenAI API key, then tap **Start listening** and grant microphone access.
4. Speak; the translation and transcription areas update live.

## Deploying to GitHub Pages
1. Push the repository to GitHub.
2. In the repository settings, enable GitHub Pages and choose the branch (for example, `main`) with the root folder (`/`).
3. Wait for the Pages build to complete; your app is available at `https://<username>.github.io/<repo>/`.

Because GitHub Pages serves static files, updates go live as soon as you push new commits to the selected branch.

## Security notes
- Entering your API key directly in the browser is suitable for personal experiments, but avoid sharing the hosted site publicly without additional safeguards.
- Rotate your key if you suspect it has been exposed.
