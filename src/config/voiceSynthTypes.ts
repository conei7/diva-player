export const VOICE_SYNTH_ARTIST_TYPES = [
  'Vocaloid',
  'UTAU',
  'CeVIO',
  'SynthesizerV',
  'NEUTRINO',
  'VoiSona',
  'Voiceroid',
  'OtherVoiceSynthesizer',
  'NewType',
  'ACEVirtualSinger',
  'VOICEVOX',
  'AIVOICE',
] as const;

export type VoiceSynthArtistType = typeof VOICE_SYNTH_ARTIST_TYPES[number];

export const VOCALIST_SEARCH_ARTIST_TYPES = [
  ...VOICE_SYNTH_ARTIST_TYPES,
  'OtherVocalist',
] as const;

export const VOICE_SYNTH_TYPE_LABELS: Readonly<Record<VoiceSynthArtistType, string>> = {
  Vocaloid: 'ボカロ',
  UTAU: 'UTAU',
  CeVIO: 'CeVIO',
  SynthesizerV: 'SynthV',
  NEUTRINO: 'NEUTRINO',
  VoiSona: 'VoiSona',
  Voiceroid: 'VOICEROID',
  OtherVoiceSynthesizer: 'その他の合成音声',
  NewType: 'ピアプロ NT',
  ACEVirtualSinger: 'ACE',
  VOICEVOX: 'VOICEVOX',
  AIVOICE: 'A.I.VOICE',
};

const voiceSynthArtistTypeSet: ReadonlySet<string> = new Set(VOICE_SYNTH_ARTIST_TYPES);

export function isVoiceSynthArtistType(value: string | undefined): value is VoiceSynthArtistType {
  return value !== undefined && voiceSynthArtistTypeSet.has(value);
}
