export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'] as const;
export const DEGREES = ['I', '♭II', 'II', '♭III', 'III', 'IV', '♯IV', 'V', '♭VI', 'VI', '♭VII', 'VII'] as const;
export const QUALITIES = ['', 'm', '7', 'maj7', 'm7', 'dim', 'sus4'] as const;
export const CHART_QUALITIES = [...QUALITIES, '5', 'aug', 'dim7', 'm7♭5', 'mMaj7', '6', 'm6', 'sus2', 'add9', '9', 'maj9', 'm9', '11', 'm11', '13', 'maj13', 'm13', '7sus4'] as const;
export const CHORD_INTERVALS = [[0, 4, 7], [0, 3, 7], [0, 4, 7, 10], [0, 4, 7, 11], [0, 3, 7, 10], [0, 3, 6], [0, 5, 7]];
export const SAMPLE_RATE = 22050;
export const MAX_SECONDS = 480;

export interface Chord {
  root: number;
  quality: (typeof CHART_QUALITIES)[number];
  bass?: number;
}

export interface Timed<T> {
  start: number;
  end: number;
  value: T;
  review?: true;
}

export interface MusicalKey {
  root: number;
  mode: 'major' | 'minor';
}

export interface Analysis {
  duration: number;
  bpm: number | null;
  key: MusicalKey | null;
  chords: Timed<Chord>[];
  melody: Timed<number>[];
  keys?: Timed<MusicalKey>[];
}

export interface Chart extends Analysis {
  id: string;
  title: string;
  artist: string;
  videoId: string | null;
  videoOffset: number;
  videoRate?: number;
  audioSha256?: string;
}

export const pitchClass = (note: number) => ((note % 12) + 12) % 12;
export const chordName = ({ root, quality, bass }: Chord) => NOTE_NAMES[root] + quality
  + (bass !== undefined && bass !== root ? `/${NOTE_NAMES[bass]}` : '');
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

export function keyAt(chart: Analysis, time: number): MusicalKey | null {
  const keys = chart.keys;
  return (keys && keys[activeSegment(keys, time)]?.value) ?? chart.key;
}

export const chartTime = (chart: Chart, seconds: number) => (seconds - chart.videoOffset) / (chart.videoRate ?? 1);
export const videoTime = (chart: Chart, seconds: number) => seconds * (chart.videoRate ?? 1) + chart.videoOffset;

export type SearchPattern =
  | { kind: 'title' }
  | { kind: 'chords'; chords: Chord[] }
  | { kind: 'melody'; notes: number[] };

function chordMatch(chart: Chart, pattern: Chord[]): number | null {
  if (pattern.length < 2) return null;
  const chords = chart.chords;
  const index = chords.findIndex((_, start) => pattern.every((wanted, offset) => {
    const chord = chords[start + offset];
    const previous = chords[start + offset - 1];
    const tonic = chord && keyAt(chart, chord.start + (chord.end - chord.start) / 2)?.root;
    return chord && (!offset || chord.start - previous.end < 0.35)
      && tonic !== undefined && pitchClass(chord.value.root - tonic) === wanted.root && chord.value.quality === wanted.quality;
  }));
  return index < 0 ? null : chords[index].start;
}

function melodyMatch(chart: Chart, pattern: number[]): { start: number; approximate: boolean } | null {
  if (pattern.length < 4) return null;
  const melody = chart.melody;
  const index = melody.findIndex((first, start) => pattern.every((note, offset) => {
    const played = melody[start + offset];
    const previous = melody[start + offset - 1];
    return played && (!offset || played.start - previous.end < 1)
      && played.value - first.value === note - pattern[0];
  }));
  if (index >= 0) return { start: melody[index].start, approximate: false };
  // Short phrases need an exact match to keep broad searches from flooding the list.
  if (pattern.length < 6 || melody.length < pattern.length - 1) return null;
  const shape = (pitches: number[], skip = -1) => {
    const first = pitches[skip === 0 ? 1 : 0];
    return pitches.flatMap((note, i) => i === skip ? [] : [note - first]).join(',');
  };
  const full = shape(pattern);
  const shortened = pattern.map((_, i) => shape(pattern, i));
  const shorterShapes = new Set(shortened);
  for (let start = 0; start <= melody.length - pattern.length + 1; start++) {
    const pitches: number[] = [];
    for (let i = start; i < Math.min(melody.length, start + pattern.length + 1); i++) {
      if (i > start && melody[i].start - melody[i - 1].end >= 1) break;
      pitches.push(melody[i].value);
    }
    const size = pattern.length;
    const sameSize = pitches.slice(0, size);
    if ((pitches.length >= size - 1 && shorterShapes.has(shape(pitches.slice(0, size - 1))))
      || (sameSize.length === size && shortened.some((candidate, skip) => candidate === shape(sameSize, skip)))
      || (pitches.length > size && pitches.some((_, skip) => shape(pitches, skip) === full))) {
      return { start: melody[start].start, approximate: true };
    }
  }
  return null;
}

export function searchCharts(charts: Chart[], query: string, pattern: SearchPattern) {
  const terms = query.normalize('NFKC').trim().toLowerCase().split(/\s+/);
  const results = charts.flatMap(chart => {
    const name = `${chart.title} ${chart.artist}`.normalize('NFKC').toLowerCase();
    if (!terms.every(term => name.includes(term))) return [];
    if (pattern.kind === 'melody') {
      const match = melodyMatch(chart, pattern.notes);
      return match ? [{ chart, ...match }] : [];
    }
    const start = pattern.kind === 'chords' ? chordMatch(chart, pattern.chords) : 0;
    return start === null ? [] : [{ chart, start, approximate: false }];
  });
  return results.sort((left, right) => Number(left.approximate) - Number(right.approximate));
}
