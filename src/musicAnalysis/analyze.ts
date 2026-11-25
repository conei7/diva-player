import { CHORD_INTERVALS, MAX_SECONDS, QUALITIES, SAMPLE_RATE, pitchClass, type Analysis, type Timed } from './chart';

const WINDOW = 4096;
const HOP = 2048;
const STEP = HOP / SAMPLE_RATE;
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const WINDOW_WEIGHTS = Float64Array.from({ length: WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / WINDOW));
const REVERSED = Uint16Array.from({ length: WINDOW }, (_, i) => {
  let reverse = 0;
  for (let mask = WINDOW >> 1; mask; mask >>= 1, i >>= 1) {
    if (i & 1) reverse |= mask;
  }
  return reverse;
});
const COS = Float64Array.from({ length: WINDOW / 2 }, (_, i) => Math.cos(2 * Math.PI * i / WINDOW));
const SIN = Float64Array.from({ length: WINDOW / 2 }, (_, i) => -Math.sin(2 * Math.PI * i / WINDOW));
const BIN_HZ = SAMPLE_RATE / WINDOW;
const FIRST_BIN = Math.floor(45 / BIN_HZ);
const LAST_BIN = Math.ceil(3200 / BIN_HZ);

function spectrum(samples: Float32Array, center: number, re: Float64Array, im: Float64Array, bins: Float64Array) {
  for (let i = 0; i < WINDOW; i++) {
    const sample = samples[center + i - WINDOW / 2] ?? 0;
    re[REVERSED[i]] = sample * WINDOW_WEIGHTS[i];
  }
  im.fill(0);
  for (let length = 2; length <= WINDOW; length *= 2) {
    const half = length / 2;
    const stride = WINDOW / length;
    for (let block = 0; block < WINDOW; block += length) {
      for (let i = 0; i < half; i++) {
        const left = block + i;
        const right = left + half;
        const c = COS[i * stride];
        const s = SIN[i * stride];
        const x = re[right] * c - im[right] * s;
        const y = re[right] * s + im[right] * c;
        re[right] = re[left] - x;
        im[right] = im[left] - y;
        re[left] += x;
        im[left] += y;
      }
    }
  }
  for (let i = FIRST_BIN - 1; i <= LAST_BIN + 1; i++) bins[i] = Math.hypot(re[i], im[i]);
}

function classifyChord(chroma: number[], bass: number[]): number | null {
  const total = chroma.reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  const bassMax = Math.max(...bass) || 1;
  let best: number | null = null;
  let bestScore = 0;
  for (let root = 0; root < 12; root++) {
    for (const [quality, intervals] of CHORD_INTERVALS.entries()) {
      const weights = intervals.map(interval => chroma[pitchClass(root + interval)] / total);
      if (Math.min(...weights) < 0.065) continue;
      const coverage = weights.reduce((sum, weight) => sum + weight, 0);
      const score = coverage + weights[0] * 0.28 + bass[root] / bassMax * 0.21 - 0.09 * (intervals.length - 3);
      if (coverage >= 0.55 && score > bestScore) {
        bestScore = score;
        best = root * QUALITIES.length + quality;
      }
    }
  }
  return best;
}

function estimateKey(totals: number[]): Analysis['key'] {
  const average = totals.reduce((sum, value) => sum + value, 0) / 12;
  const deviation = Math.hypot(...totals.map(value => value - average));
  if (!deviation || totals.filter(value => value > average * 0.55).length < 4) return null;
  let strongest = 0.4;
  let key: Analysis['key'] = null;
  for (const mode of ['major', 'minor'] as const) {
    const profile = mode === 'major' ? MAJOR : MINOR;
    const mean = profile.reduce((sum, value) => sum + value, 0) / 12;
    const centered = profile.map(value => value - mean);
    const scale = Math.hypot(...centered) * deviation;
    for (let root = 0; root < 12; root++) {
      const score = centered.reduce((sum, weight, i) => sum + weight * totals[pitchClass(root + i)], 0) / scale;
      if (score <= strongest) continue;
      strongest = score;
      key = { root, mode };
    }
  }
  return key;
}

function estimateTempo(onsets: number[]): number | null {
  if (onsets.length < 40) return null;
  const mean = onsets.reduce((sum, value) => sum + value, 0) / onsets.length;
  const envelope = onsets.map(value => Math.max(0, value - mean));
  const energy = envelope.reduce((sum, value) => sum + value ** 2, 0);
  if (!energy) return null;
  const minLag = Math.ceil(60 / (180 * STEP));
  const maxLag = Math.floor(60 / (65 * STEP));
  const correlations = Array.from({ length: maxLag + 2 }, (_, lag) => (
    envelope.slice(lag).reduce((sum, value, i) => sum + value * envelope[i], 0) / energy
  ));
  let lag = minLag;
  for (let i = minLag + 1; i <= maxLag; i++) {
    if (correlations[i] > correlations[lag] + 0.04) lag = i;
  }
  const [left, peak, right] = correlations.slice(lag - 1, lag + 2);
  if (peak < 0.18) return null;
  const curvature = 2 * (2 * peak - left - right);
  const offset = curvature > 0 ? Math.max(-0.5, Math.min(0.5, (right - left) / curvature)) : 0;
  return Math.round(60 / ((lag + offset) * STEP));
}

function groupFrames(frames: (number | null)[], duration: number, minFrames: number, bridgeFrames = 0): Timed<number>[] {
  const smooth = frames.map((value, i) => i > 0 && frames[i - 1] === frames[i + 1] ? frames[i - 1] : value);
  const spans: Timed<number>[] = [];
  for (let first = 0; first < smooth.length;) {
    const value = smooth[first];
    let next = first + 1;
    while (next < smooth.length && smooth[next] === value) next++;
    if (value !== null && next - first >= minFrames) {
      const start = Math.max(0, (first - 0.5) * STEP);
      const end = Math.min(duration, (next - 0.5) * STEP);
      const previous = spans.at(-1);
      if (previous?.value === value && start - previous.end < (bridgeFrames + 0.01) * STEP) previous.end = end;
      else spans.push({ start, end, value });
    }
    first = next;
  }
  return spans;
}

/** Analyze mono samples already resampled by Web Audio, on a worker. Timestamps start at sample 0. */
export function analyzeSamples(samples: Float32Array): Analysis {
  const duration = samples.length / SAMPLE_RATE;
  if (duration < 2 || duration > MAX_SECONDS) throw new RangeError('Unsupported duration');
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  const bins = new Float64Array(LAST_BIN + 2);
  const previous = new Float64Array(bins.length);
  const totals = Array<number>(12).fill(0);
  const chords: (number | null)[] = [];
  const melody: (number | null)[] = [];
  const onsets: number[] = [];
  for (let center = 0; center < samples.length; center += HOP) {
    spectrum(samples, center, re, im, bins);
    const chroma = Array<number>(12).fill(0);
    const bass = Array<number>(12).fill(0);
    let strongest = 0;
    let flux = 0;
    for (let i = FIRST_BIN; i <= LAST_BIN; i++) {
      strongest = Math.max(strongest, bins[i]);
      const compressed = Math.log1p(bins[i]);
      flux += Math.max(0, compressed - previous[i]);
      previous[i] = compressed;
    }
    onsets.push(center ? flux : 0);
    let lead: number | null = null;
    let leadScore = 0;
    for (let i = FIRST_BIN; i <= LAST_BIN; i++) {
      const power = bins[i];
      if (power < Math.max(0.12, strongest * 0.035) || power <= bins[i - 1] || power < bins[i + 1]) continue;
      const binOffset = 0.5 * (bins[i - 1] - bins[i + 1]) / (bins[i - 1] + bins[i + 1] - 2 * power);
      const midi = 69 + 12 * Math.log2((i + binOffset) * BIN_HZ / 440);
      const note = Math.round(midi);
      const pitch = pitchClass(note);
      chroma[pitch] += power * (note < 65 ? 1 : 0.24);
      if (note < 56) bass[pitch] += power;
      if (note < 60 || note > 88) continue;
      const octaveBin = Math.round((i + binOffset) / 2);
      const lower = Math.max(bins[octaveBin - 1] ?? 0, bins[octaveBin] ?? 0, bins[octaveBin + 1] ?? 0);
      const score = Math.max(0, power - lower * 0.65);
      if (score > leadScore && score >= strongest * 0.18) {
        lead = note;
        leadScore = score;
      }
    }
    const total = chroma.reduce((sum, value) => sum + value, 0) || 1;
    chroma.forEach((value, i) => { totals[i] += value / total; });
    chords.push(classifyChord(chroma, bass));
    melody.push(lead);
  }
  return {
    duration,
    bpm: estimateTempo(onsets),
    key: estimateKey(totals),
    chords: groupFrames(chords, duration, 3, 2).map(segment => ({
      ...segment,
      value: { root: Math.floor(segment.value / QUALITIES.length), quality: QUALITIES[segment.value % QUALITIES.length] },
    })),
    melody: groupFrames(melody, duration, 2),
  };
}
