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

export function getPVServiceLabel(service: PVService): string {
  return PV_SERVICE_LABELS[service];
}
