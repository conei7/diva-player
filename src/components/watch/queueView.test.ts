import { describe, expect, it } from 'vitest';
import type { Song } from '../../types/vocadb';
import type { PlaybackSource } from '../../stores/playerStore';
import { buildQueueView } from './queueView';

function songs(count: number, firstId = 1): Song[] {
  return Array.from({ length: count }, (_, index) => ({ id: firstId + index, name: `Song ${firstId + index}` }) as Song);
}

describe('buildQueueView', () => {
  it('counts only the songs that autoplay did not add', () => {
    const queue = [...songs(28), ...songs(12, 100)];
    const sources: PlaybackSource[] = [...Array(28).fill('manual'), ...Array(12).fill('auto')];
    const view = buildQueueView(queue, 3, sources, '作業用BGM');

    expect(view.position).toEqual({ current: 4, total: 28 });
    expect(view.currentIsAuto).toBe(false);
    expect(view.isMix).toBe(false);
    expect(view.nextSong?.id).toBe(5);
    expect(view.segments.map(segment => [segment.auto, segment.entries.length])).toEqual([[false, 28], [true, 12]]);
  });

  it('has no position while an autoplay song is playing', () => {
    const queue = [...songs(1), ...songs(5, 100)];
    const sources: PlaybackSource[] = ['manual', 'auto', 'auto', 'auto', 'auto', 'auto'];
    const view = buildQueueView(queue, 2, sources, 'ミックスリスト');

    expect(view.position).toBeNull();
    expect(view.currentIsAuto).toBe(true);
    expect(view.isMix).toBe(true);
  });

  it('keeps ten played songs and the original queue indexes in the window', () => {
    const queue = songs(55);
    const view = buildQueueView(queue, 30, [], '作業用BGM');

    expect(view.entries[0]).toMatchObject({ index: 20, auto: false });
    expect(view.entries).toHaveLength(35);
    expect(view.position).toEqual({ current: 31, total: 55 });
  });

  it('treats discovery queues and built-in titles as mixes', () => {
    const queue = songs(3);
    expect(buildQueueView(queue, 0, ['discovery', 'discovery', 'discovery'], 'Whatever').isMix).toBe(true);
    expect(buildQueueView(queue, 0, ['manual', 'manual', 'manual'], '発掘ミックス').isMix).toBe(true);
    expect(buildQueueView(queue, 0, ['manual', 'manual', 'manual'], 'サビ発掘').isMix).toBe(true);
    expect(buildQueueView(queue, 0, ['manual', 'manual', 'manual'], '後で聴く').isMix).toBe(false);
  });

  it('starts a new segment whenever autoplay songs start or stop and counts duplicates', () => {
    const queue = [...songs(2), ...songs(2, 100), songs(1)[0]];
    const sources: PlaybackSource[] = ['manual', 'manual', 'auto', 'auto', 'manual'];
    const view = buildQueueView(queue, 0, sources, '作業用BGM');

    expect(view.segments.map(segment => segment.auto)).toEqual([false, true, false]);
    expect(view.duplicateCount).toBe(1);
    expect(view.position).toEqual({ current: 1, total: 3 });
  });

  it('handles an empty queue', () => {
    const view = buildQueueView([], -1, [], undefined);
    expect(view.entries).toEqual([]);
    expect(view.position).toBeNull();
    expect(view.nextSong).toBeNull();
  });
});
