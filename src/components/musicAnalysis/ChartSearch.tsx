import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslateSourceText } from '../../i18n';
import { CHART_QUALITIES, DEGREES, noteHz, noteName, searchCharts, type Chart, type Chord, type SearchPattern } from '../../musicAnalysis/chart';
import { formatClockDuration } from '../../utils/songMeta';
import { searchPath } from '../../utils/routes';
import Button from '../ui/Button';

const INPUT = 'min-w-0 w-full rounded-row border border-yt-outline bg-yt-bg px-3 py-2 text-sm text-yt-text placeholder:text-yt-text-secondary';
const WHITE = [60, 62, 64, 65, 67, 69, 71, 72];
const BLACK = [61, 63, 66, 68, 70];
const BLACK_STARTS = [1, 2, 4, 5, 6];
const POP: Chord[] = [{ root: 0, quality: '' }, { root: 7, quality: '' }, { root: 9, quality: 'm' }, { root: 5, quality: '' }];
const ROYAL: Chord[] = [{ root: 5, quality: '' }, { root: 7, quality: '' }, { root: 4, quality: 'm' }, { root: 9, quality: 'm' }];

export default function ChartSearch({ charts, selected, onSelect }: {
  charts: Chart[];
  selected: string;
  onSelect: (chart: Chart, start: number) => void;
}) {
  const t = useTranslateSourceText();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchPattern['kind']>('title');
  const [chords, setChords] = useState<Chord[]>([]);
  const [quality, setQuality] = useState<Chord['quality']>('');
  const [notes, setNotes] = useState<number[]>([]);
  const [octave, setOctave] = useState(0);
  const context = useRef<AudioContext | null>(null);
  useEffect(() => () => { void context.current?.close().catch(() => {}); context.current = null; }, []);

  function audition(pitches: number[], spacing: number) {
    try {
      const ctx = context.current ??= new AudioContext();
      void ctx.resume().catch(() => {});
      pitches.forEach((note, i) => {
        const start = ctx.currentTime + i * spacing;
        const oscillator = ctx.createOscillator();
        const envelope = ctx.createGain();
        oscillator.frequency.value = noteHz(note);
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(0.09, start + 0.02);
        envelope.gain.exponentialRampToValueAtTime(0.001, start + 0.26);
        oscillator.connect(envelope).connect(ctx.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.28);
      });
    } catch { /* Search still works when Web Audio is unavailable. */ }
  }

  function pianoKey(note: number, className: string, left?: number): ReactNode {
    const pitch = note + octave * 12;
    return (
      <button key={note} className={className} style={left === undefined ? undefined : { left: `${left}%` }}
        type="button" aria-label={noteName(pitch)} onClick={() => {
          audition([pitch], 0);
          setNotes(previous => previous.length < 16 ? [...previous, pitch] : previous);
        }}>
        {left === undefined && noteName(pitch)}
      </button>
    );
  }

  const enough = mode === 'title' || (mode === 'chords' ? chords.length >= 2 : notes.length >= 4);
  const results = useMemo(() => {
    if (!enough) return [];
    const pattern: SearchPattern = mode === 'chords' ? { kind: mode, chords }
      : mode === 'melody' ? { kind: mode, notes } : { kind: mode };
    return searchCharts(charts, query, pattern);
  }, [charts, query, mode, chords, notes, enough]);
  return (
    <section className="min-w-0 rounded-panel border border-yt-outline bg-yt-tonal-solid p-4 sm:p-5" aria-label={t('曲を探す')}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('探し方')}>
        {([
          ['title', t('曲名')],
          ['chords', t('コード進行')],
          ['melody', t('メロディ')],
        ] as const).map(([kind, label]) => (
          <Button key={kind} size="sm" variant={mode === kind ? 'primary' : 'ghost'} aria-pressed={mode === kind}
            onClick={() => setMode(kind)}>{label}</Button>
        ))}
      </div>
      <form className="mb-4 mt-3" onSubmit={event => event.preventDefault()}>
        <input aria-label={t('曲名・アーティスト')} placeholder={t('曲名・アーティスト')} type="search" maxLength={160}
          value={query} onChange={event => setQuery(event.target.value)} className={INPUT} />
      </form>
      {mode === 'chords' && (
        <div className="mb-4 grid gap-3 rounded-row border border-yt-outline p-3">
          <p className="text-xs text-yt-text-secondary">{t('キーの主音を I として、コードを2つ以上並べてください。')}</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setChords(POP)}>I · V · VIm · IV</Button>
            <Button size="sm" variant="outline" onClick={() => setChords(ROYAL)}>{t('王道進行')}</Button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            {t('コードの種類')}
            <select value={quality} onChange={event => setQuality(event.target.value as Chord['quality'])}
              className="rounded-row border border-yt-outline bg-yt-bg p-1.5">
              {CHART_QUALITIES.map(value => <option value={value} key={value}>{value || t('メジャー')}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-1" role="group" aria-label={t('度数を追加')}>
            {DEGREES.map((degree, root) => (
              <Button size="sm" key={degree} disabled={chords.length >= 12} onClick={() => setChords([...chords, { root, quality }])}>
                {degree}{quality}
              </Button>
            ))}
          </div>
          {chords.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <output className="basis-full break-words text-sm font-semibold">{chords.map(({ root, quality }) => DEGREES[root] + quality).join(' · ')}</output>
              <Button size="sm" variant="ghost" onClick={() => setChords(chords.slice(0, -1))}>{t('1つ戻す')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setChords([])}>{t('消去')}</Button>
            </div>
          )}
        </div>
      )}
      {mode === 'melody' && (
        <div className="mb-4 grid gap-3 rounded-row border border-yt-outline p-3">
          <p className="text-xs text-yt-text-secondary">{t('鍵盤で4音以上入力してください。キーが違っても音程の並びで探せます。')}
            {' '}{t('6音以上なら、1音の違いも探せます。')}</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setNotes([72, 76, 79, 77])}>{t('試聴曲のメロディ')}</Button>
            <Button size="sm" aria-label={t('1オクターブ下')} disabled={octave === -2} onClick={() => setOctave(octave - 1)}>−8va</Button>
            <Button size="sm" aria-label={t('1オクターブ上')} disabled={octave === 2} onClick={() => setOctave(octave + 1)}>+8va</Button>
          </div>
          <div className="relative flex h-24" role="group" aria-label={t('鍵盤')}>
            {WHITE.map(note => pianoKey(note, 'flex min-w-0 flex-1 cursor-pointer items-end justify-center rounded-b border border-zinc-300 bg-white pb-1 text-[10px] font-semibold text-zinc-800 hover:bg-sky-100 focus-visible:z-10'))}
            {BLACK.map((note, i) => pianoKey(note, 'absolute top-0 h-14 w-[8%] -translate-x-1/2 cursor-pointer rounded-b bg-zinc-800 text-white hover:bg-sky-800 focus-visible:z-10', BLACK_STARTS[i] * 12.5))}
          </div>
          {notes.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <output className="basis-full break-words text-sm font-semibold">{notes.map(noteName).join(' · ')}</output>
              <Button size="sm" variant="ghost" onClick={() => setNotes(notes.slice(0, -1))}>{t('1つ戻す')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setNotes([])}>{t('消去')}</Button>
              <Button size="sm" onClick={() => audition(notes, 0.3)}>{t('聴いてみる')}</Button>
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-yt-outline pb-2 text-sm">
        <h2 className="font-semibold">{mode === 'title' ? t('このブラウザーのコード譜') : t('一致したコード譜')}</h2>
        {query.trim() && mode === 'title' && <Link to={searchPath(query.trim(), 'song')} className="text-yt-link underline">{t('DIVAの曲名検索へ')}</Link>}
      </div>
      {enough && !results.length && <p className="pt-3 text-sm text-yt-text-secondary">{t('一致するコード譜がありません。')}</p>}
      <ul className="max-h-[22rem] overflow-y-auto">
        {results.map(({ chart, start, approximate }) => (
          <li key={chart.id} className="border-b border-yt-outline last:border-b-0">
            <button type="button" aria-current={chart.id === selected ? 'true' : undefined}
              className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-row p-2.5 text-left hover:bg-yt-tonal-hover"
              onClick={() => onSelect(chart, start)}>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{chart.title}</span>
                {(chart.artist || chart.id === 'demo') && <span className="block truncate text-xs text-yt-text-secondary">{chart.artist || t('試聴曲')}</span>}
              </span>
              <span className="shrink-0 text-right text-xs tabular-nums text-yt-text-secondary">
                {mode === 'title' ? chart.bpm && `${chart.bpm} BPM` : formatClockDuration(start)}
                {approximate && <span className="block">{t('近い候補')}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
