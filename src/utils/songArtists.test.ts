import { describe, expect, it } from 'vitest';
import { getSongProducerEntries } from './songArtists';

describe('getSongProducerEntries', () => {
  it('returns every producer with an independent searchable link', () => {
    const producers = getSongProducerEntries({
      artistString: 'A, B',
      artists: [
        {
          id: 10,
          artist: { id: 10, name: 'A', artistType: 'Producer', additionalNames: '', deleted: false, pictureMime: '', releaseDate: '', status: 'Finished', version: 1 },
          categories: 'Producer',
          effectiveRoles: '',
          isCustomName: false,
          isSupport: false,
          name: 'A',
          roles: '',
        },
        {
          id: 20,
          artist: { id: 20, name: 'B', artistType: 'Producer', additionalNames: '', deleted: false, pictureMime: '', releaseDate: '', status: 'Finished', version: 1 },
          categories: 'Producer',
          effectiveRoles: '',
          isCustomName: false,
          isSupport: false,
          name: 'B',
          roles: '',
        },
      ],
    });

    expect(producers).toHaveLength(2);
    expect(producers.map(producer => producer.name)).toEqual(['A', 'B']);
    expect(producers.map(producer => producer.href)).toEqual([
      '/?artistId=10&artistName=A',
      '/?artistId=20&artistName=B',
    ]);
  });

  it('ignores non-producers and unnamed producer rows', () => {
    const producers = getSongProducerEntries({
      artistString: 'Fallback',
      artists: [
        {
          id: 1,
          artist: { id: 1, name: 'Singer', artistType: 'Vocalist', additionalNames: '', deleted: false, pictureMime: '', releaseDate: '', status: 'Finished', version: 1 },
          categories: 'Vocalist',
          effectiveRoles: '',
          isCustomName: false,
          isSupport: false,
          name: 'Singer',
          roles: '',
        },
      ],
    });

    expect(producers).toEqual([]);
  });

  it('keeps custom-name producers when VocaDB omits the nested artist object', () => {
    const producers = getSongProducerEntries({
      artistString: '上田剛士 feat. various',
      artists: [
        {
          id: 2704501,
          categories: 'Producer',
          effectiveRoles: 'Composer',
          isCustomName: true,
          isSupport: false,
          name: '上田剛士',
          roles: 'Composer',
        },
      ],
    });

    expect(producers).toEqual([{
      id: undefined,
      name: '上田剛士',
      artistType: undefined,
      href: '/?q=%E4%B8%8A%E7%94%B0%E5%89%9B%E5%A3%AB',
    }]);
  });
});
