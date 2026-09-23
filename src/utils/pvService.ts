import type { PVService } from '../types/vocadb';

const PV_SERVICE_LABELS: Record<PVService, string> = {
  Youtube: 'YT',
  NicoNicoDouga: 'ニコ',
  SoundCloud: 'SoundCloud',
  Vimeo: 'Vimeo',
  Piapro: 'piapro',
  Bilibili: 'Bilibili',
  File: 'ファイル',
  LocalFile: 'ローカル',
  Creofuga: 'creofuga',
  Bandcamp: 'Bandcamp',
};

const PV_SERVICE_LABELS_EN: Partial<Record<PVService, string>> = {
  NicoNicoDouga: 'Niconico',
  File: 'File',
  LocalFile: 'Local',
};

export function getPVServiceLabel(service: PVService, language: 'ja' | 'en' = 'ja'): string {
  return language === 'en' ? PV_SERVICE_LABELS_EN[service] ?? PV_SERVICE_LABELS[service] : PV_SERVICE_LABELS[service];
}
