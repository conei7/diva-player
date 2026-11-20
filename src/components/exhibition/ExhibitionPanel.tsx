import { useCallback, useEffect, useRef, useState } from 'react';
import {
  EXHIBITION_COUNTS_KEY,
  EXHIBITION_DAYS,
  EXHIBITION_QUERY,
  EXHIBITION_TAB_KEY,
  exhibitionDay,
  isNewExhibitionVisit,
  nextExhibitionBoundary,
  parseExhibitionCounts,
  readExhibitionCounts,
  type ExhibitionCounts,
  type ExhibitionDay,
} from './exhibition';
import logo from './sofume-logo.png';
import bookmarkQr from './bookmark-qr.png?no-inline';

const PUBLIC_URL = 'https://diva-player.pages.dev/';
const STATS_URL = `${import.meta.env.BASE_URL}?${EXHIBITION_QUERY}=stats`;

const PANEL_CLASS = 'mx-3 my-3 rounded-2xl border border-yt-border bg-yt-bg-secondary px-3.5 py-3 sm:mx-6 sm:px-5';

function ExhibitionStats() {
  const [counts, setCounts] = useState(readExhibitionCounts);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === EXHIBITION_COUNTS_KEY || event.key === null) {
        setCounts(readExhibitionCounts());
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  return (
    <section aria-label="展示の来場集計" className={PANEL_CLASS}>
      <h2 className="font-semibold">展示の来場集計</h2>
      {counts ? (
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm tabular-nums">
          {EXHIBITION_DAYS.map(day => (
            <div key={day}>
              <dt className="text-yt-text-secondary">{day.slice(5).replace('-', '/')}</dt>
              <dd>{counts[day]}人</dd>
            </div>
          ))}
          <div>
            <dt className="text-yt-text-secondary">合計</dt>
            <dd>{EXHIBITION_DAYS.reduce((sum, day) => sum + counts[day], 0)}人</dd>
          </div>
        </dl>
      ) : <p className="mt-2 text-sm">このブラウザーの集計を読み込めません。</p>}
      <p className="mt-2 text-xs text-yt-text-secondary">この展示端末で記録した概算です。</p>
    </section>
  );
}

function ExhibitionBooth({ day }: { day: ExhibitionDay }) {
  const panelRef = useRef<HTMLElement>(null);
  const lastActivity = useRef<number | null>(null);
  const unsavedCounts = useRef<ExhibitionCounts | null>(null);
  const [visitor, setVisitor] = useState<number | null>(null);
  const [storageFailed, setStorageFailed] = useState(false);

  const recordVisit = useCallback((now: number) => {
    if (exhibitionDay(now) !== day) return;
    const counts = unsavedCounts.current ?? readExhibitionCounts() ?? parseExhibitionCounts(null);
    const updated = { ...counts, [day]: counts[day] + 1 };
    lastActivity.current = now;
    setVisitor(updated[day]);
    try {
      window.localStorage.setItem(EXHIBITION_COUNTS_KEY, JSON.stringify(updated));
      unsavedCounts.current = null;
      setStorageFailed(false);
    } catch {
      unsavedCounts.current = updated;
      setStorageFailed(true);
    }
  }, [day]);

  useEffect(() => {
    const recordInteraction = (event: MouseEvent) => {
      const target = event.target;
      if (!event.isTrusted || !(target instanceof Element) || panelRef.current?.contains(target)) return;
      if (!target.closest('a, button, input, select, textarea, [role="button"]')) return;
      const now = Date.now();
      if (exhibitionDay(now) !== day) return;
      if (isNewExhibitionVisit(now, lastActivity.current)) recordVisit(now);
      else lastActivity.current = now;
    };
    document.addEventListener('click', recordInteraction, true);
    return () => document.removeEventListener('click', recordInteraction, true);
  }, [day, recordVisit]);

  return (
    <section ref={panelRef} aria-label="ソフトメディア研究会の展示" className={PANEL_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-32">
          <div className="flex items-center gap-1.5">
            <img src={logo} alt="" width="40" height="40" className="size-10 shrink-0" />
            <h2 className="text-sm font-semibold sm:text-base">ソフトメディア研究会</h2>
          </div>
          <p aria-live="polite" className="mt-1 text-sm tabular-nums text-yt-text-secondary">
            {visitor === null ? '曲を選んで聴いてみよう' : <>あなたは今日の <strong className="text-yt-text">{visitor}人目</strong>！</>}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-xs text-yt-text-secondary">
            <button type="button" className="min-h-8 underline underline-offset-2 hover:text-yt-text" onClick={() => recordVisit(Date.now())}>来場者を1人追加</button>
            <a href={STATS_URL} target="_blank" rel="noopener" className="inline-flex min-h-8 items-center underline underline-offset-2 hover:text-yt-text">集計</a>
          </div>
          {storageFailed && <p role="status" className="text-xs text-yt-text-secondary">このブラウザーでは集計を保存できません。</p>}
        </div>
        <a href={PUBLIC_URL} target="_blank" rel="noopener" className="flex shrink-0 items-center gap-3 max-sm:flex-col max-sm:gap-1.5">
          <div className="text-xs font-medium sm:text-sm">スマホでブックマーク</div>
          <img src={bookmarkQr} alt="DIVA Playerの公開URLのQRコード" width="112" height="112" className="size-28 rounded-lg bg-white" />
        </a>
      </div>
    </section>
  );
}

export default function ExhibitionPanel({ mode }: { mode: 'booth' | 'stats' }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (mode !== 'booth') return;
    try {
      window.sessionStorage.setItem(EXHIBITION_TAB_KEY, '1');
    } catch {
      // The current exhibition URL still works if browser storage is unavailable.
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== 'booth') return;
    const boundary = nextExhibitionBoundary(now);
    if (boundary === undefined) return;
    const refresh = () => setNow(Date.now());
    const timer = window.setTimeout(refresh, Math.max(0, Math.min(boundary - Date.now(), 86_400_000)));
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [mode, now]);

  if (mode === 'stats') return <ExhibitionStats />;
  const day = exhibitionDay(now);
  return day && <ExhibitionBooth key={day} day={day} />;
}
