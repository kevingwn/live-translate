#!/usr/bin/env python3
"""Verify the realtime wire contract without a browser.

The app's riskiest surface is the two WebSocket sessions: the subprotocol auth
list, the session.-prefixed event vocabulary on the translations endpoint, and
the bare vocabulary on the transcription endpoint. This script exercises all of
it against the live API using a generated fixture, so a contract change is
caught here rather than as a silently empty column in the UI.

Usage:
    python tools/make_fixtures.py        # once, to produce fixtures/
    python tools/smoke_test.py [seconds] # default 20

Requires the `websockets` package and OPENAI_API_KEY in the environment.
"""

import asyncio
import base64
import json
import os
import sys
import urllib.request
from collections import Counter
from pathlib import Path

from websockets.asyncio.client import connect

# Transcripts are Spanish, Japanese, Chinese... and the default Windows console
# codepage cannot encode them, which would crash the report rather than the
# request. Force UTF-8 out.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "fixtures" / "01-english-monologue.pcm"

RATE = 24000
FRAME_MS = 40
FRAME_BYTES = RATE * 2 * FRAME_MS // 1000  # 1920

TRANSLATE_URL = "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate"
TRANSCRIBE_URL = "wss://api.openai.com/v1/realtime?intent=transcription"


def mint(url: str, session: dict, api_key: str):
    """Mint an ek_ secret. Returns (token, how) so the caller can report which
    path actually authenticated."""
    req = urllib.request.Request(
        url,
        data=json.dumps({"session": session}).encode(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read())
    except Exception as e:  # noqa: BLE001 - any failure means fall back
        return api_key, f"raw key (mint failed: {type(e).__name__})"
    value = body.get("value") or (body.get("client_secret") or {}).get("value")
    return (value, "ephemeral ek_") if value else (api_key, "raw key (no value in response)")


def frames(seconds: int):
    raw = FIXTURE.read_bytes()
    limit = min(len(raw), RATE * 2 * seconds)
    for i in range(0, limit, FRAME_BYTES):
        yield raw[i:i + FRAME_BYTES]


async def run(name, url, token, session_update, append_type, close_type, seconds, collect):
    counts = Counter()
    text = []
    errors = []

    async with connect(url, subprotocols=["realtime", f"openai-insecure-api-key.{token}"],
                       max_size=None, open_timeout=20) as ws:
        created = asyncio.Event()

        async def reader():
            async for raw in ws:
                ev = json.loads(raw)
                t = ev.get("type", "?")
                counts[t] += 1
                if t == "session.created":
                    created.set()
                elif t == "error":
                    errors.append(ev.get("error", {}))
                else:
                    collect(ev, text)

        rt = asyncio.create_task(reader())
        await asyncio.wait_for(created.wait(), timeout=20)
        await ws.send(json.dumps(session_update))

        for chunk in frames(seconds):
            await ws.send(json.dumps({
                "type": append_type,
                "audio": base64.b64encode(chunk).decode(),
            }))
            await asyncio.sleep(FRAME_MS / 1000)

        if close_type:
            await ws.send(json.dumps({"type": close_type}))
        # Trailing transcript arrives after the close request.
        try:
            await asyncio.wait_for(asyncio.shield(rt), timeout=6)
        except (asyncio.TimeoutError, Exception):
            pass
        rt.cancel()

    return counts, "".join(text), errors


def report(name, counts, text, errors, how):
    print(f"\n=== {name}  (auth: {how}) ===")
    for t, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"   {n:5d}  {t}")
    for e in errors[:4]:
        print(f"   ERROR {e.get('code')}: {e.get('message')}")
    print(f"   transcript ({len(text)} chars):")
    print("     " + (text.strip()[:400] or "(nothing)"))


async def main() -> int:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        print("Set OPENAI_API_KEY first.", file=sys.stderr)
        return 1
    if not FIXTURE.exists():
        print(f"Missing {FIXTURE}. Run tools/make_fixtures.py first.", file=sys.stderr)
        return 1

    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    print(f"Streaming {seconds}s of {FIXTURE.name} to both endpoints at 1x ...")

    tr_audio = {"input": {"noise_reduction": {"type": "near_field"}}, "output": {"language": "es"}}
    tr_token, tr_how = mint(
        "https://api.openai.com/v1/realtime/translations/client_secrets",
        {"model": "gpt-realtime-translate", "audio": tr_audio}, api_key)

    # turn_detection is rejected outright by gpt-live-transcribe, and an empty
    # languages array is a 400, so only non-empty fields go on the wire.
    ts_input = {
        "format": {"type": "audio/pcm", "rate": RATE},
        "transcription": {"model": "gpt-live-transcribe", "delay": "low"},
        "noise_reduction": {"type": "near_field"},
    }
    ts_token, ts_how = mint(
        "https://api.openai.com/v1/realtime/client_secrets",
        {"type": "transcription", "audio": {"input": ts_input}}, api_key)

    def take_target(ev, out):
        if ev.get("type") == "session.output_transcript.delta":
            out.append(ev.get("delta", ""))

    def take_source(ev, out):
        if ev.get("type") == "conversation.item.input_audio_transcription.delta":
            out.append(ev.get("delta", ""))
        elif ev.get("type") == "conversation.item.input_audio_transcription.completed":
            out.append(" [" + ev.get("transcript", "") + "] ")

    results = await asyncio.gather(
        run("translate", TRANSLATE_URL, tr_token,
            {"type": "session.update", "session": {"audio": tr_audio}},
            "session.input_audio_buffer.append", "session.close", seconds, take_target),
        run("transcribe", TRANSCRIBE_URL, ts_token,
            {"type": "session.update",
             "session": {"type": "transcription", "audio": {"input": ts_input}}},
            "input_audio_buffer.append", None, seconds, take_source),
        return_exceptions=True,
    )

    for name, how, res in (("translate (target column)", tr_how, results[0]),
                           ("transcribe (source column)", ts_how, results[1])):
        if isinstance(res, BaseException):
            print(f"\n=== {name}  (auth: {how}) ===\n   FAILED: {type(res).__name__}: {res}")
        else:
            report(name, *res, how)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
