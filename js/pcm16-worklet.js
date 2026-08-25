/**
 * Resamples the mic graph to 24 kHz mono and emits little-endian PCM16 frames.
 *
 * The AudioContext is *asked* for 24 kHz, but Firefox and Safari are free to
 * ignore that and hand back 48 kHz, so this processor always resamples from
 * whatever `sampleRate` actually is. When the rates already match, the phase
 * arithmetic below degenerates to a straight copy with no drift.
 */
class PCM16Worklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || 24000;
    this.frameSamples = Math.round((this.targetRate * (opts.frameMs || 40)) / 1000);

    // Input samples consumed per output sample.
    this.ratio = sampleRate / this.targetRate;

    this.out = new Int16Array(this.frameSamples);
    this.outIdx = 0;

    // Read position within the current quantum. Carries across quanta and goes
    // slightly negative, at which point it refers back into `prev`.
    this.phase = 0;
    this.prev = 0;

    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.flush();
    };
  }

  flush() {
    if (this.outIdx === 0) return;
    const partial = this.out.slice(0, this.outIdx);
    this.port.postMessage(partial.buffer, [partial.buffer]);
    this.outIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    // No input yet (or the track is muted); keep the processor alive.
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;

    const n = input[0].length;

    // The node asks for an explicit mono downmix, so normally there is one
    // channel here. Average defensively anyway: a display capture is stereo,
    // and reading only input[0] would drop half the audio with no visible
    // symptom beyond slightly worse transcripts.
    let ch = input[0];
    if (input.length > 1) {
      if (!this.mix || this.mix.length !== n) this.mix = new Float32Array(n);
      ch = this.mix;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let c = 0; c < input.length; c++) sum += input[c][i];
        ch[i] = sum / input.length;
      }
    }
    let p = this.phase;

    // Stop at n-1 so `b` never reads past the quantum; the remainder carries
    // over via `phase`/`prev` and is interpolated on the next call.
    while (p <= n - 1) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = i < 0 ? this.prev : ch[i];
      const b = ch[i + 1];
      const s = a + (b - a) * frac;

      const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
      this.out[this.outIdx++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.outIdx === this.frameSamples) {
        // Transfer a copy so the next frame can reuse `this.out`.
        const frame = this.out.slice();
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this.outIdx = 0;
      }

      p += this.ratio;
    }

    this.phase = p - n;
    this.prev = ch[n - 1];
    return true;
  }
}

registerProcessor('pcm16-worklet', PCM16Worklet);
