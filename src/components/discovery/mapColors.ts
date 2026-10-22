import type { KnowledgeMapPlatform } from '../../api/knowledgeMap';

/*
 * Data colors for the two maps (DESIGN_SPEC §1-2: color is only for data here).
 * Checked with the dataviz validator against the #0f0f0f page:
 * - service fills: white 12px text ≥ 4.5:1 on them, the fills ≥ 3:1 on the page,
 *   and each one vs the not-yet-known gray stays far apart under protan / deutan (ΔE ≥ 18).
 * - the sound map uses shape as well as color (filled ● known / hollow ○ not yet known / ◆ start).
 */
export const KNOWN_SERVICE_COLOR: Record<KnowledgeMapPlatform, string> = {
  youtube: '#d93a3a',
  nico: '#256abf',
};

/** Not-yet-known song tiles are #303030 (hover #3f3f3f), written as classes in KnowledgeTreemap. */
export const KNOWLEDGE_MAP_COLORS = {
  /** The "other songs" remainder: a quiet hatched surface. */
  remainder: 'var(--color-yt-raised)',
  meterTrack: 'var(--color-yt-tonal-solid-hover)',
} as const;

/** A light 45° hatch that marks a tile as a remainder bucket rather than one song. */
export const REMAINDER_HATCH = 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.05) 0 2px, transparent 2px 9px)';
export const KNOWN_REMAINDER_HATCH = 'repeating-linear-gradient(135deg, rgb(0 0 0 / 0.18) 0 2px, transparent 2px 9px)';

export const SOUND_MAP_COLORS = {
  surface: 'var(--color-yt-raised)',
  known: 'var(--color-yt-text)',
  unknown: 'var(--color-yt-text-secondary)',
  origin: 'var(--color-brand)',
  selected: 'var(--color-yt-focus)',
  focus: 'var(--color-yt-text)',
} as const;
