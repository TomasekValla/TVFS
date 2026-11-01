// AudioWorklet processors of the TVFS player (loaded from a Blob URL).

// ─── Pitch shifter: WSOLA + resampling ──────────────────────────────────────
// The same family of algorithm browsers use for "speed without pitch change":
// the input is cut into short overlapping pieces that are re-laid at the spot
// where they continue the previous piece best (cross-correlation search), which
// stretches time without touching the pitch; that stretched stream is then read
// back faster or slower (cubic interpolation), which restores the timing and
// moves the pitch. It keeps the waveform's shape, so transients stay crisp and
// clipped masters do not grow new peaks. Only runs when playbackRate and
// preservesPitch cannot produce the requested pitch on their own. Output is
// always the input delayed by DELAY samples, so switching on/off never jumps.
const RING = 1 << 16, MASK = RING - 1;
const FRAME = 1536, HOP = FRAME / 2, SEEK = 448, DECIM = 4, DELAY = 4096;
const HANN = new Float32Array(FRAME);
for (let i = 0; i < FRAME; i++) HANN[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FRAME); // sums to 1 at 50% overlap

// 2nd-order Butterworth low-pass (two in series = anti-aliasing before reading faster)
class LowPass {
  constructor() { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(0.45); }
  set(fNorm) { // cutoff as a fraction of the sample rate
    const w = 2 * Math.PI * Math.min(0.49, fNorm), cw = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
    this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; this.a1 = -2 * cw / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    const y = this.b0 * (x + this.x2) + this.b1 * this.x1 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class TvfsPitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.inp = [new Float32Array(RING), new Float32Array(RING)]; // input history
    this.str = [new Float32Array(RING), new Float32Array(RING)]; // time-stretched stream
    this.ola = [new Float32Array(FRAME), new Float32Array(FRAME)];
    this.aa = [[new LowPass(), new LowPass()], [new LowPass(), new LowPass()]];
    this.inCount = 0; this.active = false; this.wet = 0; this.aaFor = 0;
  }
  reset() {
    this.anaPos = this.inCount - DELAY; // input position of the next piece
    this.prevPos = -1;
    this.sW = 0; this.rp = 1;           // stretched samples written / read position
    this.ola[0].fill(0); this.ola[1].fill(0);
    for (const ch of this.aa) for (const f of ch) f.x1 = f.x2 = f.y1 = f.y2 = 0;
  }
  // Lay the next piece of input into the stretched stream. tempo = input advance per stretched sample.
  piece(tempo, ratio) {
    const inL = this.inp[0], inR = this.inp[1];
    const nominal = Math.round(this.anaPos);
    let best = nominal;
    if (this.prevPos >= 0) {
      // the new piece's first half should continue the previous piece's second half
      const ref = this.prevPos + HOP;
      let bestScore = -Infinity;
      const corr = (c, step) => {
        let xy = 0, yy = 1e-9;
        for (let i = 0; i < HOP; i += step) {
          const a = inL[(ref + i) & MASK] + inR[(ref + i) & MASK];
          const b = inL[(c + i) & MASK] + inR[(c + i) & MASK];
          xy += a * b; yy += b * b;
        }
        return xy / Math.sqrt(yy);
      };
      for (let d = -SEEK; d <= SEEK; d += DECIM) { // coarse
        const s = corr(nominal + d, DECIM);
        if (s > bestScore) { bestScore = s; best = nominal + d; }
      }
      const coarse = best; bestScore = -Infinity;
      for (let c = coarse - DECIM + 1; c < coarse + DECIM; c++) { // fine
        const s = corr(c, 1);
        if (s > bestScore) { bestScore = s; best = c; }
      }
    }
    const aa = ratio > 1.0001;
    if (aa && this.aaFor !== ratio) { for (const ch of this.aa) for (const f of ch) f.set(0.45 / ratio); this.aaFor = ratio; }
    for (let c = 0; c < 2; c++) {
      const inp = this.inp[c], ola = this.ola[c], str = this.str[c], f = this.aa[c];
      for (let i = 0; i < FRAME; i++) ola[i] += inp[(best + i) & MASK] * HANN[i];
      for (let i = 0; i < HOP; i++) {
        const v = aa ? f[1].run(f[0].run(ola[i])) : ola[i];
        str[(this.sW + i) & MASK] = v;
      }
      ola.copyWithin(0, HOP); ola.fill(0, FRAME - HOP);
    }
    this.sW += HOP;
    this.prevPos = best;
    this.anaPos += HOP * tempo;
  }
  process(inputs, outputs, params) {
    const input = inputs[0], out = outputs[0], n = out[0].length;
    const inL = input[0], inR = input[1] || input[0];
    const oL = out[0], oR = out[1] || out[0];
    const ratio = params.ratio[0], tempo = 1 / ratio;
    const target = Math.abs(ratio - 1) < 1e-4 ? 0 : 1;
    if (target && !this.active) { this.reset(); this.active = true; }
    const hL = this.inp[0], hR = this.inp[1], sL = this.str[0], sR = this.str[1];
    let wet = this.wet;
    for (let s = 0; s < n; s++) {
      const w = this.inCount & MASK;
      hL[w] = inL ? inL[s] : 0; hR[w] = inR ? inR[s] : 0;
      this.inCount++;
      const d = (this.inCount - 1 - DELAY) & MASK;
      const dryL = hL[d], dryR = hR[d];
      wet += (target - wet) * 0.0008;
      let yL = 0, yR = 0;
      if (this.active) {
        const i = Math.floor(this.rp);
        while (i + 3 > this.sW && this.anaPos + SEEK + FRAME <= this.inCount) this.piece(tempo, ratio);
        if (i + 3 <= this.sW) {
          const f = this.rp - i;
          const i0 = (i - 1) & MASK, i1 = i & MASK, i2 = (i + 1) & MASK, i3 = (i + 2) & MASK;
          yL = cubic(sL[i0], sL[i1], sL[i2], sL[i3], f);
          yR = cubic(sR[i0], sR[i1], sR[i2], sR[i3], f);
          this.rp += ratio;
        }
      }
      oL[s] = dryL + (yL - dryL) * wet;
      oR[s] = dryR + (yR - dryR) * wet;
    }
    this.wet = wet;
    if (!target && wet < 1e-4) this.active = false;
    return true;
  }
}
// Catmull-Rom interpolation between y1 and y2
function cubic(y0, y1, y2, y3, f) {
  return y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
}
registerProcessor('tvfs-pitch', TvfsPitchShifter);

// ─── Stereo: width + 8D, bass untouched ─────────────────────────────────────
// Width and rotation are computed on the full signal, but only their
// *difference* from the input is added back, high-passed at 150 Hz. So the bass
// stays exactly where it was (centred), and with width 100% / 8D off the output
// is the input sample for sample. (Splitting the signal with a regular crossover
// shifts the bass phase, which grows the flat, clipped tops of loud masters into
// peaks far above 0 dBFS.) Rotation is equal-power, so the level never jumps,
// and the side "behind" the listener gets slightly darker.
class HighPass {
  constructor(f) {
    const w = 2 * Math.PI * f / sampleRate, cw = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
    this.b0 = (1 + cw) / 2 / a0; this.b1 = -(1 + cw) / a0; this.b2 = this.b0;
    this.a1 = -2 * cw / a0; this.a2 = (1 - al) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
const BASS_FREQ = 150;
class TvfsStereo extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'width', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 0.1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.hp = [0, 1].map(() => [new HighPass(BASS_FREQ), new HighPass(BASS_FREQ)]);
    this.phase = 0; this.width = 1; this.depth = 0;
    this.darkL = 0; this.darkR = 0;
  }
  process(inputs, outputs, params) {
    const input = inputs[0], out = outputs[0], n = out[0].length;
    const inL = input[0], inR = input[1] || input[0];
    const tW = params.width[0], tD = params.depth[0], rate = params.rate[0];
    const dPhase = 2 * Math.PI * rate / sampleRate;
    const darkA = 1 - Math.exp(-2 * Math.PI * 3500 / sampleRate);
    const oL = out[0], oR = out[1] || out[0];
    const hpL = this.hp[0], hpR = this.hp[1];
    let { phase, width, depth, darkL, darkR } = this;
    for (let s = 0; s < n; s++) {
      const l = inL ? inL[s] : 0, r = inR ? inR[s] : 0;
      width += (tW - width) * 0.002; depth += (tD - depth) * 0.001;
      const m = (l + r) / 2, sd = (l - r) / 2 * width;
      phase += dPhase; if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      const pos = Math.sin(phase) * depth;                 // -1 left .. 1 right
      const back = Math.max(0, -Math.cos(phase)) * depth;  // 0 front .. 1 behind
      const a = (pos + 1) * Math.PI / 4;
      let mL = m * Math.cos(a) * Math.SQRT2, mR = m * Math.sin(a) * Math.SQRT2;
      darkL += darkA * (mL - darkL); darkR += darkA * (mR - darkR);
      mL += (darkL - mL) * back * 0.55; mR += (darkR - mR) * back * 0.55;
      oL[s] = l + hpL[1].run(hpL[0].run(mL + sd - l));
      oR[s] = r + hpR[1].run(hpR[0].run(mR - sd - r));
    }
    Object.assign(this, { phase, width, depth, darkL, darkR });
    return true;
  }
}
registerProcessor('tvfs-stereo', TvfsStereo);
