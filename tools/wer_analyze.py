#!/usr/bin/env python3
"""Paired analysis of wer_bench output.

The absolute WER of any single condition carries wide uncertainty on a corpus
this size. The *paired* difference does not: conditions run concurrently on
byte-identical audio, so corpus difficulty and noise realisation cancel. Report
the difference with an interval; treat the absolute numbers as descriptive.

Usage:  python tools/wer_analyze.py
"""

import json
import random
import sys
from pathlib import Path
from statistics import mean, median

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FIX = Path(__file__).resolve().parent.parent / "fixtures"
BOOT = 10000
PERM = 100000
BASE = "A  separate socket + prompt"


def micro(runs):
    """Total errors / total reference words. Averaging per-clip percentages would
    weight a 46-word clip the same as an 87-word one."""
    e = sum(r["S"] + r["D"] + r["I"] for r in runs)
    n = sum(r["N"] for r in runs)
    return 100.0 * e / n if n else 0.0


def load(path):
    data = json.loads(path.read_text(encoding="utf-8"))
    out = {}
    for key, runs in data.items():
        name, label = key.split("|", 1)
        out[(name, label)] = runs
    return out


def paired_diffs(data, a_label, b_label):
    """One difference per (fixture, repeat) — the two ran concurrently on the
    same bytes, so this is a genuine pairing."""
    diffs = []
    for (name, label), runs in data.items():
        if label != a_label:
            continue
        other = data.get((name, b_label))
        if not other:
            continue
        for i in range(min(len(runs), len(other))):
            diffs.append((name, i, other[i]["wer"] - runs[i]["wer"]))
    return diffs


def bootstrap_ci(values, rng):
    means = []
    n = len(values)
    for _ in range(BOOT):
        means.append(mean(rng.choices(values, k=n)))
    means.sort()
    return means[int(0.025 * BOOT)], means[int(0.975 * BOOT)]


def perm_p(values, rng):
    """Exact-in-spirit paired sign-flip test."""
    obs = abs(mean(values))
    hits = 0
    for _ in range(PERM):
        flipped = mean(v if rng.random() < 0.5 else -v for v in values)
        if abs(flipped) >= obs - 1e-12:
            hits += 1
    return (hits + 1) / (PERM + 1)


def main():
    files = sorted(FIX.glob("wer_results*.json"))
    if not files:
        print("No wer_results*.json found. Run tools/wer_bench.py first.", file=sys.stderr)
        return 1

    rng = random.Random(20260825)
    for path in files:
        variant = path.stem.replace("wer_results", "") or ".clean"
        data = load(path)
        labels = sorted({label for _, label in data})
        print(f"\n{'='*86}\n{variant}")

        print(f"\n  {'condition':34s} {'micro WER':>10s} {'median':>8s} {'ttft p50':>9s} {'S':>4s} {'D':>4s} {'I':>4s}")
        for label in labels:
            runs = [r for rs in (v for (n, l), v in data.items() if l == label) for r in rs]
            tt = [r["ttft_s"] for r in runs if r.get("ttft_s")]
            print(f"  {label:34s} {micro(runs):9.2f}% {median(r['wer'] for r in runs):7.2f}% "
                  f"{median(tt) if tt else float('nan'):8.2f}s "
                  f"{sum(r['S'] for r in runs):4d} {sum(r['D'] for r in runs):4d} {sum(r['I'] for r in runs):4d}")

        for label in labels:
            if label == BASE:
                continue
            diffs = paired_diffs(data, BASE, label)
            if len(diffs) < 3:
                continue
            vals = [d for _, _, d in diffs]
            lo, hi = bootstrap_ci(vals, rng)
            p = perm_p(vals, rng)
            verdict = ("indistinguishable" if lo <= 0 <= hi else
                       ("WORSE than A" if mean(vals) > 0 else "BETTER than A"))
            print(f"\n  {label}  minus  {BASE}")
            print(f"    n={len(vals)} pairs   mean Δ {mean(vals):+.2f} pts   "
                  f"95% CI [{lo:+.2f}, {hi:+.2f}]   p={p:.4f}   -> {verdict}")
            byfix = {}
            for name, _, d in diffs:
                byfix.setdefault(name, []).append(d)
            for name in sorted(byfix):
                print(f"      {name:28s} mean Δ {mean(byfix[name]):+6.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
