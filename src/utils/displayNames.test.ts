import { describe, expect, it } from 'vitest';
import { WATCH_LATER_ID } from '../stores/playlistStore';
import { displayPlaylistName, displayQueueTitle } from './displayNames';

const english: Record<string, string> = {
  '後で聴く': 'Listen later',
  'ミックス': 'Mix',
  '発掘ミックス': 'Discovery mix',
  'サビ発掘': 'Chorus highlights',
};
const ts = (source: string) => english[source] ?? source;
const identity = (source: string) => source;

describe('displayPlaylistName', () => {
  it('translates only the built-in Listen later playlist', () => {
    expect(displayPlaylistName({ id: WATCH_LATER_ID, name: '後で聴く' }, ts)).toBe('Listen later');
    expect(displayPlaylistName({ id: WATCH_LATER_ID, name: '後で聴く' }, identity)).toBe('後で聴く');
    expect(displayPlaylistName({ id: 'playlist-1', name: '後で聴く' }, ts)).toBe('後で聴く');
    expect(displayPlaylistName({ id: 'playlist-2', name: '作業用BGM' }, ts)).toBe('作業用BGM');
  });
});

describe('displayQueueTitle', () => {
  it('maps the stored built-in queue titles to their current names', () => {
    expect(displayQueueTitle('ミックスリスト', identity)).toBe('ミックス');
    expect(displayQueueTitle('ミックスリスト', ts)).toBe('Mix');
    expect(displayQueueTitle('発掘ミックス', ts)).toBe('Discovery mix');
    expect(displayQueueTitle('15秒サビハイライト', identity)).toBe('サビ発掘');
    expect(displayQueueTitle('15-second chorus highlights', ts)).toBe('Chorus highlights');
    expect(displayQueueTitle('サビ発掘', ts)).toBe('Chorus highlights');
    expect(displayQueueTitle('後で聴く', ts)).toBe('Listen later');
  });

  it('keeps other titles and handles a missing title', () => {
    expect(displayQueueTitle('作業用BGM', ts)).toBe('作業用BGM');
    expect(displayQueueTitle(undefined, ts)).toBe('');
    expect(displayQueueTitle('', ts)).toBe('');
  });
});
