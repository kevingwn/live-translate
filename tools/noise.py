#!/usr/bin/env python3
"""Mix noise into the PCM fixtures at a defined speech-active SNR.

Two things here are deliberate:

* SNR is measured against **speech-active** RMS, not whole-file RMS. These clips
  are ~65-70% voiced, so the ungated figure sits ~1.4-1.6 dB below the gated one
  and every condition would be quietly easier than its label claims.

* Noise defaults to **speech-shaped babble**, not white. Both sessions request
  `noise_reduction: {type: "near_field"}`, and flat stationary noise is the
  easiest possible case for a spectral front end -- white noise risks a floor
  effect where nothing degrades and the whole sweep measures nothing. Babble is
  built by summing time-reversed segments of the *other* fixtures: reversal keeps
  the long-term speech spectrum (so it masks the formant and fricative regions
  where "SOC", "p99", "Kestrel" live) while destroying intelligibility, so the
  model cannot transcribe the noise itself.

Output is written to disk once per (fixture, snr, kind) and streamed byte-identically
by every condition, so pairing holds by construction rather than by seeding discipline.

Usage:
    python tools/noise.py 20 10          # generate these SNRs, both kinds
"""

import array
import hashlib
import math
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "fixtures"
RATE = 24000
FRAME = int(RATE * 0.02)          # 20 ms
GATE_DB = -30.0                   # relative to the loudest frame


def frame_rms(samples, start, n):
    acc = 0
    for i in range(start, min(start + n, len(samples))):
        acc += samples[i] * samples[i]
    return math.sqrt(acc / n) if n else 0.0


def speech_rms(samples):
    """RMS over frames within GATE_DB of the loudest frame. This is a definition,
    not ground truth -- report it as such."""
    rms = [frame_rms(samples, i, FRAME) for i in range(0, len(samples) - FRAME, FRAME)]
    if not rms:
        return 0.0, 0.0
    peak = max(rms)
    thr = peak * (10 ** (GATE_DB / 20))
    active = [v for v in rms if v >= thr]
    gated = math.sqrt(sum(v * v for v in active) / len(active)) if active else 0.0
    whole = math.sqrt(sum(v * v for v in rms) / len(rms))
    return gated, whole


def load(path):
    a = array.array("h")
    a.frombytes(path.read_bytes())
    return a


def white(n, rng):
    return [rng.gauss(0.0, 1.0) for _ in range(n)]


def babble(n, donors, rng, voices=6):
    """Sum time-reversed slices of other speakers."""
    out = [0.0] * n
    for v in range(voices):
        src = donors[v % len(donors)]
        if len(src) < 2:
            continue
        start = rng.randrange(0, max(1, len(src) - 1))
        for i in range(n):
            # walk backwards through the donor, wrapping
            out[i] += float(src[(start - i) % len(src)])
    return out


def mix(sig, noise_f, snr_db):
    """Scale noise to hit the target SNR against gated speech level, then add."""
    gated, whole = speech_rms(sig)
    n_rms = math.sqrt(sum(x * x for x in noise_f) / len(noise_f)) or 1.0
    target = gated / (10 ** (snr_db / 20))
    k = target / n_rms

    out = array.array("h", bytes(2 * len(sig)))
    clipped = 0
    for i in range(len(sig)):
        v = sig[i] + noise_f[i] * k
        if v > 32767:
            v = 32767; clipped += 1
        elif v < -32768:
            v = -32768; clipped += 1
        out[i] = int(v)
    return out, clipped, gated, whole, target


def achieved_snr(clean, noisy):
    """Re-measure from the written files: SNR = 20log10(rms_speech / rms_residual)."""
    gated, _ = speech_rms(clean)
    n = len(clean)
    resid = math.sqrt(sum((noisy[i] - clean[i]) ** 2 for i in range(n)) / n) or 1e-9
    return 20 * math.log10(gated / resid)


def main():
    snrs = [int(x) for x in sys.argv[1:]] or [20, 10]
    names = sorted(p.stem for p in FIX.glob("*.pcm") if "snr" not in p.stem)
    clips = {n: load(FIX / f"{n}.pcm") for n in names}

    print(f"{'file':30s} {'kind':7s} {'snr':>4s} {'achieved':>9s} {'clip':>6s}  sha256")
    for name in names:
        sig = clips[name]
        donors = [clips[o] for o in names if o != name] or [sig]
        gated, whole = speech_rms(sig)
        print(f"{name:30s} gated={gated:6.0f} whole={whole:6.0f} "
              f"(gate is {20*math.log10(gated/whole):+.2f} dB above ungated)")

        for snr in snrs:
            for kind in ("white", "babble"):
                # Seed from the pair so regeneration is reproducible; the written
                # file is what guarantees byte-identity across conditions.
                rng = random.Random(f"{name}|{snr}|{kind}")
                nf = white(len(sig), rng) if kind == "white" else babble(len(sig), donors, rng)
                out, clipped, _, _, _ = mix(sig, nf, snr)
                path = FIX / f"{name}.snr{snr}-{kind}.pcm"
                path.write_bytes(out.tobytes())
                got = achieved_snr(sig, out)
                digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
                flag = "  CLIPPED" if clipped else ""
                print(f"{'':30s} {kind:7s} {snr:4d} {got:8.2f}dB {clipped:6d}  {digest}{flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
