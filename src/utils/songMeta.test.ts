import { describe, expect, it } from 'vitest';
import type { ArtistForSong, Song } from '../types/vocadb';
import {
  artistRoleLabel,
  artistTypeLabel,
  formatArtistLine,
  formatClockDuration,
  formatCompactCount,
  formatCount,
  formatTotalDuration,
  formatViewCount,
  getFeaturedVocalistNames,
  getProducerNames,
  getVocalistNames,
  pvKindLabel,
  serviceLabel,
  songTypeLabel,
} from './songMeta';

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: 1,
    name: 'ワールズエンド・ダンスホール',
    defaultName: 'ワールズエンド・ダンスホール',
    defaultNameLanguage: 'Japanese',
    artistString: 'wowaka feat. 初音ミク, 巡音ルカ',
    createDate: '2010-01-01',
    favoritedTimes: 0,
    lengthSeconds: 210,
    pvServices: 'Youtube',
    ratingScore: 0,
    songType: 'Original',
    status: 'Finished',
    version: 1,
    ...overrides,
  };
}

function credit(name: string, categories: string, overrides: Partial<ArtistForSong> = {}): ArtistForSong {
  return {
    id: name.length,
    name,
    categories: categories as ArtistForSong['categories'],
    effectiveRoles: 'Default',
    isCustomName: false,
    isSupport: false,
    roles: 'Default',
    ...overrides,
  };
}

describe('artist names', () => {
  it('reads producers and vocalists from the credits', () => {
    const credited = song({
      artists: [
        credit('wowaka', 'Producer'),
        credit('初音ミク', 'Vocalist'),
        credit('初音ミク (V3)', 'Vocalist'),
        credit('コーラス', 'Vocalist', { isSupport: true }),
      ],
    });
    expect(getProducerNames(credited)).toEqual(['wowaka']);
    expect(getVocalistNames(credited)).toEqual(['初音ミク']);
    expect(formatArtistLine(credited)).toBe('wowaka');
    expect(formatArtistLine(credited, { withVocalists: true })).toBe('wowaka feat. 初音ミク');
  });

  it('uses support vocalists only when there is no main vocalist', () => {
    expect(getVocalistNames(song({ artists: [credit('GUMI', 'Vocalist', { isSupport: true })] }))).toEqual(['GUMI']);
  });

  it('falls back to artistString', () => {
    const plain = song();
    expect(getProducerNames(plain)).toEqual(['wowaka']);
    expect(getVocalistNames(plain)).toEqual(['初音ミク', '巡音ルカ']);
    expect(formatArtistLine(plain, { withVocalists: true })).toBe('wowaka feat. 初音ミク, 巡音ルカ');
    expect(formatArtistLine(song({ artistString: 'supercell' }))).toBe('supercell');
    expect(getProducerNames(song({ artistString: '' }))).toEqual([]);
    expect(formatArtistLine(song({ artistString: '' }), { withVocalists: true })).toBe('');
  });

  it('names a producer who also sings (self-cover) once', () => {
    const selfCover = song({
      artistString: 'バルーン feat. バルーン',
      artists: [credit('バルーン', 'Producer'), credit('バルーン', 'Vocalist')],
    });
    expect(getFeaturedVocalistNames(selfCover)).toEqual([]);
    expect(formatArtistLine(selfCover, { withVocalists: true })).toBe('バルーン');

    const withMiku = song({
      artists: [
        credit('ピノキオピー', 'Producer'),
        credit('ピノキオピー', 'Vocalist'),
        credit('初音ミク V4X (Dark)', 'Vocalist'),
      ],
    });
    expect(getVocalistNames(withMiku)).toEqual(['ピノキオピー', '初音ミク V4X (Dark)']);
    expect(getFeaturedVocalistNames(withMiku)).toEqual(['初音ミク V4X (Dark)']);
    expect(formatArtistLine(withMiku, { withVocalists: true })).toBe('ピノキオピー feat. 初音ミク V4X (Dark)');

    // artistString only: the producer part before " feat." may list several names.
    expect(formatArtistLine(song({ artistString: 'A, B feat. B, 初音ミク' }), { withVocalists: true })).toBe('A, B feat. 初音ミク');
    // Without producers the vocalists stay.
    expect(getFeaturedVocalistNames(song({ artistString: '', artists: [credit('GUMI', 'Vocalist')] }))).toEqual(['GUMI']);
  });
});

describe('view counts', () => {
  it('formats views with three significant digits', () => {
    expect(formatViewCount(44_700_000, 'ja')).toBe('4470万回再生');
    expect(formatViewCount(110_000_000, 'ja')).toBe('1.1億回再生');
    expect(formatViewCount(9_876, 'ja')).toBe('9,876回再生');
    expect(formatViewCount(12_345, 'ja')).toBe('1.23万回再生');
    expect(formatViewCount(44_700_000, 'en')).toBe('44.7M views');
    expect(formatViewCount(999, 'en')).toBe('999 views');
    expect(formatViewCount(1, 'en')).toBe('1 view');
    expect(formatViewCount(0, 'en')).toBe('0 views');
  });

  it('formats compact counts for chips and badges', () => {
    expect(formatCompactCount(44_700_000, 'ja')).toBe('4470万');
    expect(formatCompactCount(9_876, 'ja')).toBe('9,876');
    expect(formatCompactCount(44_700_000, 'en')).toBe('44.7M');
    expect(formatCompactCount(1_234, 'en')).toBe('1.23K');
    expect(formatCompactCount(Number.NaN, 'en')).toBe('0');
  });
});

describe('counts and durations', () => {
  it('formats counts with units and English plurals', () => {
    expect(formatCount(28, 'song', 'ja')).toBe('28曲');
    expect(formatCount(12, 'video', 'ja')).toBe('12本');
    expect(formatCount(1_200, 'item', 'ja')).toBe('1,200件');
    expect(formatCount(1, 'song', 'en')).toBe('1 song');
    expect(formatCount(28, 'song', 'en')).toBe('28 songs');
    expect(formatCount(1, 'video', 'en')).toBe('1 video');
    expect(formatCount(0, 'item', 'en')).toBe('0 items');
  });

  it('formats clock durations', () => {
    expect(formatClockDuration(225)).toBe('3:45');
    expect(formatClockDuration(3_723)).toBe('1:02:03');
    expect(formatClockDuration(59.9)).toBe('0:59');
    expect(formatClockDuration(-1)).toBe('0:00');
    expect(formatClockDuration(Number.NaN)).toBe('0:00');
  });

  it('formats total durations', () => {
    expect(formatTotalDuration(4_740, 'ja')).toBe('1時間19分');
    expect(formatTotalDuration(2_040, 'ja')).toBe('34分');
    expect(formatTotalDuration(7_200, 'ja')).toBe('2時間');
    expect(formatTotalDuration(4_740, 'en')).toBe('1 hr 19 min');
    expect(formatTotalDuration(2_040, 'en')).toBe('34 min');
    expect(formatTotalDuration(20, 'en')).toBe('1 min');
    expect(formatTotalDuration(0, 'ja')).toBe('0分');
  });
});

describe('enum labels', () => {
  it('labels song types', () => {
    expect(songTypeLabel('Original', 'ja')).toBe('オリジナル');
    expect(songTypeLabel('MusicPV', 'ja')).toBe('PV');
    expect(songTypeLabel('MusicPV', 'en')).toBe('Music video');
    expect(songTypeLabel('Unspecified', 'ja')).toBe('未分類');
  });

  it('labels credit roles, including role lists', () => {
    expect(artistRoleLabel('Composer', 'ja')).toBe('作曲');
    expect(artistRoleLabel('VoiceManipulator', 'en')).toBe('Voice manipulator');
    expect(artistRoleLabel('Composer, Lyricist', 'ja')).toBe('作曲・作詞');
    expect(artistRoleLabel('Composer, Lyricist', 'en')).toBe('Composer, Lyricist');
    expect(artistRoleLabel('Default', 'ja')).toBe('その他');
    expect(artistRoleLabel('SomethingNew', 'ja')).toBe('その他');
  });

  it('labels artist types', () => {
    expect(artistTypeLabel('Producer', 'ja')).toBe('ボカロP');
    expect(artistTypeLabel('Circle', 'en')).toBe('Circle');
    expect(artistTypeLabel('Vocaloid', 'ja')).toBe('ボーカル');
    expect(artistTypeLabel('SynthesizerV', 'en')).toBe('Vocalist');
    expect(artistTypeLabel('Illustrator', 'ja')).toBe('アーティスト');
  });

  it('labels video kinds and services', () => {
    expect(pvKindLabel('Original', 'ja')).toBe('公式');
    expect(pvKindLabel('Reprint', 'ja')).toBe('転載');
    expect(pvKindLabel('Reprint', 'en')).toBe('Reupload');
    expect(pvKindLabel('Other', 'en')).toBe('Other');
    expect(serviceLabel('Youtube', 'ja')).toBe('YouTube');
    expect(serviceLabel('NicoNicoDouga', 'ja')).toBe('ニコニコ');
    expect(serviceLabel('NicoNicoDouga', 'en')).toBe('Niconico');
    expect(serviceLabel('Unknown', 'en')).toBe('Unknown');
  });
});
