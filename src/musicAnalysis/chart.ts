export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const;
export const DEGREES = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'] as const;
export const QUALITIES = ['', 'm', '7', 'maj7', 'm7', 'dim', 'sus4'] as const;
export const CHORD_INTERVALS = [[0, 4, 7], [0, 3, 7], [0, 4, 7, 10], [0, 4, 7, 11], [0, 3, 7, 10], [0, 3, 6], [0, 5, 7]];
export const SAMPLE_RATE = 22050;
export const MAX_SECONDS = 480;

export interface Chord {
  root: number;
  quality: (typeof QUALITIES)[number];
}

export interface Timed<T> {
  start: number;
  end: number;
  value: T;
}

export interface Analysis {
  duration: number;
  bpm: number | null;
  key: { root: number; mode: 'major' | 'minor' } | null;
  chords: Timed<Chord>[];
  melody: Timed<number>[];
}

export interface Chart extends Analysis {
  id: string;
  title: string;
  artist: string;
  videoId: string | null;
  videoOffset: number;
}

export const pitchClass = (note: number) => ((note % 12) + 12) % 12;
export const chordName = (chord: Chord) => NOTE_NAMES[chord.root] + chord.quality;
export const noteName = (note: number) => `${NOTE_NAMES[pitchClass(note)]}${Math.floor(note / 12) - 1}`;
export const noteHz = (note: number) => 440 * 2 ** ((note - 69) / 12);

export function youtubeVideoId(value: string): string | null {
  const valid = /^[A-Za-z0-9_-]{11}$/;
  const input = value.trim();
  if (valid.test(input)) return input;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const [, path, item, extra] = url.pathname.split('/');
    const id = url.hostname === 'youtu.be' ? (!item ? path : '')
      : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)
        ? path === 'watch' && !item ? url.searchParams.get('v') : ['shorts', 'embed', 'live'].includes(path) && !extra ? item : null
        : null;
    return id && valid.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function activeSegment<T>(timeline: Timed<T>[], time: number): number {
  let low = 0;
  let high = timeline.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (timeline[mid].start <= time) low = mid + 1;
    else high = mid;
  }
  const segment = timeline[low - 1];
  return segment && time < segment.end ? low - 1 : -1;
}

export type SearchPattern =
  | { kind: 'title' }
  | { kind: 'chords'; chords: Chord[] }
  | { kind: 'melody'; notes: number[] };

function chordMatch(chart: Chart, pattern: Chord[]): number | null {
  if (!chart.key || pattern.length < 2) return null;
  const chords = chart.chords;
  const tonic = chart.key.root;
  const index = chords.findIndex((_, start) => pattern.every((wanted, offset) => {
    const chord = chords[start + offset];
    const previous = chords[start + offset - 1];
    return chord && (!offset || chord.start - previous.end < 0.35)
      && pitchClass(chord.value.root - tonic) === wanted.root && chord.value.quality === wanted.quality;
  }));
  return index < 0 ? null : chords[index].start;
}

function melodyMatch(chart: Chart, pattern: number[]): number | null {
  if (pattern.length < 4) return null;
  const melody = chart.melody;
  const index = melody.findIndex((first, start) => pattern.every((note, offset) => {
    const played = melody[start + offset];
    const previous = melody[start + offset - 1];
    return played && (!offset || played.start - previous.end < 1)
      && played.value - first.value === note - pattern[0];
  }));
  return index < 0 ? null : melody[index].start;
}

export function searchCharts(charts: Chart[], query: string, pattern: SearchPattern) {
  const terms = query.normalize('NFKC').trim().toLowerCase().split(/\s+/);
  return charts.flatMap(chart => {
    const name = `${chart.title} ${chart.artist}`.normalize('NFKC').toLowerCase();
    if (!terms.every(term => name.includes(term))) return [];
    const start = pattern.kind === 'chords' ? chordMatch(chart, pattern.chords)
      : pattern.kind === 'melody' ? melodyMatch(chart, pattern.notes) : 0;
    return start === null ? [] : [{ chart, start }];
  });
}
