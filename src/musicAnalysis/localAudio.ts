import { createStore, entries, set, del } from 'idb-keyval';
import { CHORD_INTERVALS, MAX_SECONDS, QUALITIES, SAMPLE_RATE, noteHz, type Analysis, type Chart } from './chart';

const database = createStore('diva-music-analysis', 'charts');
export const loadCharts = async () => (await entries<string, Chart>(database)).map(([, chart]) => chart);
export const saveChart = (chart: Chart) => set(chart.id, chart, database);
export const deleteChart = (id: string) => del(id, database);

export const MAX_FILE_BYTES = 40 * 1024 * 1024;

function probeDuration(file: File, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    function stop() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    }
    function abort() {
      stop();
      reject(signal.reason);
    }
    function unableToRead() {
      stop();
      reject(new Error('Unable to read audio metadata'));
    }
    const timeout = window.setTimeout(unableToRead, 12000);
    signal.addEventListener('abort', abort, { once: true });
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      stop();
      resolve(duration);
    };
    audio.onerror = unableToRead;
    audio.preload = 'metadata';
    audio.src = url;
  });
}

export async function analyzeFile(file: File, signal: AbortSignal): Promise<Analysis> {
  if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new RangeError('Unsupported file size');
  signal.throwIfAborted();
  const duration = await probeDuration(file, signal);
  if (!Number.isFinite(duration) || duration < 2 || duration > MAX_SECONDS) throw new RangeError('Unsupported duration');
  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const decoder = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const audio = await decoder.decodeAudioData(bytes);
  signal.throwIfAborted();
  if (audio.duration < 2 || audio.duration > MAX_SECONDS) throw new RangeError('Unsupported duration');
  const samples = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const part = audio.getChannelData(channel);
    for (let i = 0; i < part.length; i++) samples[i] += part[i] / audio.numberOfChannels;
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<Analysis | null>) => {
      stop();
      if (data) resolve(data);
      else reject(new Error('Audio analysis failed'));
    };
    worker.onerror = () => {
      stop();
      reject(new Error('Audio analysis could not start'));
    };
    worker.postMessage(samples, [samples.buffer]);
  });
}

export const DEMO_CHART: Chart = {
  id: 'demo',
  title: 'DIVA Session',
  artist: '',
  bpm: 120,
  key: { root: 0, mode: 'major' },
  duration: 16,
  videoId: null,
  videoOffset: 0,
  chords: [0, 7, 9, 5, 0, 7, 9, 5].map((root, i) => ({
    start: i * 2,
    end: (i + 1) * 2,
    value: { root, quality: root === 9 ? 'm' : '' },
  })),
  melody: [72, 76, 79, 77, 74, 71, 67, 71, 72, 76, 81, 79, 77, 76, 72, 69,
    72, 76, 79, 77, 74, 71, 67, 71, 72, 76, 81, 79, 77, 76, 72, 69].map((value, i) => ({
    start: i * 0.5,
    end: (i + 1) * 0.5,
    value,
  })),
};

/** Render the original example using the same timing as its score. */
export function demoWav() {
  const samples = DEMO_CHART.duration * SAMPLE_RATE;
  const wav = new DataView(new ArrayBuffer(44 + samples * 2));
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    for (let i = 0; i < value.length; i++) wav.setUint8(offset + i, value.charCodeAt(i));
  }
  wav.setUint32(4, wav.byteLength - 8, true);
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 1, true);
  wav.setUint32(24, SAMPLE_RATE, true);
  wav.setUint32(28, SAMPLE_RATE * 2, true);
  wav.setUint16(32, 2, true);
  wav.setUint16(34, 16, true);
  wav.setUint32(40, samples * 2, true);
  for (const { start, end, value } of DEMO_CHART.chords) {
    const first = Math.round(start * SAMPLE_RATE);
    const root = 48 + (value.root > 5 ? value.root - 12 : value.root);
    const harmony = CHORD_INTERVALS[QUALITIES.findIndex(quality => quality === value.quality)].map(interval => noteHz(root + interval));
    for (let i = first; i < end * SAMPLE_RATE; i++) {
      const t = (i - first) / SAMPLE_RATE;
      const beat = Math.floor(i * 2 / SAMPLE_RATE);
      const beatTime = i / SAMPLE_RATE - beat / 2;
      const fade = Math.min(1, t * 100, (2 - t) * 100);
      const voice = Math.sin(2 * Math.PI * noteHz(DEMO_CHART.melody[beat].value) * beatTime)
        * Math.min(1, beatTime * 90, (0.5 - beatTime) * 80) * Math.exp(-beatTime * 3);
      const chord = harmony.reduce((mixed, frequency, j) => mixed + Math.sin(2 * Math.PI * frequency * t) * (j ? 0.10 : 0.15), 0);
      const attack = Math.exp(-beatTime * 50) * Math.sin(2 * Math.PI * 94 * beatTime) * 0.13;
      wav.setInt16(44 + i * 2, Math.round((fade * chord + 0.23 * voice + attack) * 32767), true);
    }
  }
  return new Blob([wav.buffer], { type: 'audio/wav' });
}
