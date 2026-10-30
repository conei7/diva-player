import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import type { SoundMapPoint, SoundMapResponse } from '../../api/soundMap';
import { useTranslateSourceText } from '../../i18n';
import { arrowKeyDirection, clampSoundMapZoom, nearestInDirection, soundMapItemLabel } from '../../utils/soundMap';
import type { SoundMapViewport } from '../../utils/soundMap';
import IconButton from '../ui/IconButton';
import { AddIcon, SpinnerIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { MyLocationIcon, RemoveIcon, UndoIcon } from './discoveryIcons';
import { isFocusVisible } from './focusVisible';
import { SOUND_MAP_COLORS } from './mapColors';
import { layoutSoundMapOrigins } from '../../utils/soundMapOrigins';

/** Map size assumed before the first measurement (only the dot sizes depend on it). */
const FALLBACK_SIZE = { width: 640, height: 480 };
/** A click or hover picks the nearest dot within this distance (a ~40px target). */
const HIT_RADIUS_PX = 20;
const ZOOM_STEP = 0.35;
/** A mouse press that moves farther than this pans the map instead of selecting a dot. */
const DRAG_THRESHOLD_PX = 4;

export interface SoundMapCanvasProps {
  items: SoundMapPoint[];
  knownIds: ReadonlySet<number>;
  originId: number;
  originIds?: ReadonlySet<number>;
  maxZoom?: number;
  allowTouchPan?: boolean;
  selectedId: number | null;
  viewport: SoundMapViewport;
  axes: SoundMapResponse['axes'];
  loading: boolean;
  /** First-visit coach mark (rendered over the top of the map). */
  guide?: ReactNode;
  canGoBack: boolean;
  onSelect: (point: SoundMapPoint) => void;
  onViewportChange: (next: SoundMapViewport) => void;
  onFocusOrigin: () => void;
  onBack: () => void;
}

interface Projection {
  /** Map units per CSS pixel. */
  unit: number;
  toScreen: (x: number, y: number) => { x: number; y: number };
}

/**
 * Scatter of songs by sound. Dots: filled = known, hollow = not yet known, ◆ = starting song,
 * blue ring = selected, white ring = keyboard focus. Selecting never plays.
 * Keyboard: Tab enters once, arrow keys move to the nearest dot that way, Enter / Space select.
 */
export default function SoundMapCanvas({
  items,
  knownIds,
  originId,
  originIds,
  maxZoom = 5,
  allowTouchPan = false,
  selectedId,
  viewport,
  axes,
  loading,
  guide,
  canGoBack,
  onSelect,
  onViewportChange,
  onFocusOrigin,
  onBack,
}: SoundMapCanvasProps) {
  const t = useTranslateSourceText();
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState(FALLBACK_SIZE);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [focusVisible, setFocusVisible] = useState(false);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [pan, setPan] = useState<{ dx: number; dy: number } | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  useLayoutEffect(() => {
    const element = svgRef.current;
    if (!element) return undefined;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      setSize(previous => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const viewSize = 2 / viewport.zoom;
  // While the mouse drags the map, the view follows it locally; the URL is written on release.
  const unitsPerPixel = viewSize / Math.max(1, Math.min(size.width, size.height));
  const centerX = viewport.centerX - (pan?.dx ?? 0) * unitsPerPixel;
  const centerY = viewport.centerY - (pan?.dy ?? 0) * unitsPerPixel;
  const viewX = centerX - viewSize / 2;
  const viewY = centerY - viewSize / 2;

  const projection = useMemo<Projection>(() => {
    // preserveAspectRatio="xMidYMid meet": the square view fits the shorter side, centered.
    const scale = Math.min(size.width, size.height) / viewSize;
    const offsetX = (size.width - viewSize * scale) / 2;
    const offsetY = (size.height - viewSize * scale) / 2;
    return {
      unit: 1 / scale,
      toScreen: (x, y) => ({ x: offsetX + (x - viewX) * scale, y: offsetY + (y - viewY) * scale }),
    };
  }, [size.height, size.width, viewSize, viewX, viewY]);

  const originNumbers = useMemo(() => new Map(
    originIds && originIds.size > 1 ? [...originIds].map((id, index) => [id, index + 1] as const) : [],
  ), [originIds]);
  const orderedItems = useMemo(() => originNumbers.size > 0
    ? [...items.filter(p => !originNumbers.has(p.songId)), ...[...originNumbers.keys()].flatMap(id => items.filter(p => p.songId === id))]
    : items, [items, originNumbers]);
  const originOffsets = useMemo(() => layoutSoundMapOrigins(
    [...originNumbers.keys()].flatMap(id => {
      const point = items.find(p => p.songId === id);
      return point ? [{ songId: id, ...projection.toScreen(point.x, point.y) }] : [];
    }), size.width, size.height,
  ), [items, originNumbers, projection, size.width, size.height]);
  const displayPosition = (point: SoundMapPoint) => {
    const offset = originOffsets.get(point.songId);
    return { x: point.x + (offset?.dx ?? 0) * projection.unit, y: point.y + (offset?.dy ?? 0) * projection.unit };
  };

  const activeId = items.some(point => point.songId === focusId)
    ? focusId
    : items.some(point => point.songId === selectedId) ? selectedId : items[0]?.songId ?? null;
  const hoverPoint = hoverId === null ? null : items.find(point => point.songId === hoverId) ?? null;

  const nearestPoint = (clientX: number, clientY: number): SoundMapPoint | null => {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    let nearest: SoundMapPoint | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const point of items) {
      const position = displayPosition(point);
      const screen = projection.toScreen(position.x, position.y);
      const distance = Math.hypot(screen.x - (clientX - bounds.left), screen.y - (clientY - bounds.top));
      if (distance < nearestDistance || (Math.abs(distance - nearestDistance) < .001
        && originNumbers.has(point.songId) && (!nearest || !originNumbers.has(nearest.songId)))) {
        nearest = point;
        nearestDistance = distance;
      }
    }
    return nearestDistance <= HIT_RADIUS_PX ? nearest : null;
  };

  const onSvgClick = (event: MouseEvent<SVGSVGElement>) => {
    if (suppressClickRef.current) {
      // The press was a drag.
      suppressClickRef.current = false;
      return;
    }
    const point = nearestPoint(event.clientX, event.clientY);
    if (point) onSelect(point);
  };

  const onSvgPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    suppressClickRef.current = false;
    if ((!allowTouchPan && event.pointerType !== 'mouse') || event.button !== 0) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  };

  const onSvgPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!allowTouchPan && event.pointerType !== 'mouse') return;
    const drag = dragRef.current;
    if (drag && drag.pointerId === event.pointerId) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        if (!drag.moved) {
          drag.moved = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setHoverId(null);
        }
        setPan({ dx, dy });
        return;
      }
    }
    const next = nearestPoint(event.clientX, event.clientY)?.songId ?? null;
    if (next !== hoverId) setHoverId(next);
  };

  const endDrag = (event: PointerEvent<SVGSVGElement>, commit: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    suppressClickRef.current = commit;
    setPan(null);
    if (commit) onViewportChange({ zoom: viewport.zoom, centerX, centerY });
  };

  const focusPoint = (songId: number) => {
    setFocusId(songId);
    svgRef.current?.querySelector<SVGGElement>(`[data-song-id="${songId}"]`)?.focus();
  };

  const onPointKeyDown = (event: KeyboardEvent<SVGGElement>, point: SoundMapPoint) => {
    if (event.key === 'Enter' || event.key === ' ') {
      // Space would also scroll the page and toggle playback.
      event.preventDefault();
      event.stopPropagation();
      onSelect(point);
      return;
    }
    const direction = arrowKeyDirection(event.key);
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const next = nearestInDirection(items.map(item => ({ id: item.songId, ...displayPosition(item) })), point.songId, direction);
    if (next) focusPoint(next.id);
  };

  const onPointFocus = (event: FocusEvent<SVGGElement>, point: SoundMapPoint) => {
    setFocusId(point.songId);
    setFocusVisible(isFocusVisible(event.currentTarget));
  };

  const zoomBy = (delta: number) => onViewportChange({ ...viewport, zoom: maxZoom === 5
    ? clampSoundMapZoom(viewport.zoom + delta)
    : Math.max(.75, Math.min(maxZoom, viewport.zoom * (delta > 0 ? 1.6 : 1 / 1.6))) });
  const hoverScreen = hoverPoint ? projection.toScreen(displayPosition(hoverPoint).x, displayPosition(hoverPoint).y) : null;
  const unit = projection.unit;

  return (
    <section
      data-testid="sound-map-canvas"
      aria-busy={loading || undefined}
      className="relative h-[clamp(420px,calc(100vh-240px),640px)] overflow-hidden rounded-card max-sm:-mx-3 max-sm:h-[56vh] max-sm:rounded-none"
      style={{ backgroundColor: SOUND_MAP_COLORS.surface }}
    >
      <svg
        ref={svgRef}
        style={allowTouchPan ? { touchAction: 'none' } : undefined}
        className={cx(
          'block h-full w-full select-none transition-opacity duration-150',
          pan ? 'cursor-grabbing' : hoverId !== null ? 'cursor-pointer' : 'cursor-grab',
          loading && 'opacity-60',
        )}
        viewBox={`${viewX} ${viewY} ${viewSize} ${viewSize}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={t('曲調マップ')}
        onClick={onSvgClick}
        onPointerDown={onSvgPointerDown}
        onPointerMove={onSvgPointerMove}
        onPointerUp={event => endDrag(event, true)}
        onPointerCancel={event => endDrag(event, false)}
        onPointerLeave={() => setHoverId(null)}
      >
        <g pointerEvents="none">
          {[...originNumbers.keys()].map(id => {
            const point = items.find(p => p.songId === id);
            const offset = originOffsets.get(id);
            if (!point || !offset || (Math.abs(offset.dx) < .5 && Math.abs(offset.dy) < .5)) return null;
            const position = displayPosition(point);
            return <g key={id}>
              <line x1={point.x} y1={point.y} x2={position.x} y2={position.y} stroke={SOUND_MAP_COLORS.origin} strokeWidth={unit} opacity={.55} />
              <circle cx={point.x} cy={point.y} r={2 * unit} fill={SOUND_MAP_COLORS.origin} />
            </g>;
          })}
        </g>
        {orderedItems.map(point => {
          const origin = originIds?.has(point.songId) ?? point.songId === originId;
          const originNumber = originNumbers.get(point.songId);
          const position = displayPosition(point);
          const selected = point.songId === selectedId;
          const known = knownIds.has(point.songId);
          const focused = focusVisible && point.songId === focusId;
          const hovered = point.songId === hoverId;
          return (
            <g
              key={point.songId}
              data-song-id={point.songId}
              data-known={known ? 'true' : 'false'}
              data-origin={origin ? 'true' : undefined}
              transform={`translate(${position.x} ${position.y})`}
              role="button"
              aria-label={soundMapItemLabel(point)}
              aria-current={selected ? 'true' : undefined}
              tabIndex={point.songId === activeId ? 0 : -1}
              className="cursor-pointer outline-none focus-visible:outline-none"
              onKeyDown={event => onPointKeyDown(event, point)}
              onFocus={event => onPointFocus(event, point)}
              onBlur={() => setFocusVisible(false)}
              onClick={originNumber ? event => {
                event.stopPropagation();
                if (suppressClickRef.current) { suppressClickRef.current = false; return; }
                onSelect(point);
              } : undefined}
            >
              <g transform={`scale(${unit})`}>
                {focused && <circle r={14} fill="none" stroke={SOUND_MAP_COLORS.focus} strokeWidth={2} />}
                {selected && <circle r={originNumber ? 16 : origin ? 13 : 10} fill="none" stroke={SOUND_MAP_COLORS.selected} strokeWidth={2.5} />}
                {originNumber ? <>
                  <circle r={12} fill={SOUND_MAP_COLORS.origin} stroke={SOUND_MAP_COLORS.surface} strokeWidth={2} />
                  <text textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700} fill={SOUND_MAP_COLORS.surface} pointerEvents="none">{originNumber}</text>
                </> : origin ? (
                  <path d="M0,-9 L9,0 L0,9 L-9,0 Z" fill={SOUND_MAP_COLORS.origin} stroke={SOUND_MAP_COLORS.surface} strokeWidth={2} />
                ) : known ? (
                  <circle r={hovered ? 6.5 : 5} fill={SOUND_MAP_COLORS.known} stroke={SOUND_MAP_COLORS.surface} strokeWidth={2} />
                ) : (
                  <circle r={hovered ? 6 : 4.5} fill={SOUND_MAP_COLORS.surface} stroke={SOUND_MAP_COLORS.unknown} strokeWidth={1.5} />
                )}
              </g>
            </g>
          );
        })}
      </svg>

      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%-24px)] flex-wrap items-center gap-x-3 gap-y-1 rounded-chip bg-yt-menu/95 px-3 py-1.5 text-xs leading-4 text-yt-text-secondary">
        <span className="flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><path d="M0,-5.5 L5.5,0 L0,5.5 L-5.5,0 Z" fill={SOUND_MAP_COLORS.origin} /></svg>
          {t('起点')}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><circle r="4.5" fill={SOUND_MAP_COLORS.known} /></svg>
          {t('知っている')}
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden="true"><circle r="4" fill="none" stroke={SOUND_MAP_COLORS.unknown} strokeWidth="1.5" /></svg>
          {t('まだ知らない')}
        </span>
      </div>

      {axes && (
        <>
          <span
            data-testid="sound-map-axis-y"
            data-feature-index={axes.y}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 rounded-badge bg-yt-menu/95 px-2 py-0.5 text-xs leading-5 text-yt-text"
          >
            ↑ {t('Y · 特徴{n}', { n: axes.y + 1 })}
          </span>
          <span
            data-testid="sound-map-axis-x"
            data-feature-index={axes.x}
            className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-badge bg-yt-menu/95 px-2 py-0.5 text-xs leading-5 text-yt-text"
          >
            {t('X · 特徴{n}', { n: axes.x + 1 })} →
          </span>
        </>
      )}

      {hoverPoint && hoverScreen && (
        <div
          aria-hidden="true"
          className={cx(
            'pointer-events-none absolute z-[1] w-max max-w-[240px] -translate-x-1/2 rounded-badge bg-[rgba(97,97,97,0.92)] px-2 py-1.5 text-xs leading-4 text-white',
            hoverScreen.y >= 64 && '-translate-y-full',
          )}
          style={{
            left: Math.min(Math.max(hoverScreen.x, 120), size.width - 120),
            top: hoverScreen.y >= 64 ? hoverScreen.y - 12 : hoverScreen.y + 12,
          }}
        >
          <span className="block truncate font-medium">{hoverPoint.name}</span>
          {hoverPoint.artistString && <span className="block truncate text-white/80">{hoverPoint.artistString}</span>}
        </div>
      )}

      {guide}

      <div className="absolute bottom-3 right-3 flex flex-col gap-2">
        <IconButton
          label={t('拡大')}
          icon={<AddIcon />}
          variant="overlay"
          tooltipPlacement="left"
          className="max-sm:size-11!"
          disabled={viewport.zoom >= maxZoom}
          onClick={() => zoomBy(ZOOM_STEP)}
        />
        <IconButton
          label={t('縮小')}
          icon={<RemoveIcon />}
          variant="overlay"
          tooltipPlacement="left"
          className="max-sm:size-11!"
          disabled={viewport.zoom <= 0.75}
          onClick={() => zoomBy(-ZOOM_STEP)}
        />
        <IconButton
          label={t('起点へ移動')}
          icon={<MyLocationIcon />}
          variant="overlay"
          tooltipPlacement="left"
          className="max-sm:size-11!"
          onClick={onFocusOrigin}
        />
        <IconButton
          label={t('前の起点に戻る')}
          icon={<UndoIcon />}
          variant="overlay"
          tooltipPlacement="left"
          className="max-sm:size-11!"
          disabled={!canGoBack}
          onClick={onBack}
        />
      </div>

      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-yt-text">
          <SpinnerIcon size={32} />
          <span className="sr-only">{t('読み込み中…')}</span>
        </div>
      )}
      {items.length === 0 && !loading && (
        <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-yt-text-secondary">
          {t('表示できる曲がありません')}
        </div>
      )}
    </section>
  );
}
