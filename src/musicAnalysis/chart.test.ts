import { describe, expect, it } from 'vitest';
import { analyzeSamples } from './analyze';
import { activeSegment, chartTime, chordName, keyAt, pitchClass, searchCharts, videoTime, youtubeVideoId, type Chart } from './chart';
import { parseChartFile, serializeChartFile } from './chartFile';
import { demoWav, DEMO_CHART } from './localAudio';

describe('music analysis', () => {
  it('finds the timestamp of a progression in a transposed chart', () => {
    const original = DEMO_CHART;
    const transposed = {
      ...original,
      key: { root: 2, mode: 'major' as const },
      chords: original.chords.map(chord => ({ ...chord, value: { ...chord.value, root: pitchClass(chord.value.root + 2) } })),
    };
    const sequence = original.chords.slice(1, 4).map(chord => chord.value);
    const pattern = { kind: 'chords' as const, chords: sequence };
    expect(searchCharts([original, transposed], 'ＤＩＶＡ session', pattern).map(result => result.start)).toEqual([2, 2]);
    const gap = { ...original, chords: [{ ...original.chords[1] }, { ...original.chords[2], start: 4.8 }, original.chords[3]] };
    expect(searchCharts([gap], '', pattern)).toEqual([]);
  });

  it('matches a melody at a different octave or key while retaining the exact timestamp', () => {
    const pitches = DEMO_CHART.melody.slice(4, 9).map(note => note.value + 7);
    expect(searchCharts([DEMO_CHART], '', { kind: 'melody', notes: pitches })[0]?.start).toBe(2);
    expect(searchCharts([DEMO_CHART], '', { kind: 'melody', notes: pitches.slice(0, 3) })).toEqual([]);
    expect(searchCharts([DEMO_CHART], '別の曲', { kind: 'melody', notes: pitches })).toEqual([]);
  });

  it('ranks exact melodies ahead of one-note differences and keeps short queries exact', () => {
    const notes = [60, 64, 67, 65, 62, 59];
    const base = (id: string, pitches: number[]): Chart => ({
      ...DEMO_CHART, id, melody: pitches.map((value, index) => ({ start: index / 2, end: (index + 1) / 2, value })),
    });
    const changed = base('changed', [60, 64, 67, 66, 62, 59]);
    const omitted = base('omitted', [60, 64, 67, 62, 59]);
    const extra = base('extra', [60, 64, 67, 73, 65, 62, 59]);
    const exact = base('exact', notes.map(note => note + 2));
    const wrong = base('wrong', [60, 64, 76, 81, 62, 59]);
    expect(searchCharts([changed, omitted, wrong, extra, exact], '', { kind: 'melody', notes })
      .map(result => [result.chart.id, result.approximate, result.start])).toEqual([
      ['exact', false, 0], ['changed', true, 0], ['omitted', true, 0], ['extra', true, 0],
    ]);
    expect(searchCharts([changed], '', { kind: 'melody', notes: notes.slice(0, 5) })).toEqual([]);
    const gap = { ...extra, melody: extra.melody.map((note, i) => i > 2 ? { ...note, start: note.start + 1, end: note.end + 1 } : note) };
    expect(searchCharts([gap], '', { kind: 'melody', notes })).toEqual([]);
  });

  it('preserves extended harmony, the newer key, and both directions of video alignment', () => {
    const chart: Chart = {
      ...DEMO_CHART, videoId: 'Y_I_NOHVwzI', videoOffset: 1.5, videoRate: 1.025,
      keys: [{ start: 4, end: 8, value: { root: 9, mode: 'minor' } }],
      chords: [{ start: 4, end: 6, value: { root: 9, quality: 'm9', bass: 0 }, review: true },
        { start: 6, end: 8, value: { root: 4, quality: '7' } }],
      audioSha256: 'f'.repeat(64),
    };
    const { id, ...data } = chart;
    const imported = parseChartFile(JSON.parse(serializeChartFile(chart)));
    expect(imported).toEqual(data);
    expect(id).toBe('demo');
    expect(chordName(imported.chords[0].value)).toBe('Am9/C');
    expect(keyAt(imported, 6)).toEqual({ root: 9, mode: 'minor' });
    expect(keyAt(imported, 8)).toEqual(DEMO_CHART.key);
    expect(searchCharts([chart], '', { kind: 'chords', chords: [{ root: 0, quality: 'm9' }, { root: 7, quality: '7' }] })[0]?.start).toBe(4);
    expect(videoTime(chart, 12)).toBeCloseTo(13.8);
    expect(chartTime(chart, 13.8)).toBeCloseTo(12);
    expect(chartTime(DEMO_CHART, 12)).toBe(12);
  });

  it('rejects malformed and overlapping timelines or foreign video URLs before import', () => {
    const data = JSON.parse(serializeChartFile(DEMO_CHART));
    for (const invalid of [
      { schema: 'foreign' }, { duration: Infinity }, { videoId: 'https://example.org/123' },
      { videoRate: 0 }, { videoRate: 1.01 }, { audioSha256: 'unknown' }, { bpm: '120' },
      { chords: [DEMO_CHART.chords[0], { ...DEMO_CHART.chords[1], start: 1 }] },
      { chords: [{ start: 0, end: 2, value: { root: 0, quality: 'unknown' } }] },
      { melody: [{ start: 0, end: 1, value: 128 }] },
    ]) expect(() => parseChartFile({ ...data, ...invalid })).toThrow(TypeError);
  });

  it('handles time before, between, and after chord regions', () => {
    const timeline = [DEMO_CHART.chords[1], DEMO_CHART.chords[3]];
    expect([-1, 2, 3.99, 4, 6, 8].map(time => activeSegment(timeline, time))).toEqual([-1, 0, 0, -1, 1, -1]);
  });

  it('accepts YouTube links for one video', () => {
    const id = 'Y_I_NOHVwzI';
    for (const url of [id, `https://youtu.be/${id}?t=2`, `https://www.youtube.com/watch?v=${id}`,
      `https://m.youtube.com/shorts/${id}`, `https://music.youtube.com/watch?v=${id}`]) {
      expect(youtubeVideoId(url)).toBe(id);
    }
    for (const url of [`https://www.youtube.com.other/watch?v=${id}`, `https://youtu.be@other.com/${id}`,
      `https://youtu.be/${id}/other`, `ftp://youtube.com/watch?v=${id}`, 'https://www.youtube.com/playlist?list=123']) {
      expect(youtubeVideoId(url)).toBeNull();
    }
  });

  it('estimates chords, key, tempo and some lead notes from the synthetic demo audio', async () => {
    const wav = new DataView(await demoWav().arrayBuffer());
    const samples = Float32Array.from({ length: (wav.byteLength - 44) / 2 }, (_, i) => wav.getInt16(44 + i * 2, true) / 32768);
    const result = analyzeSamples(samples);
    expect(result.key).toEqual(DEMO_CHART.key);
    expect(result.bpm).toBeGreaterThanOrEqual(115);
    expect(result.bpm).toBeLessThanOrEqual(125);
    expect(result.chords.map(chord => chordName(chord.value))).toEqual(DEMO_CHART.chords.map(chord => chordName(chord.value)));
    expect(result.chords[1].start).toBeCloseTo(2, 0);
    expect(result.melody.slice(0, 4).map(note => note.value)).toEqual([72, 76, 79, 77]);
  });

  it('reports missing estimates for silence', () => {
    const result = analyzeSamples(new Float32Array(44100));
    expect(result).toEqual({ duration: 2, bpm: null, key: null, chords: [], melody: [] });
  });
});
