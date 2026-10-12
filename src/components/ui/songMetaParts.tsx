import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { PVService, Song } from '../../types/vocadb';

/** Helpers for the meta lines under song titles (used with ViewCounts). */

const BADGE_SERVICES: PVService[] = ['Youtube', 'NicoNicoDouga', 'SoundCloud', 'Bilibili'];

export function hasActivePV(song: Song, service: PVService): boolean {
  return (song.pvs ?? []).some(pv => !pv.disabled && pv.service === service);
}

export function finiteViews(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** True when ViewCounts renders at least one badge (callers leave out the 「 · 」 otherwise). */
export function hasViewCounts(song: Song): boolean {
  return finiteViews(song.youtubeViews) > 0
    || finiteViews(song.nicoViews) > 0
    || BADGE_SERVICES.some(service => hasActivePV(song, service));
}

/** Joins meta parts (text or nodes) with 「 · 」, leaving out empty ones. */
export function joinMetaParts(parts: ReactNode[]): ReactNode {
  const visible = parts.filter(part => part !== null && part !== undefined && part !== false && part !== '');
  if (visible.length === 0) return null;
  return visible.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && ' · '}
      {part}
    </Fragment>
  ));
}
