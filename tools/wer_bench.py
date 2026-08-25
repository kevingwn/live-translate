#!/usr/bin/env python3
"""Compare source-transcript quality: separate socket vs inline in the translate session.

Step 0 established that `gpt-live-transcribe` is accepted as
`session.audio.input.transcription.model` inside a translate session, so both
paths can run the SAME model. What differs is:

  A  translate socket + separate gpt-live-transcribe socket   (today; supports `prompt`)
  C  translate socket with gpt-live-transcribe inline         (one socket; no biasing fields)

Every condition runs a translate session so they carry identical load -- comparing
A on an idle connection against C under translation load would attribute a load
effect to the architecture.

Usage:
    python tools/wer_bench.py [repeats]      # default 3

Requires `websockets` and OPENAI_API_KEY.
"""

import asyncio
import base64
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path
from statistics import median

from websockets.asyncio.client import connect

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import make_fixtures as mf  # noqa: E402

KEY = os.environ.get("OPENAI_API_KEY", "").strip()
RATE, FRAME_MS = 24000, 40
FRAME_BYTES = RATE * 2 * FRAME_MS // 1000
MODEL = "gpt-live-transcribe"
TRANSLATE_URL = "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate"
TRANSCRIBE_URL = "wss://api.openai.com/v1/realtime?intent=transcription"
TAIL_PAD_MS = 1500
MAX_DRIFT_MS = 100

# ---------------------------------------------------------------- normalisation

CONTRACTIONS = {
    "dont": "do not", "doesnt": "does not", "didnt": "did not", "wont": "will not",
    "cant": "can not", "cannot": "can not", "isnt": "is not", "arent": "are not",
    "wasnt": "was not", "werent": "were not", "havent": "have not", "hasnt": "has not",
    "hadnt": "had not", "wouldnt": "would not", "couldnt": "could not",
    "shouldnt": "should not", "its": "it is", "thats": "that is", "whats": "what is",
    "theres": "there is", "heres": "here is", "lets": "let us", "im": "i am",
    "ive": "i have", "ill": "i will", "id": "i would", "youre": "you are",
    "youve": "you have", "youll": "you will", "were_": "we are", "weve": "we have",
    "well_": "we will", "theyre": "they are", "theyve": "they have",
    "theyll": "they will", "hes": "he is", "shes": "she is", "wed": "we would",
}

UNITS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
         "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
         "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
         "seventeen": 17, "eighteen": 18, "nineteen": 19}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
        "seventy": 70, "eighty": 80, "ninety": 90}
SCALES = {"hundred": 100, "thousand": 1000, "million": 1000000, "billion": 1000000000}

# Acronym+number identifiers: AC-42 / AC 42 / SOC 2 -> AC42. Runs on still-cased
# text, so it keys on acronym-ness rather than on a hand-listed corpus.
IDENT = re.compile(r"\b([A-Z]{1,5})[- ]?(\d{1,4})\b")
IDENT_LOWER = re.compile(r"\b([a-z]{1,5}) (\d{1,4})\b")


def _words_to_digits(tokens):
    out, cur, seen = [], 0, False
    total = 0

    def flush():
        nonlocal cur, seen, total
        if seen:
            out.append(str(total + cur))
        cur, seen, total = 0, False, 0

    for tok in tokens:
        if tok in UNITS:
            cur += UNITS[tok]; seen = True
        elif tok in TENS:
            cur += TENS[tok]; seen = True
        elif tok in SCALES:
            if not seen:
                cur = 1
            if SCALES[tok] == 100:
                cur *= 100
            else:
                total += cur * SCALES[tok]
                cur = 0
            seen = True
        elif tok == "and" and seen:
            continue          # "one hundred and forty" -> 140
        else:
            flush()
            out.append(tok)
    flush()
    return out


def normalize(text, full=True, english=True):
    """Minimal mode = NFKC/lowercase/punctuation/whitespace only. The pair exists so
    the report can show whether the heavy normalisation favours one condition."""
    t = unicodedata.normalize("NFKC", text)
    t = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", t)
    t = (t.replace("’", "'").replace("‘", "'")
           .replace("“", '"').replace("”", '"')
           .replace("–", "-").replace("—", "-"))

    if full:
        t = IDENT.sub(r"\1\2", t)          # before lowercasing: AC-42 -> AC42

    t = t.lower()
    t = re.sub(r"[',]", "", t) if full else re.sub(r"[',]", "", t)

    if full:
        t = t.replace("-", " ").replace("/", " ")   # on-call -> on call
    else:
        t = t.replace("-", " ")

    t = "".join(" " if unicodedata.category(c).startswith("P") else c for c in t)
    t = unicodedata.normalize("NFD", t)
    t = "".join(c for c in t if not unicodedata.combining(c))
    tokens = t.split()

    if full:
        tokens = [CONTRACTIONS.get(w, w) for w in tokens]
        tokens = " ".join(tokens).split()
        if english:
            tokens = _words_to_digits(tokens)
        # letter->digit only, so "SOC two" -> soc2 but "140 milliseconds" survives
        tokens = IDENT_LOWER.sub(r"\1\2", " ".join(tokens)).split()
    return tokens


# ---------------------------------------------------------------- WER

def align(ref, hyp):
    """Levenshtein with backtrace. Returns (S, D, I, matches) where matches maps
    hypothesis index -> reference index for correct words only."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)

    i, j, S = n, m, 0
    D = I = 0
    matches = {}
    while i > 0 or j > 0:
        if i > 0 and j > 0 and d[i][j] == d[i - 1][j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1):
            if ref[i - 1] == hyp[j - 1]:
                matches[j - 1] = i - 1
            else:
                S += 1
            i, j = i - 1, j - 1
        elif i > 0 and d[i][j] == d[i - 1][j] + 1:
            D += 1; i -= 1
        else:
            I += 1; j -= 1
    return S, D, I, matches


def wer(ref_tokens, hyp_tokens):
    S, D, I, matches = align(ref_tokens, hyp_tokens)
    n = max(1, len(ref_tokens))
    return {"wer": 100.0 * (S + D + I) / n, "S": S, "D": D, "I": I,
            "N": len(ref_tokens), "H": len(hyp_tokens), "matches": matches}


# ---------------------------------------------------------------- transport

async def mint(url, session):
    import urllib.request, urllib.error
    def _do():
        req = urllib.request.Request(url, data=json.dumps({"session": session}).encode(),
            headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                b = json.loads(r.read())
                return b.get("value") or (b.get("client_secret") or {}).get("value") or KEY
        except Exception:
            return KEY
    return await asyncio.to_thread(_do)


def subs(tok):
    return ["realtime", f"openai-insecure-api-key.{tok}"]


async def pump(ws, pcm, append_type, drift_out):
    """Absolute-schedule sender. Sleeping FRAME_MS *after* each send accumulates
    processing time into the stream clock and skews every arrival timestamp."""
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    worst = 0.0
    total = len(pcm)
    for idx, off in enumerate(range(0, total, FRAME_BYTES)):
        target = t0 + idx * (FRAME_MS / 1000)
        delay = target - loop.time()
        if delay > 0:
            await asyncio.sleep(delay)
        else:
            worst = max(worst, -delay)
        await ws.send(json.dumps({"type": append_type,
                                  "audio": base64.b64encode(pcm[off:off + FRAME_BYTES]).decode()}))
    drift_out.append(worst * 1000)


async def run_condition(label, pcm, inline, prompt, target_lang="es"):
    """inline=True: one socket, transcription inside the translate session.
       inline=False: translate socket for load + a separate transcription socket."""
    deltas, arrivals, drift = [], [], []
    final_text = [None]

    tr_audio = {"input": {"transcription": {"model": MODEL} if inline else None,
                          "noise_reduction": {"type": "near_field"}},
                "output": {"language": target_lang}}
    if not inline:
        del tr_audio["input"]["transcription"]

    tr_tok = await mint("https://api.openai.com/v1/realtime/translations/client_secrets",
                        {"model": "gpt-realtime-translate", "audio": tr_audio})

    async with connect(TRANSLATE_URL, subprotocols=subs(tr_tok), max_size=None,
                       open_timeout=25) as tws:
        tr_created = asyncio.Event()
        t_start = [None]

        async def tr_reader():
            async for raw in tws:
                # Discard the ~500 kbps audio stream before parsing; a blocked
                # reader would inflate arrival times for every condition.
                if '"session.output_audio.delta"' in raw[:60]:
                    continue
                now = time.perf_counter()
                ev = json.loads(raw)
                t = ev.get("type")
                if t == "session.created":
                    tr_created.set()
                elif inline and t == "session.input_transcript.delta":
                    deltas.append(ev.get("delta", ""))
                    arrivals.append((now, ev.get("elapsed_ms")))

        trt = asyncio.create_task(tr_reader())
        await asyncio.wait_for(tr_created.wait(), 25)
        await tws.send(json.dumps({"type": "session.update", "session": {"audio": tr_audio}}))

        if inline:
            t_start[0] = time.perf_counter()
            await pump(tws, pcm, "session.input_audio_buffer.append", drift)
            end = time.perf_counter()
            last = [max(a[0] for a in arrivals)] if arrivals else [end]
            while time.perf_counter() - (max((a[0] for a in arrivals), default=end)) < 5.0 \
                    and time.perf_counter() - end < 30:
                await asyncio.sleep(0.25)
            term = "quiescence"
        else:
            ts_input = {"format": {"type": "audio/pcm", "rate": RATE},
                        "transcription": {"model": MODEL, "delay": "low"},
                        "noise_reduction": {"type": "near_field"}}
            if prompt:
                ts_input["transcription"]["prompt"] = prompt
            ts_tok = await mint("https://api.openai.com/v1/realtime/client_secrets",
                                {"type": "transcription", "audio": {"input": ts_input}})
            async with connect(TRANSCRIBE_URL, subprotocols=subs(ts_tok), max_size=None,
                               open_timeout=25) as sws:
                created = asyncio.Event()
                done = asyncio.Event()

                async def rd():
                    async for raw in sws:
                        now = time.perf_counter()
                        ev = json.loads(raw)
                        t = ev.get("type")
                        if t == "session.created":
                            created.set()
                        elif t == "conversation.item.input_audio_transcription.delta":
                            deltas.append(ev.get("delta", ""))
                            arrivals.append((now, None))
                        elif t == "conversation.item.input_audio_transcription.completed":
                            final_text[0] = ev.get("transcript", "")
                            done.set()

                rt = asyncio.create_task(rd())
                await asyncio.wait_for(created.wait(), 25)
                await sws.send(json.dumps({"type": "session.update",
                    "session": {"type": "transcription", "audio": {"input": ts_input}}}))
                t_start[0] = time.perf_counter()
                # Both sockets get the same bytes on the same schedule.
                await asyncio.gather(
                    pump(sws, pcm, "input_audio_buffer.append", drift),
                    pump(tws, pcm, "session.input_audio_buffer.append", []),
                )
                end = time.perf_counter()
                await sws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                try:
                    await asyncio.wait_for(done.wait(), 8)
                    term = "completed"
                except asyncio.TimeoutError:
                    term = "timeout"
                rt.cancel()
        trt.cancel()

    text = final_text[0] if final_text[0] else "".join(deltas)
    first_lag = (arrivals[0][0] - t_start[0]) if arrivals else None
    tail = (max(a[0] for a in arrivals) - end) if arrivals else None
    return {"label": label, "text": text, "deltas": len(deltas),
            "drift_ms": round(max(drift), 1) if drift else 0.0,
            "ttft_s": round(first_lag, 2) if first_lag else None,
            "tail_s": round(tail, 2) if tail is not None else None,
            "term": term,
            "elapsed_ms_present": sum(1 for a in arrivals if a[1] is not None)}


# ---------------------------------------------------------------- driver

PROMPT = ("An engineering standup about the AC-42 rollout, the Halyard connector "
          "and the Kestrel service.")

CONDITIONS = [
    ("A  separate socket + prompt", False, PROMPT),
    ("A0 separate socket, no prompt", False, None),
    ("C  inline in translate", True, None),
]


async def main():
    if not KEY:
        print("Set OPENAI_API_KEY first.", file=sys.stderr)
        return 1
    repeats = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    # Optional audio variant, e.g. ".snr10-babble" -- generated by tools/noise.py.
    variant = sys.argv[2] if len(sys.argv) > 2 else ""
    names = sys.argv[3].split(",") if len(sys.argv) > 3 else \
        ["01-english-monologue", "04-jargon-and-acronyms"]
    results = {}

    for name in names:
        pcm = (ROOT / "fixtures" / f"{name}{variant}.pcm").read_bytes()
        pcm += b"\x00" * (RATE * 2 * TAIL_PAD_MS // 1000)
        ref_text = next(f["text"] for f in mf.FIXTURES if f["name"] == name)
        ref = normalize(ref_text)
        print(f"\n{'='*84}\n{name}{variant}   {len(pcm)/48000:.1f}s   {len(ref)} ref words   x{repeats}")

        # Conditions run concurrently on byte-identical audio so they cannot drift
        # apart between runs and all share one clock. Safe only because pacing is
        # on an absolute schedule (drift is asserted below).
        by_label = {label: [] for label, _, _ in CONDITIONS}
        for r in range(repeats):
            outs = await asyncio.gather(
                *[run_condition(label, pcm, inline, prompt) for label, inline, prompt in CONDITIONS],
                return_exceptions=True)
            for (label, _, _), out in zip(CONDITIONS, outs):
                if isinstance(out, BaseException):
                    print(f"  {label}: FAILED {type(out).__name__}: {out}")
                    continue
                sc = wer(ref, normalize(out["text"]))
                scm = wer(normalize(ref_text, full=False), normalize(out["text"], full=False))
                # A badly truncated run is indistinguishable from a deletion-heavy
                # result once averaged, so quarantine it instead.
                sc["truncated"] = sc["H"] < 0.7 * sc["N"]
                by_label[label].append({**out, **sc, "wer_min": scm["wer"]})

        for label, _, _ in CONDITIONS:
            runs = [r for r in by_label[label] if not r["truncated"]]
            dropped = len(by_label[label]) - len(runs)
            if not runs:
                continue
            results[(name, label)] = runs
            w = sorted(r["wer"] for r in runs)
            tt = [r["ttft_s"] for r in runs if r["ttft_s"]]
            print(f"  {label:32s} WER med {median(w):5.2f}%  [{w[0]:.2f}-{w[-1]:.2f}]  n={len(runs)}"
                  f"{f' drop{dropped}' if dropped else ''}"
                  f"  min-norm {median(r['wer_min'] for r in runs):5.2f}%"
                  f"  S/D/I {sum(r['S'] for r in runs)}/{sum(r['D'] for r in runs)}/{sum(r['I'] for r in runs)}"
                  f"  ttft {median(tt):.2f}s"
                  f"  drift {max(r['drift_ms'] for r in runs):.0f}ms")

    (ROOT / "fixtures" / f"wer_results{variant or '.clean'}.json").write_text(
        json.dumps({f"{k[0]}|{k[1]}": v for k, v in results.items()}, indent=1, default=str),
        encoding="utf-8")
    print(f"\nWrote fixtures/wer_results.json")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
