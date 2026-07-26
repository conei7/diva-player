import { useEffect, useMemo, useState } from 'react';
import type { SmartPlaylistRule } from '../../types/vocadb';
import { searchSmartPlaylistSongs } from '../../api/vocadb';
import {
  SMART_DERIVED_SONG_TYPES,
  SMART_PLAYLIST_MAX_SONGS,
  SMART_PLAYLIST_SORTS,
  formatSmartPlaylistRule,
  filterSmartPlaylistSongs,
  normalizeSmartPlaylistRule,
} from '../../utils/smartPlaylist';

export interface SmartPlaylistBuilderValues {
  name: string;
  rule: SmartPlaylistRule;
}

interface SmartPlaylistBuilderProps {
  mode: 'create' | 'edit';
  initialName?: string;
  initialRule?: SmartPlaylistRule;
  onClose: () => void;
  onSubmit: (values: SmartPlaylistBuilderValues) => void;
}

const EMPTY_RULE: SmartPlaylistRule = {
  minYoutubeViews: 0,
  minNicoViews: 0,
  excludedSongTypes: [],
  maxSongs: 200,
  sortBy: 'FavoritedTimes',
};

function normalizeRule(rule?: SmartPlaylistRule): SmartPlaylistRule {
  return normalizeSmartPlaylistRule(rule);
}

export function SmartPlaylistRuleSummary({ rule, compact = false }: { rule: SmartPlaylistRule; compact?: boolean }) {
  const summary = formatSmartPlaylistRule(rule);
  return (
    <div className={`flex flex-wrap gap-1.5 ${compact ? 'text-[10px]' : 'text-xs'}`}>
      {summary.map(item => (
        <span
          key={item}
          className="rounded-full border border-cyan-300/20 bg-cyan-300/[0.08] px-2 py-0.5 text-cyan-100/80"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

export default function SmartPlaylistBuilder({
  mode,
  initialName = '',
  initialRule,
  onClose,
  onSubmit,
}: SmartPlaylistBuilderProps) {
  const [name, setName] = useState(initialName);
  const [rule, setRule] = useState<SmartPlaylistRule>(() => normalizeRule(initialRule ?? EMPTY_RULE));
  const [showAdvanced, setShowAdvanced] = useState(() => (initialRule?.excludedSongTypes.length ?? 0) > 0);
  const [preview, setPreview] = useState<{
    state: 'loading' | 'success' | 'empty' | 'error';
    matchedCount?: number;
    loadedCount?: number;
    names?: string[];
  } | null>(null);

  const summary = useMemo(() => formatSmartPlaylistRule(rule), [rule]);
  const derivedExcluded = SMART_DERIVED_SONG_TYPES.every(type => rule.excludedSongTypes.includes(type));

  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12_000);
    const timer = window.setTimeout(() => {
      setPreview({ state: 'loading' });
      void searchSmartPlaylistSongs(rule, 5, controller.signal)
        .then(result => {
          const matchingSongs = filterSmartPlaylistSongs(result.items, rule);
          setPreview({
            state: matchingSongs.length > 0 ? 'success' : 'empty',
            matchedCount: result.totalCount,
            loadedCount: matchingSongs.length,
            names: matchingSongs.slice(0, 5).map(song => song.name),
          });
        })
        .catch(() => {
          if (controller.signal.aborted && !timedOut) return;
          setPreview({ state: 'error' });
        })
        .finally(() => {
          window.clearTimeout(timeout);
        });
    }, 400);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
      window.clearTimeout(timer);
    };
  }, [rule]);

  const updateRule = (patch: Partial<SmartPlaylistRule>) => {
    setRule(current => ({ ...current, ...patch }));
  };

  const toggleDerivedSongs = () => {
    updateRule({
      excludedSongTypes: derivedExcluded
        ? rule.excludedSongTypes.filter(type => !SMART_DERIVED_SONG_TYPES.includes(type))
        : Array.from(new Set([...rule.excludedSongTypes, ...SMART_DERIVED_SONG_TYPES])),
    });
  };

  const submit = () => {
    if (preview?.state === 'empty' && !window.confirm('一致する曲が0件の条件を保存しますか？')) return;
    onSubmit({
      name: name.trim() || 'スマートプレイリスト',
      rule: normalizeRule(rule),
    });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      role="presentation"
      onClick={event => event.target === event.currentTarget && onClose()}
    >
      <div
        className="flex max-h-[min(720px,calc(100dvh-2rem))] w-full max-w-lg flex-col overflow-y-auto rounded-3xl border border-white/10 bg-[var(--color-bg-card)] p-5 shadow-2xl animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-labelledby="smart-playlist-builder-title"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex items-center gap-2 text-violet-200">
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
                <path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15Z" />
              </svg>
              <span className="text-xs font-semibold uppercase tracking-[0.18em]">Smart playlist</span>
            </div>
            <h2 id="smart-playlist-builder-title" className="text-xl font-bold text-white">
              {mode === 'create' ? 'スマートプレイリストを作成' : 'スマートプレイリストの条件を編集'}
            </h2>
            <p className="mt-1 text-sm leading-6 text-neutral-400">
              条件に合う曲を、プレイリストを開いたときに自動で更新します。
            </p>
          </div>
          <button type="button" className="rounded-full p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white" onClick={onClose} aria-label="閉じる">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <label className="mt-5 flex flex-col gap-1.5">
          <span className="text-xs font-medium text-neutral-300">プレイリスト名</span>
          <input
            className="search-input w-full"
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="例: 定番曲・高再生数"
            autoFocus
          />
        </label>

        <section className="mt-5 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">再生数の条件</h3>
              <p className="mt-1 text-xs leading-5 text-neutral-500">0にすると、そのサービスの再生数では絞り込みません。</p>
            </div>
            <span className="rounded-full bg-violet-300/10 px-2 py-1 text-[10px] font-semibold text-violet-200">任意</span>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-neutral-400">YouTube最低再生数</span>
              <input
                className="input w-full"
                type="number"
                min={0}
                step={1000}
                value={rule.minYoutubeViews}
                onChange={event => updateRule({ minYoutubeViews: Number(event.target.value) || 0 })}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-neutral-400">ニコニコ最低再生数</span>
              <input
                className="input w-full"
                type="number"
                min={0}
                step={1000}
                value={rule.minNicoViews}
                onChange={event => updateRule({ minNicoViews: Number(event.target.value) || 0 })}
              />
            </label>
          </div>
        </section>

        <section className="mt-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
          <div>
            <h3 className="text-sm font-semibold text-white">保存と並び順</h3>
            <p className="mt-1 text-xs leading-5 text-neutral-500">条件に一致した曲のうち、ここで指定した件数を保存します。</p>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-neutral-400">保存曲数</span>
              <select className="input w-full" value={rule.maxSongs ?? 200} onChange={event => updateRule({ maxSongs: Number(event.target.value) as SmartPlaylistRule['maxSongs'] })}>
                {SMART_PLAYLIST_MAX_SONGS.map(value => <option key={value} value={value}>{value}曲</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-neutral-400">並び順</span>
              <select className="input w-full" value={rule.sortBy ?? 'FavoritedTimes'} onChange={event => updateRule({ sortBy: event.target.value as SmartPlaylistRule['sortBy'] })}>
                {SMART_PLAYLIST_SORTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="mt-3 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
          <button type="button" className="flex w-full items-center justify-between text-left" onClick={() => setShowAdvanced(value => !value)} aria-expanded={showAdvanced}>
            <span>
              <span className="block text-sm font-semibold text-white">除外条件</span>
              <span className="mt-1 block text-xs text-neutral-500">カバーや派生曲を候補から外せます。</span>
            </span>
            <svg className={`h-4 w-4 text-neutral-400 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          {showAdvanced && (
            <div className="mt-3 space-y-2 border-t border-white/[0.07] pt-3">
              <label className="flex cursor-pointer items-start gap-2 rounded-xl p-2 transition-colors hover:bg-white/[0.04]">
                <input type="checkbox" checked={derivedExcluded} onChange={toggleDerivedSongs} className="mt-0.5 accent-cyan-400" />
                <span>
                  <span className="block text-sm text-neutral-200">カバー・派生曲を除外</span>
                  <span className="mt-0.5 block text-xs leading-5 text-neutral-500">カバー、リミックス、アレンジ、マッシュアップを除外します。</span>
                </span>
              </label>
            </div>
          )}
        </section>

        <section className="mt-5 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.05] p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-cyan-200/70">現在の条件</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {summary.map(item => (
              <span key={item} className="rounded-full border border-cyan-300/20 bg-cyan-300/[0.08] px-2.5 py-1 text-xs text-cyan-50/90">{item}</span>
            ))}
          </div>
        </section>

        <section className="mt-3 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4" aria-live="polite">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-white">一致件数プレビュー</p>
            {preview?.state === 'loading' && <span className="text-xs text-cyan-300">確認中…</span>}
          </div>
          {preview?.state === 'success' && (
            <>
              <p className="mt-2 text-sm text-neutral-300">総一致 {preview.matchedCount ?? 0}曲 / 保存予定 {Math.min(preview.matchedCount ?? 0, rule.maxSongs ?? 200)}曲</p>
              <ul className="mt-2 space-y-1 text-xs text-neutral-500">{preview.names?.map(name => <li key={name} className="truncate">・{name}</li>)}</ul>
            </>
          )}
          {preview?.state === 'empty' && <p className="mt-2 text-sm text-amber-200">一致する曲はありません。保存する場合は明示確認が必要です。</p>}
          {preview?.state === 'error' && <p className="mt-2 text-sm text-amber-200">一致件数を取得できませんでした。条件は保存できますが、更新にはAPI接続が必要です。</p>}
        </section>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary text-sm" onClick={onClose}>キャンセル</button>
          <button type="button" className="btn-primary text-sm" onClick={submit}>{mode === 'create' ? '条件を保存して作成' : '条件を更新'}</button>
        </div>
      </div>
    </div>
  );
}
