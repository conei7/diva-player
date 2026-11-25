import { describe, expect, it } from 'vitest';
import { analyzeSamples } from './analyze';
import { activeSegment, chordName, pitchClass, searchCharts, youtubeVideoId } from './chart';
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
