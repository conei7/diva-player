import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router';
import type { KnowledgeMapAtlasData, KnowledgeMapPlatform } from '../../api/knowledgeMap';
import { useTranslateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { KnowledgeAtlasIndex } from '../../utils/knowledgeAtlas';
import type { AtlasRect } from '../../utils/knowledgeAtlas';
import { watchPath } from '../../utils/routes';
import { formatViewCount } from '../../utils/songMeta';
import { arrowKeyDirection, nearestInDirection } from '../../utils/soundMap';
import Button from '../ui/Button';
import SongThumbnail from '../ui/SongThumbnail';
import { useSongsById } from './discoverySongs';
import { KNOWLEDGE_MAP_COLORS, KNOWN_SERVICE_COLOR } from './mapColors';
import type { KnowledgeViewMode } from './KnowledgeTreemap';
import { isFocusVisible } from './focusVisible';

interface Props { data: KnowledgeMapAtlasData; platform: KnowledgeMapPlatform; knownIds: ReadonlySet<number>; viewMode: KnowledgeViewMode }
interface Target { rect: AtlasRect; x: number; y: number; touch: boolean }
const MAX_ZOOM = 4096;
export default function KnowledgeAtlas({ data, platform, knownIds, viewMode }: Props) {
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const navigate = useNavigate();
  const index = useMemo(() => new KnowledgeAtlasIndex(data.songs, knownIds, viewMode), [data.songs, knownIds, viewMode]);
  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [zoom, setZoom] = useState(1);
  const [target, setTarget] = useState<Target | null>(null);
  const pointer = useRef({ type: 'mouse', x: 0, y: 0, left: 0, top: 0 });
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollFrame = useRef<number | undefined>(undefined);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const measure = () => setSize(previous => previous.width === element.clientWidth && previous.height === element.clientHeight
      ? previous : { width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(hoverTimer.current); cancelAnimationFrame(scrollFrame.current ?? 0); };
  }, []);
  const baseWidth = Math.min(4096, Math.max(2048, size.width * 3));
  const baseHeight = Math.min(3072, Math.max(1536, size.height * 3));
  const width = baseWidth * zoom, height = baseHeight * zoom, aspect = baseWidth / baseHeight;
  const rects = useMemo(() => index.visible({
    x: Math.max(0, scroll.left - 64) / width, y: Math.max(0, scroll.top - 64) / height,
    width: (size.width + 128) / width, height: (size.height + 128) / height,
  }, width, height, aspect), [index, scroll, width, height, size, aspect]);
  const firstLeaf = rects.find(rect => rect.index >= 0)?.index;
  const ids = useMemo(() => [...new Set([
    ...rects.filter(rect => rect.index >= 0 && rect.width * width >= 24 && rect.height * height >= 20).map(rect => index.ids[rect.index]),
    ...(target ? [index.ids[target.rect.index]] : []),
  ])], [rects, index, target, width, height]);
  const songs = useSongsById(ids);
  const clearHover = () => { clearTimeout(hoverTimer.current); setTarget(previous => previous?.touch ? previous : null); };
  const hit = (clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const bounds = viewport.getBoundingClientRect();
    return index.hit((clientX - bounds.left + viewport.scrollLeft) / width, (clientY - bounds.top + viewport.scrollTop) / height, aspect);
  };
  const changeZoom = (next: number, reset = false) => {
    const value = Math.max(1, Math.min(MAX_ZOOM, next));
    const viewport = viewportRef.current;
    if (!viewport) return;
    clearHover();
    pendingScroll.current = reset ? { left: 0, top: 0 } : { left: viewport.scrollLeft * value / zoom, top: viewport.scrollTop * value / zoom };
    if (value === zoom) viewport.scrollTo(pendingScroll.current.left, pendingScroll.current.top);
    setZoom(value);
  };
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && pendingScroll.current) {
      viewport.scrollTo(pendingScroll.current.left, pendingScroll.current.top);
      setScroll({ left: viewport.scrollLeft, top: viewport.scrollTop });
      pendingScroll.current = null;
    }
  }, [zoom]);
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(hoverTimer.current);
    const rect = hit(event.clientX, event.clientY);
    const x = event.clientX, y = event.clientY;
    if (!rect) { setTarget(null); return; }
    hoverTimer.current = setTimeout(() => setTarget({ rect, x, y, touch: false }), 200);
  };
  const selectedId = target ? index.ids[target.rect.index] : null;
  const selectedSong = selectedId ? songs.get(selectedId) : null;
  const selectedName = selectedSong?.name ?? t('読み込み中…');
  return <div data-testid={`${platform}-knowledge-treemap`} data-atlas-song-count={index.length}>
    <div className="mb-2 flex items-center justify-end gap-1">
      <Button size="sm" variant="ghost" aria-label={t('縮小')} disabled={zoom <= 1} onClick={() => changeZoom(zoom / 2)}>−</Button>
      <Button size="sm" variant="ghost" aria-label={t('リセット')} onClick={() => changeZoom(1, true)}><span className="tabular-nums">{(zoom * 100).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US')}%</span></Button>
      <Button size="sm" variant="ghost" aria-label={t('拡大')} disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom * 2)}>＋</Button>
    </div>
    <div ref={frameRef} className="relative h-[clamp(360px,60vh,560px)] overflow-hidden rounded-card bg-yt-bg max-sm:-mx-3 max-sm:h-80 max-sm:rounded-none">
      <div ref={viewportRef} data-testid="knowledge-map-viewport" tabIndex={0} role="group" aria-label={t('知ってる度')}
        className="absolute inset-0 overflow-auto overscroll-contain"
        onScroll={event => {
          clearHover();
          const element = event.currentTarget;
          if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
          scrollFrame.current = requestAnimationFrame(() => setScroll({ left: element.scrollLeft, top: element.scrollTop }));
        }}
        onPointerMove={onPointerMove} onPointerLeave={clearHover}
        onPointerDown={event => { const viewport = event.currentTarget; pointer.current = { type: event.pointerType, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }; }}
        onPointerUp={event => {
          const previous = pointer.current;
          if (previous.type === 'mouse' || Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > 8
            || event.currentTarget.scrollLeft !== previous.left || event.currentTarget.scrollTop !== previous.top) return;
          const rect = hit(event.clientX, event.clientY);
          if (rect) setTarget({ rect, x: event.clientX, y: event.clientY, touch: true });
        }}
        onClick={event => {
          if (pointer.current.type !== 'mouse' || (event.target as HTMLElement).closest('a')) return;
          const rect = hit(event.clientX, event.clientY);
          if (rect) navigate(watchPath(index.ids[rect.index], { autoplay: false }));
        }}
        onKeyDown={event => {
          const direction = arrowKeyDirection(event.key);
          const current = (event.target as HTMLElement).closest<HTMLElement>('[data-tile-id]')?.dataset.tileId;
          if (!direction || !current) return;
          event.preventDefault(); event.stopPropagation();
          const next = nearestInDirection(rects.filter(rect => rect.index >= 0).map(rect => ({ id: `song-${index.ids[rect.index]}`, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })), current, direction);
          if (next) viewportRef.current?.querySelector<HTMLElement>(`[data-tile-id="${next.id}"]`)?.focus();
        }}>
        <div data-testid="knowledge-map-surface" className="relative" style={{ width, height }}>
          {rects.map((rect, order) => {
            const w = rect.width * width, h = rect.height * height;
            const style = { left: rect.x * width, top: rect.y * height, width: Math.max(0, w - (w > 3 ? 1 : 0)), height: Math.max(0, h - (h > 3 ? 1 : 0)),
              backgroundColor: rect.knownRatio === 1 ? KNOWN_SERVICE_COLOR[platform] : rect.knownRatio === 0 ? KNOWLEDGE_MAP_COLORS.remainder : `color-mix(in srgb, ${KNOWN_SERVICE_COLOR[platform]} ${rect.knownRatio * 100}%, ${KNOWLEDGE_MAP_COLORS.remainder})` };
            if (rect.index < 0) return <span key={`paint-${order}`} aria-hidden="true" className="absolute" style={style} />;
            const id = index.ids[rect.index], song = songs.get(id), name = song?.name;
            return <Link key={id} to={watchPath(id, { autoplay: false })} data-tile-id={`song-${id}`} data-views={index.views[rect.index]}
              aria-label={name ?? String(id)} tabIndex={rect.index === firstLeaf ? 0 : -1}
              className={`absolute flex items-end overflow-hidden rounded-badge text-xs font-bold leading-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-yt-focus ${rect.knownRatio === 1 ? 'text-white' : 'text-yt-text'}`}
              style={{ ...style, padding: w >= 24 && h >= 20 ? '4px' : 0 }}
              onClick={event => { if (pointer.current.type !== 'mouse' && event.detail !== 0) event.preventDefault(); }}
              onFocus={event => { if (!isFocusVisible(event.currentTarget)) return; const bounds = event.currentTarget.getBoundingClientRect(); setTarget({ rect, x: bounds.left, y: bounds.bottom, touch: false }); }} onBlur={clearHover}>
              {w >= 24 && h >= 20 && name && <span className="sticky bottom-0 left-0 overflow-hidden break-words [overflow-wrap:anywhere]" style={{ maxWidth: Math.max(20, size.width - 16), display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: Math.max(1, Math.floor((h - 8) / 16)) }}>{name}</span>}
            </Link>;
          })}
        </div>
      </div>
    </div>
    <p className="m-0 mt-1.5 text-right text-xs leading-4 text-yt-text-secondary">{t('面積＝再生数')} · {index.length.toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US')}{t('曲')}</p>
    {target && selectedId && target.touch && <div data-testid="knowledge-atlas-touch-card" className="mt-3 flex items-center gap-3 rounded-card bg-yt-raised p-2" aria-live="polite">
      {selectedSong && <SongThumbnail song={selectedSong} className="w-24" radius="sm" showDuration={false} />}
      <div className="min-w-0 flex-1"><p className="m-0 truncate text-sm">{selectedName}</p><p className="m-0 text-xs text-yt-text-secondary">{formatViewCount(index.views[target.rect.index], language)}</p></div>
      <Button size="sm" onClick={() => navigate(watchPath(selectedId, { autoplay: false }))}>{t('開く')}</Button>
    </div>}
    {target && !target.touch && createPortal(<div role="tooltip" data-testid="knowledge-map-tooltip" className="pointer-events-none fixed z-[95] w-60 overflow-hidden rounded-card bg-yt-menu shadow-lg"
      style={{ left: Math.max(8, Math.min(target.x + 12, window.innerWidth - 248)), top: Math.max(8, Math.min(target.y + 16, window.innerHeight - 260)) }}>
      {selectedSong && <SongThumbnail song={selectedSong} className="w-full" radius="none" showDuration={false} />}
      <div className="px-3 py-2.5"><p className="m-0 text-sm font-medium">{selectedName}</p><p className="m-0 text-xs text-yt-text-secondary">{selectedSong?.artistString}</p><p className="m-0 mt-1 text-xs text-yt-text-secondary">{formatViewCount(index.views[target.rect.index], language)} · {t(knownIds.has(selectedId!) ? '知っている' : 'まだ知らない')}</p></div>
    </div>, document.body)}
  </div>;
}
