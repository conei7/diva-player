import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslateSourceText } from '../i18n';
import ChartPlayer, { type ChartJump } from '../components/musicAnalysis/ChartPlayer';
import ChartSearch from '../components/musicAnalysis/ChartSearch';
import Button from '../components/ui/Button';
import { youtubeVideoId, type Chart } from '../musicAnalysis/chart';
import { MAX_CHART_BYTES, parseChartFile, serializeChartFile } from '../musicAnalysis/chartFile';
import { analyzeFile, deleteChart, DEMO_CHART, loadCharts, MAX_FILE_BYTES, saveChart } from '../musicAnalysis/localAudio';

const INPUT = 'block w-full min-w-0 rounded-row border border-yt-outline bg-yt-bg px-3 py-2 text-sm text-yt-text';

export default function MusicAnalysisPage() {
  const [params] = useSearchParams();
  const seedTitle = params.get('title')?.slice(0, 160) ?? '';
  const seedVideo = youtubeVideoId(params.get('video') ?? '') ?? '';
  return <MusicAnalysis key={JSON.stringify([seedVideo, seedTitle])} seedTitle={seedTitle} seedVideo={seedVideo} />;
}

function MusicAnalysis({ seedTitle, seedVideo }: { seedTitle: string; seedVideo: string }) {
  const t = useTranslateSourceText();
  const [charts, setCharts] = useState<Chart[]>([]);
  const [current, setCurrent] = useState<{ chart: Chart; jump: ChartJump }>({ chart: DEMO_CHART, jump: { start: 0 } });
  const [source, setSource] = useState<{ id: string; file: File } | null>(null);
  const [importOpen, setImportOpen] = useState(Boolean(seedVideo || seedTitle));
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState('');
  const analysisRequest = useRef<AbortController | null>(null);
  const playerSection = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    loadCharts().then(saved => {
      if (disposed) return;
      setCharts(saved);
      const match = seedVideo && saved.find(chart => chart.videoId === seedVideo);
      if (match) {
        setCurrent(previous => previous.chart.id === 'demo' ? { chart: match, jump: { start: 0 } } : previous);
        setImportOpen(false);
      }
    }).catch(() => {
      if (!disposed) setError('保存済みのコード譜を読み込めませんでした。');
    }).finally(() => {
      if (!disposed) setHydrated(true);
    });
    return () => {
      disposed = true;
      analysisRequest.current?.abort();
    };
  }, [seedVideo]);

  function selectChart(chart: Chart, start: number) {
    setCurrent({ chart, jump: { start } });
    if (playerSection.current && window.matchMedia('(max-width: 1023px)').matches) {
      playerSection.current.scrollIntoView({ block: 'start' });
    }
  }

  async function importChart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (analysisRequest.current || !hydrated) return;
    const form = new FormData(event.currentTarget);
    const file = form.get('audio');
    const title = String(form.get('title') ?? '').trim();
    const artist = String(form.get('artist') ?? '').trim();
    const url = String(form.get('video') ?? '').trim();
    const videoId = youtubeVideoId(url);
    const offsetText = String(form.get('offset') ?? '');
    const endOffsetText = String(form.get('endOffset') ?? '');
    if (url && !videoId) {
      setError('有効なYouTube動画のURLを入力してください。');
      return;
    }
    if (!(file instanceof File) || !file.size) {
      setError('音源またはDIVAコード譜を選んでください。');
      return;
    }
    const isChart = file.name.toLowerCase().endsWith('.json') || file.type === 'application/json';
    if (file.size > (isChart ? MAX_CHART_BYTES : MAX_FILE_BYTES)) {
      setError(isChart ? '2 MB以下のDIVAコード譜を選んでください。' : '40 MB以下の音源ファイルを選んでください。');
      return;
    }
    const controller = new AbortController();
    analysisRequest.current = controller;
    setBusy(true);
    setError('');
    let saving = false;
    try {
      const prepared = isChart ? parseChartFile(JSON.parse(await file.text())) : null;
      const analysis = prepared ?? await analyzeFile(file, controller.signal);
      const linkedVideo = videoId ?? prepared?.videoId ?? null;
      const sameVideo = linkedVideo === prepared?.videoId;
      const offset = offsetText ? Number(offsetText) : (sameVideo ? prepared?.videoOffset ?? 0 : 0);
      const rate = endOffsetText ? 1 + (Number(endOffsetText) - offset) / analysis.duration
        : (sameVideo ? prepared?.videoRate ?? 1 : 1);
      if ((endOffsetText && (!linkedVideo || Math.abs(Number(endOffsetText)) > 60))
        || Math.abs(offset) > 60 || !Number.isFinite(offset) || !Number.isFinite(rate) || rate < 0.5 || rate > 2) {
        setError('動画と音源のずれを確認してください。');
        return;
      }
      const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
      const chart: Chart = {
        ...analysis,
        id,
        title: title || prepared?.title || file.name.replace(/\.[^.]+$/, '').slice(0, 160) || file.name.slice(0, 160),
        artist: artist || prepared?.artist || '',
        videoId: linkedVideo,
        videoOffset: linkedVideo ? offset : 0,
        videoRate: linkedVideo && rate !== 1 ? rate : undefined,
      };
      controller.signal.throwIfAborted();
      saving = true;
      await saveChart(chart);
      if (controller.signal.aborted) return;
      setCharts(previous => [...previous, chart]);
      setSource(isChart ? null : { id, file });
      setImportOpen(false);
      selectChart(chart, 0);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(isChart ? (saving ? 'コード譜を保存できませんでした。' : 'DIVAコード譜を読み込めませんでした。') : reason instanceof RangeError
        ? '2秒から8分までの音源を選んでください。'
        : '音源を解析または保存できませんでした。別の音源形式やブラウザーの空き容量を確認してください。');
    } finally {
      if (analysisRequest.current === controller) {
        analysisRequest.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  function exportCurrent() {
    const { chart } = current;
    const url = URL.createObjectURL(new Blob([serializeChartFile(chart)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${chart.title.replace(/[^\p{L}\p{N} ._-]/gu, '_') || 'chart'}.diva.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function removeCurrent() {
    const { chart } = current;
    if (chart.id === 'demo' || !window.confirm(t('このコード譜を削除しますか？'))) return;
    try {
      await deleteChart(chart.id);
      setCharts(previous => previous.filter(item => item.id !== chart.id));
      setCurrent(previous => previous.chart.id === chart.id ? { chart: DEMO_CHART, jump: { start: 0 } } : previous);
      setSource(previous => previous?.id === chart.id ? null : previous);
    } catch {
      setError('コード譜を削除できませんでした。');
    }
  }

  return (
    <main className="mx-auto w-full max-w-[1360px] px-3 pb-12 pt-5 text-yt-text sm:px-6 sm:pt-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4 sm:mb-7">
        <div>
          <h1 className="text-[clamp(1.5rem,3vw,2.125rem)] font-bold tracking-tight">{t('コード・メロディ')}</h1>
          <p className="mt-1 text-sm text-yt-text-secondary">{t('コードを再生位置に合わせて表示し、曲名・コード進行・メロディで探せます。')}</p>
        </div>
        <Button variant="primary" aria-expanded={importOpen} onClick={() => setImportOpen(open => !open)}>
          {importOpen ? t('追加を閉じる') : t('音源・コード譜を追加')}
        </Button>
      </div>
      {error && <p role="alert" className="mb-4 rounded-row border border-yt-outline px-3 py-2 text-sm">{t(error)}</p>}
      {importOpen && (
        <form onSubmit={importChart}
          className="mb-5 grid gap-3 rounded-panel border border-yt-outline bg-yt-tonal-solid p-4 sm:grid-cols-2 sm:p-5">
          <p className="text-sm text-yt-text-secondary sm:col-span-2">{t('使用できる音源や作成済みのDIVAコード譜を選べます。ファイルは端末で読み込み、譜面をこのブラウザーに保存します。')}</p>
          <label className="grid gap-1 text-sm sm:col-span-2">
            {t('音源（40 MB以下・2秒〜8分）またはDIVAコード譜（JSON、2 MB以下）')}
            <input className={INPUT} name="audio" type="file" required accept="audio/*,.flac,.m4a,.mp3,.wav,.ogg,.json,application/json" />
          </label>
          <label className="grid gap-1 text-sm">
            {t('曲名（任意）')}
            <input className={INPUT} name="title" defaultValue={seedTitle} maxLength={160} />
          </label>
          <label className="grid gap-1 text-sm">
            {t('アーティスト（任意）')}
            <input className={INPUT} name="artist" maxLength={160} />
          </label>
          <label className="grid gap-1 text-sm">
            {t('同じ版のYouTube動画（任意）')}
            <input className={INPUT} name="video" defaultValue={seedVideo} maxLength={250} placeholder="https://www.youtube.com/watch?v=…" />
          </label>
          <label className="grid gap-1 text-sm">
            {t('動画が音源より遅れて始まる秒数（任意）')}
            <input className={INPUT} name="offset" type="number" min="-60" max="60" step="0.01" placeholder="0" />
          </label>
          <label className="grid gap-1 text-sm sm:col-span-2">
            {t('音源の終点に対応する動画位置のずれ（秒、任意）')}
            <input className={INPUT} name="endOffset" type="number" min="-60" max="60" step="0.01" />
          </label>
          <div className="sm:col-span-2">
            <Button variant="primary" type="submit" loading={busy} disabled={!hydrated}>{t('読み込む')}</Button>
          </div>
        </form>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(300px,0.85fr)_minmax(0,1.4fr)]">
        <ChartSearch charts={[DEMO_CHART, ...charts]} selected={current.chart.id} onSelect={selectChart} />
        <div ref={playerSection} className="min-w-0 scroll-mt-[calc(var(--header-height,48px)+10px)]">
          <ChartPlayer key={current.chart.id} chart={current.chart} jump={current.jump}
            file={source?.id === current.chart.id ? source.file : undefined}
            onAttach={file => setSource({ id: current.chart.id, file })} />
          <div className="mt-2 flex flex-wrap justify-end gap-1">
            <Button variant="ghost" size="sm" onClick={exportCurrent}>{t('コード譜を書き出す')}</Button>
            {current.chart.id !== 'demo' && <Button size="sm" variant="ghost" onClick={() => void removeCurrent()}>{t('コード譜を削除')}</Button>}
          </div>
        </div>
      </div>
    </main>
  );
}
