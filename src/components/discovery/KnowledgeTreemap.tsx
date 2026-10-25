import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router';
import type { KnowledgeMapPlatform } from '../../api/knowledgeMap';
import type { Song } from '../../types/vocadb';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import {
  KNOWN_REMAINDER_ID,
  formatKnowledgePercent,
  layoutKnowledgeMap,
  splitKnowledgeMapRemainders,
} from '../../utils/knowledgeMap';
import type { KnowledgeMapItem, KnowledgeMapRect } from '../../utils/knowledgeMap';
import { arrowKeyDirection, nearestInDirection } from '../../utils/soundMap';
import { watchPath } from '../../utils/routes';
import { formatViewCount, serviceLabel } from '../../utils/songMeta';
import Button from '../ui/Button';
import SongThumbnail from '../ui/SongThumbnail';
import { cx } from '../ui/overlay';
import { placeholderSong } from './discoverySongs';
import { isFocusVisible } from './focusVisible';
import { KNOWLEDGE_MAP_COLORS, KNOWN_REMAINDER_HATCH, KNOWN_SERVICE_COLOR, REMAINDER_HATCH } from './mapColors';

export type KnowledgeViewMode = 'all' | 'known' | 'unknown';

/** Space between tiles (the page background shows through). */
const GAP_PX = 2;
/** Song names are drawn on tiles at least this big (they wrap; the views are in the hover card). */
const LABEL_MIN_WIDTH = 36;
const LABEL_MIN_HEIGHT = 20;
/** Tiles at least this big use the 12px name, smaller ones 11px. */
const LARGE_LABEL_MIN_WIDTH = 120;
const LARGE_LABEL_MIN_HEIGHT = 56;
const REMAINDER_LABEL_MIN_WIDTH = 140;
const REMAINDER_LABEL_MIN_HEIGHT = 40;
/** A touch selects the song tile within half of a 44px target. */
const TOUCH_SLOP_PX = 22;
const HOVER_DELAY_MS = 250;
/** Width / height used before the map has been measured. */
const DEFAULT_ASPECT_RATIO = 2;

interface HoverState {
  id: string;
  x: number;
  y: number;
}

interface TileBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface KnowledgeTreemapProps {
  platform: KnowledgeMapPlatform;
  items: KnowledgeMapItem[];
  viewMode: KnowledgeViewMode;
  songsById: ReadonlyMap<number, Song>;
  /** All views on the service: the remainders show their share of it. */
  totalViews: number;
}

function isTouchLike(pointerType: string): boolean {
  return pointerType === 'touch' || pointerType === 'pen';
}

/**
 * Treemap: area = views on the chosen service, among the top song tiles. Tiles show the song name
 * (wrapped to the tile); the views are in the hover card / the card under the map on touch. The rest of the songs
 * ("other songs") is a band under the map with its share of all views, so it can't squeeze the
 * songs into a strip. Song tiles link to the song page with a mouse (hover card, Tab once + arrow
 * keys), and on touch a tap only selects (info card below).
 */
export default function KnowledgeTreemap({ platform, items, viewMode, songsById, totalViews }: KnowledgeTreemapProps) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const navigate = useNavigate();
  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const pointerTypeRef = useRef('mouse');
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<HoverState | null>(null);
  const [cardPosition, setCardPosition] = useState({ left: -9999, top: -9999 });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [touchSelectedId, setTouchSelectedId] = useState<string | null>(null);
  const serviceColor = KNOWN_SERVICE_COLOR[platform];
  const listSeparator = language === 'ja' ? '、' : ', ';

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return undefined;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize(previous => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => window.clearTimeout(hoverTimerRef.current), []);

  // Scale around the map origin, retaining the currently visible map coordinates.
  // The viewport is measured separately so zoom never re-packs the treemap.
  const changeZoom = (next: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const value = Math.max(1, Math.min(8, next));
    pendingScroll.current = {
      left: viewport.scrollLeft * value / zoom,
      top: viewport.scrollTop * value / zoom,
    };
    hideHover();
    setZoom(value);
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const target = pendingScroll.current;
    if (viewport && target) {
      viewport.scrollTo(target.left, target.top);
      pendingScroll.current = null;
    }
  }, [zoom]);

  const aspectRatio = size.width > 0 && size.height > 0 ? size.width / size.height : DEFAULT_ASPECT_RATIO;
  const { tiles, remainders } = useMemo(() => splitKnowledgeMapRemainders(items), [items]);
  const rects = useMemo(() => layoutKnowledgeMap(tiles, aspectRatio), [aspectRatio, tiles]);
  const songRects = useMemo(() => rects.filter(rect => rect.songId !== undefined), [rects]);
  const remainderViews = remainders.reduce((sum, item) => sum + item.views, 0);
  const activeId = songRects.some(rect => rect.id === focusId) ? focusId : songRects[0]?.id ?? null;
  const hoverRect: KnowledgeMapItem | null = hover
    ? rects.find(rect => rect.id === hover.id) ?? remainders.find(item => item.id === hover.id) ?? null
    : null;
  const touchSelected = touchSelectedId ? songRects.find(rect => rect.id === touchSelectedId) ?? null : null;

  // Tiles live in a layer 1px larger than the map on every side (so the outer tiles meet the edge)
  // and each tile is inset by 1px: in map pixels a tile starts at x% of the layer.
  const layerWidth = size.width * zoom + GAP_PX;
  const layerHeight = size.height * zoom + GAP_PX;
  const boxOf = (rect: KnowledgeMapRect): TileBox => ({
    left: (rect.x / 100) * layerWidth,
    top: (rect.y / 100) * layerHeight,
    width: (rect.width / 100) * layerWidth - GAP_PX,
    height: (rect.height / 100) * layerHeight - GAP_PX,
  });

  const statusText = (rect: KnowledgeMapItem) => (rect.known ? t('知っている') : t('まだ知らない'));
  const tileTitle = (rect: KnowledgeMapItem) => {
    if (!rect.aggregate) return rect.label;
    return rect.id === KNOWN_REMAINDER_ID ? t('その他の知っている曲') : t('その他のまだ知らない曲');
  };
  const viewsText = (views: number) => formatViewCount(views, language);
  const shareText = (views: number) => formatKnowledgePercent(totalViews > 0 ? views / totalViews : 0);
  /** 「その他のまだ知らない曲 · 297億回再生 · 87.6%」 (the title already says known / not yet known). */
  const remainderParts = (item: KnowledgeMapItem) => [tileTitle(item), viewsText(item.views), shareText(item.views)];
  /** A remainder is a hatched surface (service color when known), not one song. */
  const remainderSurface = (item: KnowledgeMapItem): CSSProperties => ({
    backgroundColor: item.known ? serviceColor : KNOWLEDGE_MAP_COLORS.remainder,
    backgroundImage: item.known ? KNOWN_REMAINDER_HATCH : REMAINDER_HATCH,
  });
  const areaNote = remainders.length === 0
    ? t('面積＝再生数')
    : songRects.length === 1
      ? t('面積＝再生数（上位1曲）')
      : t('面積＝再生数（上位{count}曲）', { count: songRects.length });

  useLayoutEffect(() => {
    if (!hover) return;
    const card = cardRef.current;
    if (!card) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    let left = hover.x + 12;
    let top = hover.y + 16;
    if (left + card.offsetWidth > viewportWidth - 8) left = hover.x - card.offsetWidth - 12;
    if (top + card.offsetHeight > viewportHeight - 8) top = hover.y - card.offsetHeight - 12;
    const next = { left: Math.max(8, left), top: Math.max(8, top) };
    setCardPosition(previous => (previous.left === next.left && previous.top === next.top ? previous : next));
  }, [hover]);

  useEffect(() => {
    if (!hover) return undefined;
    const hide = () => setHover(null);
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', hide, { capture: true });
  }, [hover]);

  const showHover = (id: string, x: number, y: number, immediate: boolean) => {
    window.clearTimeout(hoverTimerRef.current);
    if (immediate) {
      setHover({ id, x, y });
      return;
    }
    hoverTimerRef.current = window.setTimeout(() => setHover({ id, x, y }), HOVER_DELAY_MS);
  };

  const hideHover = () => {
    window.clearTimeout(hoverTimerRef.current);
    setHover(null);
  };

  const onTilePointerEnter = (event: PointerEvent<HTMLElement>, rect: KnowledgeMapItem) => {
    if (event.pointerType !== 'mouse') return;
    // Moving from one tile to the next swaps the card at once (it is already open).
    showHover(rect.id, event.clientX, event.clientY, hover !== null);
  };

  const onTileFocus = (event: FocusEvent<HTMLElement>, rect: KnowledgeMapRect) => {
    setFocusId(rect.id);
    if (!isFocusVisible(event.currentTarget)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    showHover(rect.id, bounds.left, bounds.bottom - 12, true);
  };

  const selectFromTap = (clientX: number, clientY: number) => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = map.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    let best: KnowledgeMapRect | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const rect of songRects) {
      const box = boxOf(rect);
      const dx = Math.max(box.left - x, 0, x - (box.left + box.width));
      const dy = Math.max(box.top - y, 0, y - (box.top + box.height));
      const distance = Math.hypot(dx, dy);
      if (distance < bestDistance) {
        best = rect;
        bestDistance = distance;
      }
    }
    setTouchSelectedId(best && bestDistance <= TOUCH_SLOP_PX ? best.id : null);
  };

  // `detail === 0` is a click from the keyboard (Enter on a tile): that always opens the song.
  const isTap = (event: MouseEvent<HTMLElement>) => event.detail !== 0 && isTouchLike(pointerTypeRef.current);

  const onMapClick = (event: MouseEvent<HTMLDivElement>) => {
    if (isTap(event)) selectFromTap(event.clientX, event.clientY);
  };

  const onTileClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // A tap only selects the song (the card under the map has 「開く」); a click opens it.
    if (isTap(event)) event.preventDefault();
  };

  const onMapKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = arrowKeyDirection(event.key);
    if (!direction) return;
    const current = (event.target as HTMLElement).closest<HTMLElement>('[data-tile-id]')?.dataset.tileId;
    if (!current) return;
    // Arrow keys move between tiles here; they must not also seek the player.
    event.preventDefault();
    event.stopPropagation();
    const centers = songRects.map(rect => {
      const box = boxOf(rect);
      return { id: rect.id, x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    const next = nearestInDirection(centers, current, direction);
    if (!next) return;
    setFocusId(next.id);
    mapRef.current?.querySelector<HTMLElement>(`[data-tile-id="${next.id}"]`)?.focus();
  };

  const emptyText = viewMode === 'known'
    ? t('まだ知っている曲はありません')
    : viewMode === 'unknown'
      ? t('まだ知らない曲はありません')
      : t('表示する曲がありません');

  const hoverSong = hoverRect?.songId !== undefined
    ? songsById.get(hoverRect.songId) ?? placeholderSong({
      songId: hoverRect.songId,
      name: hoverRect.label,
      artistString: hoverRect.secondaryLabel ?? '',
      thumbUrl: hoverRect.thumbUrl,
    })
    : null;
  const selectedSong = touchSelected?.songId !== undefined
    ? songsById.get(touchSelected.songId) ?? placeholderSong({
      songId: touchSelected.songId,
      name: touchSelected.label,
      artistString: touchSelected.secondaryLabel ?? '',
      thumbUrl: touchSelected.thumbUrl,
    })
    : null;

  return (
    <div>
      <div
        role="group"
        aria-label={t('{service}の再生数マップ', { service: serviceLabel(platform === 'youtube' ? 'Youtube' : 'NicoNicoDouga', language) })}
        data-testid={`${platform}-knowledge-treemap`}
      >
        <div className="mb-2 flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" aria-label={t('縮小')} title={t('縮小')} disabled={zoom <= 1} onClick={() => changeZoom(zoom - 0.5)}>−</Button>
          <Button size="sm" variant="ghost" aria-label={t('リセット')} title={t('リセット')} onClick={() => {
            hideHover();
            pendingScroll.current = { left: 0, top: 0 };
            viewportRef.current?.scrollTo(0, 0);
            setZoom(1);
          }}><span className="inline-block w-12 tabular-nums">{Math.round(zoom * 100)}%</span></Button>
          <Button size="sm" variant="ghost" aria-label={t('拡大')} title={t('拡大')} disabled={zoom >= 8} onClick={() => changeZoom(zoom + 0.5)}>＋</Button>
        </div>
        <div ref={frameRef} className="relative h-[clamp(360px,60vh,560px)] overflow-hidden rounded-card bg-yt-bg max-sm:-mx-3 max-sm:h-80 max-sm:rounded-none">
          <div ref={viewportRef} data-testid="knowledge-map-viewport" className="absolute inset-0 overflow-auto overscroll-contain" onScroll={hideHover}>
            <div
              ref={mapRef}
              data-testid="knowledge-map-surface"
              className="relative overflow-hidden"
              style={{ width: size.width > 0 ? size.width * zoom : '100%', height: size.height > 0 ? size.height * zoom : '100%' }}
              onPointerDownCapture={event => { pointerTypeRef.current = event.pointerType; }}
              onPointerLeave={hideHover}
              onClick={onMapClick}
              onKeyDown={onMapKeyDown}
            >
              {rects.length === 0 ? (
                <div className="flex h-full items-center justify-center bg-yt-raised px-4 text-center text-sm text-yt-text-secondary">
                  {emptyText}
                </div>
              ) : (
                <div className="absolute -inset-px">
                  {rects.map(rect => {
                    const box = boxOf(rect);
                    const style: CSSProperties = {
                      left: `calc(${rect.x}% + ${GAP_PX / 2}px)`,
                      top: `calc(${rect.y}% + ${GAP_PX / 2}px)`,
                      width: `max(0px, calc(${rect.width}% - ${GAP_PX}px))`,
                      height: `max(0px, calc(${rect.height}% - ${GAP_PX}px))`,
                    };

                    if (rect.songId === undefined) {
                      // Only remainders are left (a filter without song tiles): they fill the map.
                      const showLabel = box.width >= REMAINDER_LABEL_MIN_WIDTH && box.height >= REMAINDER_LABEL_MIN_HEIGHT;
                      return (
                        <div
                          key={rect.id}
                          role="img"
                          aria-label={remainderParts(rect).join(listSeparator)}
                          data-tile-id={rect.id}
                          className="absolute flex items-center justify-center overflow-hidden rounded-badge px-3 text-center"
                          style={{ ...style, ...remainderSurface(rect) }}
                          onPointerEnter={showLabel ? hideHover : event => onTilePointerEnter(event, rect)}
                        >
                          {showLabel && (
                            <span className={cx('line-clamp-2 text-sm leading-5', rect.known ? 'text-white' : 'text-yt-text-secondary')}>
                              {remainderParts(rect).join(' · ')}
                            </span>
                          )}
                        </div>
                      );
                    }

                    const title = tileTitle(rect);
                    const views = viewsText(rect.views);
                    const showLabel = box.width >= LABEL_MIN_WIDTH && box.height >= LABEL_MIN_HEIGHT;
                    const largeLabel = box.width >= LARGE_LABEL_MIN_WIDTH && box.height >= LARGE_LABEL_MIN_HEIGHT;
                    // As many wrapped lines as fit (padding 8 / 4px, line height 16 / 13px).
                    const labelLines = Math.max(1, Math.floor((box.height - (largeLabel ? 16 : 8)) / (largeLabel ? 16 : 13)));
                    const selected = rect.id === touchSelectedId;
                    return (
                      <Link
                        key={rect.id}
                        to={watchPath(rect.songId, { autoplay: false })}
                        aria-label={[title, views, statusText(rect)].join(listSeparator)}
                        data-tile-id={rect.id}
                        tabIndex={rect.id === activeId ? 0 : -1}
                        className={cx(
                          'absolute flex overflow-hidden rounded-badge no-underline outline-none transition-[filter,background-color] duration-150',
                          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yt-focus',
                          rect.known ? 'text-white hover:brightness-110' : 'text-yt-text bg-yt-tonal-solid hover:bg-yt-tonal-solid-hover',
                          selected && 'outline-2 -outline-offset-2 outline-yt-focus',
                        )}
                        style={rect.known ? { ...style, backgroundColor: serviceColor } : style}
                        onClick={onTileClick}
                        onPointerEnter={event => onTilePointerEnter(event, rect)}
                        onFocus={event => onTileFocus(event, rect)}
                        onBlur={hideHover}
                      >
                        {showLabel && (
                          <span
                            aria-hidden="true"
                            className={cx(
                              'flex min-w-0 flex-1 flex-col justify-end text-left font-bold',
                              largeLabel ? 'p-2 text-xs leading-4' : 'px-1 py-1 text-[11px] leading-[13px]',
                            )}
                          >
                            <span
                              className="overflow-hidden break-words [overflow-wrap:anywhere]"
                              style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: labelLines }}
                            >
                              {title}
                            </span>
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        </div>

        {remainders.length > 0 && (
          // The rest of the songs: one band, each remainder as wide as its views.
          <div
            data-testid="knowledge-map-remainder"
            className="mt-2 flex h-10 gap-0.5 overflow-hidden rounded-card max-sm:-mx-3 max-sm:rounded-none"
            onPointerLeave={hideHover}
          >
            {remainders.map(item => {
              const share = remainderViews > 0 ? item.views / remainderViews : 0;
              const showLabel = share * Math.max(0, size.width - GAP_PX * (remainders.length - 1)) >= REMAINDER_LABEL_MIN_WIDTH;
              return (
                <div
                  key={item.id}
                  role="img"
                  aria-label={remainderParts(item).join(listSeparator)}
                  data-tile-id={item.id}
                  // No padding here, so a tiny share stays as thin as its views. Only an unlabeled
                  // (thin) remainder gets the hover card; a labeled one already shows it all.
                  className="flex min-w-1.5 basis-0 items-center justify-center overflow-hidden rounded-badge text-center"
                  style={{ flexGrow: share, ...remainderSurface(item) }}
                  onPointerEnter={showLabel ? hideHover : event => onTilePointerEnter(event, item)}
                >
                  {showLabel && (
                    <span className={cx('min-w-0 truncate px-3 text-sm leading-5', item.known ? 'text-white' : 'text-yt-text-secondary')}>
                      {remainderParts(item).join(' · ')}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {rects.length > 0 && (
          // Under the chart rather than in its corner, where it covered the last tile's name.
          <p className="m-0 mt-1.5 text-right text-xs leading-4 text-yt-text-secondary">{areaNote}</p>
        )}
      </div>

      {touchSelected && selectedSong && touchSelected.songId !== undefined && (
        <div className="mt-3 flex items-center gap-3 rounded-card bg-yt-raised p-2" aria-live="polite">
          <SongThumbnail song={selectedSong} className="w-24" radius="sm" showDuration={false} />
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-sm font-medium leading-5 text-yt-text">{touchSelected.label}</p>
            <p className="m-0 truncate text-xs leading-[18px] text-yt-text-secondary">
              {viewsText(touchSelected.views)} · {statusText(touchSelected)}
            </p>
          </div>
          <Button size="sm" onClick={() => navigate(watchPath(touchSelected.songId as number, { autoplay: false }))}>
            {t('開く')}
          </Button>
        </div>
      )}

      {hoverRect && typeof document !== 'undefined' && createPortal(
        <div
          ref={cardRef}
          role="tooltip"
          data-testid="knowledge-map-tooltip"
          className="pointer-events-none fixed z-[var(--z-tooltip,95)] w-60 overflow-hidden rounded-card bg-yt-menu shadow-[0_4px_32px_rgba(0,0,0,0.5)]"
          style={{ left: cardPosition.left, top: cardPosition.top }}
        >
          {hoverSong && <SongThumbnail song={hoverSong} className="w-full" radius="none" showDuration={false} loading="eager" />}
          <div className="px-3 py-2.5">
            <p className="m-0 line-clamp-2 text-sm font-medium leading-5 text-yt-text">{tileTitle(hoverRect)}</p>
            {hoverRect.secondaryLabel && (
              <p className="m-0 mt-0.5 truncate text-xs leading-[18px] text-yt-text-secondary">{hoverRect.secondaryLabel}</p>
            )}
            <p className="m-0 mt-1 text-xs leading-[18px] text-yt-text-secondary">
              {viewsText(hoverRect.views)} · {hoverRect.aggregate ? shareText(hoverRect.views) : statusText(hoverRect)}
            </p>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
