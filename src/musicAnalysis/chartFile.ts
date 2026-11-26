import { CHART_QUALITIES, MAX_SECONDS, youtubeVideoId, type Chart, type Chord, type MusicalKey, type Timed } from './chart';

export const CHART_SCHEMA = 'diva.music-chart.v1';
export const MAX_CHART_BYTES = 2 * 1024 * 1024;
type ChartFile = Omit<Chart, 'id'>;

function invalid(): never {
  throw new TypeError('Invalid DIVA chart');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function number(value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return invalid();
  return value;
}

function name(value: unknown, required = false): string {
  if (typeof value !== 'string' || value.length > 160 || (required && !value.trim())) return invalid();
  return value.trim();
}

function musicalKey(value: unknown): MusicalKey {
  const { root, mode } = record(value);
  if (mode !== 'major' && mode !== 'minor') return invalid();
  return { root: number(root, 0, 11, true), mode };
}

function chord(value: unknown): Chord {
  const { root, quality, bass } = record(value);
  const type = CHART_QUALITIES.find(candidate => candidate === quality);
  if (type === undefined) return invalid();
  return { root: number(root, 0, 11, true), quality: type, ...(bass === undefined ? {} : { bass: number(bass, 0, 11, true) }) };
}

function timeline<T>(input: unknown, duration: number, limit: number, read: (value: unknown) => T): Timed<T>[] {
  if (!Array.isArray(input) || input.length > limit) return invalid();
  let previous = 0;
  return input.map(row => {
    const item = record(row);
    const start = number(item.start, previous, duration);
    const end = number(item.end, start, duration);
    if (start === end || (item.review !== undefined && item.review !== true)) return invalid();
    previous = end;
    return { start, end, value: read(item.value), ...(item.review ? { review: true } : {}) };
  });
}

export function parseChartFile(data: unknown): ChartFile {
  const input = record(data);
  if (input.schema !== CHART_SCHEMA) return invalid();
  const duration = number(input.duration, 2, MAX_SECONDS);
  const id = input.videoId;
  if (id !== null && (typeof id !== 'string' || youtubeVideoId(id) !== id)) return invalid();
  const videoOffset = number(input.videoOffset, -60, 60);
  const videoRate = input.videoRate === undefined ? 1 : number(input.videoRate, 0.5, 2);
  if (!id && (videoOffset !== 0 || videoRate !== 1)) return invalid();
  const hash = input.audioSha256;
  if (hash !== undefined && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))) return invalid();
  return {
    title: name(input.title, true), artist: name(input.artist), duration,
    videoId: id, videoOffset, ...(videoRate !== 1 ? { videoRate } : {}),
    ...(hash ? { audioSha256: hash } : {}),
    bpm: input.bpm === null ? null : number(input.bpm, 1, 400),
    key: input.key === null ? null : musicalKey(input.key),
    chords: timeline(input.chords, duration, 2400, chord),
    melody: timeline(input.melody, duration, 9600, value => number(value, 0, 127, true)),
    ...(input.keys === undefined ? {} : { keys: timeline(input.keys, duration, 480, musicalKey) }),
  };
}

export function serializeChartFile(chart: Chart): string {
  return JSON.stringify({ ...chart, schema: CHART_SCHEMA, id: undefined });
}
