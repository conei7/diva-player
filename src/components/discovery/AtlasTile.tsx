import { memo } from 'react';
import { Link } from 'react-router';
import { watchPath } from '../../utils/routes';
import type { KnowledgeMapPlatform } from '../../api/knowledgeMap';
import { KNOWN_SERVICE_COLOR, KNOWLEDGE_MAP_COLORS } from './mapColors';

interface Props {
  id: number; index: number; views: number; name?: string; platform: KnowledgeMapPlatform; knownRatio: number;
  x: number; y: number; width: number; height: number; labelWidth: number; labelLeft: number; labelBottom: number; lines: number; first: boolean;
}

/** Stable tiles keep their text layout when a neighbour or hover card changes. */
export default memo(function AtlasTile({ id, index, views, name, platform, knownRatio, x, y, width, height, labelWidth, labelLeft, labelBottom, lines, first }: Props) {
  return <Link to={watchPath(id, { autoplay: false })} data-tile-id={`song-${id}`} data-atlas-index={index} data-views={views}
    aria-label={name ?? String(id)} tabIndex={first ? 0 : -1}
    className={`absolute overflow-clip rounded-badge text-xs font-bold leading-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yt-focus ${knownRatio === 1 ? 'text-white' : 'text-yt-text'}`}
    style={{ left: x, top: y, width, height, contain: 'strict',
      fontFamily: 'system-ui, sans-serif',
      backgroundColor: knownRatio === 1 ? KNOWN_SERVICE_COLOR[platform] : knownRatio === 0 ? KNOWLEDGE_MAP_COLORS.remainder
        : `color-mix(in srgb, ${KNOWN_SERVICE_COLOR[platform]} ${knownRatio * 100}%, ${KNOWLEDGE_MAP_COLORS.remainder})` }}>
    {lines > 0 && name && <span className="absolute overflow-hidden break-words [overflow-wrap:anywhere]"
      style={{ left: labelLeft, bottom: labelBottom, maxWidth: labelWidth, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines }}>{name}</span>}
  </Link>;
});
