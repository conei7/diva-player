import { useEffect, useState } from 'react';
import {
  exhibitionDay,
  nextExhibitionBoundary,
  type ExhibitionDay,
} from './exhibition';
import { EXHIBITION_TAB_KEY } from './exhibitionMode';
import { loadExhibitionCounts, registerExhibitionVisit, type ExhibitionDailyCount } from './exhibitionVisits';
import logo from './sofume-logo.png';
import bookmarkQr from './bookmark-qr.png?no-inline';

const PUBLIC_URL = 'https://diva-player.pages.dev/';

const PANEL_CLASS = 'mx-3 my-3 rounded-2xl border border-yt-border bg-yt-bg-secondary px-3.5 py-3 sm:mx-6 sm:px-5';

function ExhibitionStats() {
  const [counts, setCounts] = useState<ExhibitionDailyCount[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadExhibitionCounts(controller.signal).then(setCounts, () => {
      if (!controller.signal.aborted) setLoadFailed(true);
    });
    return () => controller.abort();
  }, []);

  return (
    <section aria-label="展示の来場集計" className={PANEL_CLASS}>
      <h2 className="font-semibold">展示の来場集計</h2>
      {counts ? (
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm tabular-nums">
          {counts.map(({ day, count }) => (
            <div key={day}>
              <dt className="text-yt-text-secondary">{day.slice(5).replace('-', '/')}</dt>
              <dd>{count}回</dd>
            </div>
          ))}
          <div>
            <dt className="text-yt-text-secondary">合計</dt>
            <dd>{counts.reduce((sum, entry) => sum + entry.count, 0)}回</dd>
          </div>
        </dl>
      ) : <p role="status" className="mt-2 text-sm">{loadFailed ? '集計を読み込めませんでした。' : '集計を読み込み中…'}</p>}
      <p className="mt-2 text-xs text-yt-text-secondary">展示画面を開いた回数です。来場人数の目安として使えます。</p>
    </section>
  );
}

function ExhibitionBooth({ day }: { day: ExhibitionDay }) {
  const [visitor, setVisitor] = useState<number | null>(null);

  useEffect(() => {
    let mounted = true;
    void registerExhibitionVisit(day).then(ordinal => { if (mounted) setVisitor(ordinal); });
    return () => { mounted = false; };
  }, [day]);

  return (
    <section aria-label="ソフトメディア研究会の展示" className={PANEL_CLASS}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 sm:gap-x-6">
        <h2 className="col-span-2 sm:col-span-1">
          <img src={logo} alt="SOFTMEDIA ソフトメディア研究会" width="1920" height="1080"
            className="aspect-[5/1] w-full max-w-xs rounded-lg bg-zinc-950 object-cover" />
        </h2>
        <div className="row-start-2 min-w-0 self-start">
          <p aria-live="polite" className="text-sm tabular-nums text-yt-text-secondary">
            {visitor === null ? '曲を選んで聴いてみよう' : <>あなたは今日の <strong className="text-yt-text">{visitor}人目</strong>！</>}
          </p>
        </div>
        <a href={PUBLIC_URL} target="_blank" rel="noopener" className="col-start-2 row-start-2 flex shrink-0 items-center gap-3 max-sm:flex-col max-sm:gap-1.5 sm:row-span-2 sm:row-start-1">
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
