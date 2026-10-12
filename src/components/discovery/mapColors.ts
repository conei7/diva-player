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
  remainder: '#1f1f1f',
  meterTrack: '#3f3f3f',
} as const;

/** A light 45° hatch that marks a tile as a remainder bucket rather than one song. */
export const REMAINDER_HATCH = 'repeating-linear-gradient(135deg, rgb(255 255 255 / 0.05) 0 2px, transparent 2px 9px)';
export const KNOWN_REMAINDER_HATCH = 'repeating-linear-gradient(135deg, rgb(0 0 0 / 0.18) 0 2px, transparent 2px 9px)';

export const SOUND_MAP_COLORS = {
  surface: '#212121',
  known: '#f1f1f1',
  unknown: '#aaaaaa',
  origin: '#06d6a0',
  selected: '#3ea6ff',
  focus: '#ffffff',
} as const;
