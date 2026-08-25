#!/usr/bin/env python3
"""Generate deterministic test clips for live-translate.

Speaking into a microphone is a terrible way to test a transcriber: you cannot
repeat the input, so you cannot tell a regression from a bad take. These clips
are fixed, so a run is comparable to the last one.

Each clip targets one documented behaviour of the models -- see FIXTURES below.

Usage:
    export OPENAI_API_KEY=sk-...        # PowerShell: $env:OPENAI_API_KEY="sk-..."
    python tools/make_fixtures.py

Writes fixtures/*.wav (drag into the app) and fixtures/*.pcm (raw 24 kHz mono
s16le -- already the exact wire format, so it can be fed straight to a socket).
Stdlib only; no pip install.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENDPOINT = "https://api.openai.com/v1/audio/speech"
MODEL = "gpt-4o-mini-tts"
OUT = Path(__file__).resolve().parent.parent / "fixtures"

FIXTURES = [
    {
        "name": "01-english-monologue",
        "voice": "marin",
        "why": "Baseline en->es. Both columns should fill steadily.",
        "text": (
            "Good morning everyone, and thanks for joining. I want to walk through three things "
            "today. First, where we landed on the migration. Second, what the support queue has "
            "looked like over the past two weeks. And third, what we need to decide before Friday. "
            "The migration finished on Tuesday night with about forty minutes of downtime, which is "
            "well inside the window we promised. Nothing was lost, and the rollback plan was never "
            "needed. I want to thank the on-call team for staying late to watch it settle."
        ),
    },
    {
        "name": "02-spanish-monologue",
        "voice": "cedar",
        "why": "Run this with target=Spanish. The translator deliberately stays quiet when "
               "speech is already in the target language, so the right column should stay "
               "mostly EMPTY. That is correct behaviour, not a bug.",
        "text": (
            "Buenos días a todos y gracias por acompañarnos esta mañana. Quiero repasar tres puntos. "
            "Primero, cómo terminó la migración del martes por la noche. Segundo, qué ha pasado con "
            "la cola de soporte durante las últimas dos semanas. Y tercero, qué debemos decidir antes "
            "del viernes por la tarde. La migración terminó sin pérdida de datos y no hizo falta "
            "revertir nada."
        ),
    },
    {
        "name": "03-code-switched",
        "voice": "marin",
        "why": "Spanglish. Translation goes choppy in one direction: with target=English the "
               "model falls silent during the English stretches and only renders the Spanish.",
        "text": (
            "So I talked to the vendor yesterday, y me dijeron que el envío llega el jueves. "
            "That gives us one extra day, pero necesitamos confirmar el número de serie primero. "
            "I already emailed them about it, aunque todavía no han respondido. "
            "If we do not hear back by noon, vamos a tener que escalar."
        ),
    },
    {
        "name": "04-jargon-and-acronyms",
        "voice": "cedar",
        "why": "Entity stress test. Run it once with the Keywords field empty and once with "
               "'AC-42, Halyard, Kestrel, SOC 2, p99' filled in. The difference is the whole "
               "reason the second transcription session exists.",
        "text": (
            "The AC-42 rollout is blocked on the Halyard connector. Kestrel is passing SOC 2 review, "
            "but our p99 latency went from one hundred and forty milliseconds to about four hundred "
            "after the Halyard change. Ticket AC-42 has the flame graphs attached. Priya thinks it is "
            "the retry loop in Kestrel, not Halyard itself."
        ),
    },
]


def fix_wav_header(data: bytes) -> bytes:
    """Rewrite the streaming-WAV placeholder sizes with the real ones.

    OpenAI returns WAV with both the RIFF and data chunk sizes set to
    0xFFFFFFFF. That is legal for a stream, but it tells every decoder the file
    is ~24 days long: media elements then never fire `ended` and stall forever,
    and anything that sizes a buffer from `duration` tries to allocate gigabytes.
    """
    if len(data) < 44 or data[:4] != b"RIFF" or data[36:40] != b"data":
        return data
    out = bytearray(data)
    out[4:8] = (len(data) - 8).to_bytes(4, "little")
    out[40:44] = (len(data) - 44).to_bytes(4, "little")
    return bytes(out)


def synthesize(api_key: str, text: str, voice: str, fmt: str) -> bytes:
    payload = json.dumps({
        "model": MODEL,
        "input": text,
        "voice": voice,
        "response_format": fmt,
        "instructions": "Speak naturally at a normal conversational pace, as in a real meeting.",
    }).encode("utf-8")

    req = urllib.request.Request(
        ENDPOINT,
        data=payload,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def build_stereo_probe() -> str:
    """Derive a STEREO clip with speech in the right channel only.

    This is the decisive test for the capture downmix. AudioWorkletNode defaults
    channelCountMode to 'max', which hands the processor every channel; code
    that reads inputs[0][0] then silently transcribes the left channel alone.
    With silence on the left, that bug produces an empty transcript, while a
    correct (L+R)/2 downmix yields the speech at half amplitude.

    Worth knowing: a display-captured track reports channelCount 1 from
    getSettings() even when MediaStreamAudioSourceNode negotiates 2, so the
    track metadata cannot be trusted to tell you whether stereo is in play.

    Costs nothing -- it is built from the mono PCM already on disk.
    """
    import struct

    mono = (OUT / "01-english-monologue.pcm").read_bytes()
    samples = struct.unpack("<%dh" % (len(mono) // 2), mono)

    body = bytearray()
    for value in samples:
        body += struct.pack("<hh", 0, value)   # left silent, right = speech

    rate, block = 24000, 4
    header = bytearray(44)
    header[0:4] = b"RIFF"
    header[4:8] = (36 + len(body)).to_bytes(4, "little")
    header[8:12] = b"WAVE"
    header[12:16] = b"fmt "
    header[16:20] = (16).to_bytes(4, "little")
    header[20:22] = (1).to_bytes(2, "little")
    header[22:24] = (2).to_bytes(2, "little")
    header[24:28] = rate.to_bytes(4, "little")
    header[28:32] = (rate * block).to_bytes(4, "little")
    header[32:34] = block.to_bytes(2, "little")
    header[34:36] = (16).to_bytes(2, "little")
    header[36:40] = b"data"
    header[40:44] = len(body).to_bytes(4, "little")

    name = "05-stereo-right-only.wav"
    (OUT / name).write_bytes(bytes(header) + bytes(body))
    return name


def main() -> int:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("Set OPENAI_API_KEY first.", file=sys.stderr)
        return 1

    # One cheap call first, so an auth or access problem is reported plainly
    # instead of surfacing as a traceback eight requests in.
    print(f"Checking {MODEL} access ...", end="", flush=True)
    try:
        synthesize(api_key, "Test.", "marin", "wav")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        print(f" HTTP {e.code}", file=sys.stderr)
        if e.code in (401, 403):
            print("  The key was rejected. It may be revoked, mistyped, or from a "
                  "project without access to this model.", file=sys.stderr)
        elif e.code == 404:
            print(f"  This project cannot reach {MODEL}.", file=sys.stderr)
        elif e.code == 429:
            print("  Rate limited or out of quota.", file=sys.stderr)
        print(f"  {body}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f" network error: {e.reason}", file=sys.stderr)
        print("  Check connectivity, proxy settings, or TLS interception.", file=sys.stderr)
        return 1
    print(" ok")

    OUT.mkdir(exist_ok=True)
    notes = []

    for fx in FIXTURES:
        for fmt, ext in (("wav", "wav"), ("pcm", "pcm")):
            path = OUT / f"{fx['name']}.{ext}"
            print(f"  {path.name} ...", end="", flush=True)
            try:
                raw = synthesize(api_key, fx["text"], fx["voice"], fmt)
                path.write_bytes(fix_wav_header(raw) if fmt == "wav" else raw)
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")[:300]
                print(f" failed ({e.code}): {body}", file=sys.stderr)
                return 1
            except urllib.error.URLError as e:
                print(f" network error: {e.reason}", file=sys.stderr)
                return 1
            print(f" {path.stat().st_size // 1024} KB")
        notes.append(f"{fx['name']}\n    {fx['why']}\n")

    (OUT / "README.txt").write_text(
        "Generated by tools/make_fixtures.py. .pcm files are raw 24 kHz mono s16le.\n\n"
        + "\n".join(notes),
        encoding="utf-8",
    )
    print(f"\nWrote {len(FIXTURES) * 2} files to {OUT}")
    print("Read fixtures/README.txt for what each clip is testing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
