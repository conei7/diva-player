/**
 * VocaDB API response types
 * Based on: https://vocadb.net/swagger/index.html
 */

// ─── PV (動画) ───
export type PVService = 'Youtube' | 'NicoNicoDouga' | 'SoundCloud' | 'Vimeo' | 'Piapro' | 'Bilibili' | 'File' | 'LocalFile' | 'Creofuga' | 'Bandcamp';
export type PVType = 'Original' | 'Reprint' | 'Other';

export interface PV {
  author: string;
  disabled: boolean;
  id: number;
  length: number;
  name: string;
  publishDate?: string;
  pvId: string;
  service: PVService;
  pvType: PVType;
  thumbUrl?: string;
  url: string;
  description?: string;
}

// ─── アーティスト ───
export type ArtistType = 'Producer' | 'Vocalist' | 'Vocaloid' | 'UTAU' | 'CeVIO' | 'Illustrator' | 'Lyricist' | 'Animator' | 'CoverArtist' | 'OtherVoiceSynthesizer' | 'OtherVocalist' | 'OtherGroup' | 'OtherIndividual' | 'Unknown' | 'Band' | 'Circle' | 'Label' | 'SynthesizerV' | 'NEUTRINO' | 'VoiSona' | 'NewType' | 'Voiceroid' | 'Instrumentalist' | 'Designer';
export type ArtistCategory = 'Producer' | 'Vocalist' | 'Illustrator' | 'Lyricist' | 'Animator' | 'Band' | 'Circle' | 'Label' | 'Subject' | 'Nothing' | 'Other';

export interface ArtistRef {
  additionalNames: string;
  artistType: ArtistType;
  deleted: boolean;
  id: number;
  name: string;
  pictureMime?: string;
  releaseDate?: string;
  status: string;
  version: number;
}

export interface ArtistForSong {
  artist: ArtistRef;
  categories: ArtistCategory;
  effectiveRoles: string;
  id: number;
  isCustomName: boolean;
  isSupport: boolean;
  name: string;
  roles: string;
}

// ─── 曲 ───
export type SongType = 'Original' | 'Remaster' | 'Remix' | 'Cover' | 'Arrangement' | 'Instrumental' | 'Mashup' | 'MusicPV' | 'DramaPV' | 'Other' | 'Unspecified';

export interface Song {
  artists?: ArtistForSong[];
  artistString: string;
  createDate: string;
  defaultName: string;
  defaultNameLanguage: string;
  favoritedTimes: number;
  id: number;
  lengthSeconds: number;
  name: string;
  originalVersionId?: number;
  publishDate?: string;
  pvs?: PV[];
  pvServices: string;
  ratingScore: number;
  songType: SongType;
  status: string;
  thumbUrl?: string;
  version: number;
}

// ─── 検索結果 ───
export interface PartialFindResult<T> {
  items: T[];
  term: string;
  totalCount: number;
}

export type SongSearchResult = PartialFindResult<Song>;

// ─── 検索パラメータ ───
export type SongSortRule = 'None' | 'Name' | 'AdditionDate' | 'PublishDate' | 'FavoritedTimes' | 'RatingScore' | 'TagUsageCount' | 'SongType';
export type NameMatchMode = 'Auto' | 'Partial' | 'Exact' | 'StartsWith' | 'Words';
export type ContentLanguagePreference = 'Default' | 'Japanese' | 'Romaji' | 'English';
export type VocalistMatchMode = 'Any' | 'All' | 'Exact';

export interface SongSearchParams {
  query?: string;
  artistId?: number;
  artistIds?: number[];
  artistParticipationStatus?: 'Everything' | 'OnlyMainAlbums' | 'OnlyCollaborations';
  tagName?: string[];
  tagId?: number[];
  sort?: SongSortRule;
  songTypes?: SongType[];
  minScore?: number;
  maxResults?: number;
  start?: number;
  getTotalCount?: boolean;
  fields?: string;
  lang?: ContentLanguagePreference;
  nameMatchMode?: NameMatchMode;
  minBpm?: number;
  maxBpm?: number;
  onlyWithPVs?: boolean;
}

// ─── アーティスト検索 ───
export interface Artist {
  id: number;
  name: string;
  artistType: ArtistType;
}

export type ArtistSearchResult = PartialFindResult<Artist>;

// ─── プレイリスト ───
export interface Playlist {
  id: string;
  name: string;
  songs: Song[];
  createdAt: number;
  updatedAt: number;
}

// ─── プレイヤー状態で使う再生可能PV情報 ───
export interface PlayablePV {
  song: Song;
  pv: PV;
}
