import { useMemo, useState } from 'react';
import type { SmartPlaylistRule } from '../../types/vocadb';
import { SMART_DERIVED_SONG_TYPES, formatSmartPlaylistRule } from '../../utils/smartPlaylist';

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
};

function normalizeRule(rule?: SmartPlaylistRule): SmartPlaylistRule {
  return {
    minYoutubeViews: Math.max(0, Math.floor(rule?.minYoutubeViews ?? 0)),
    minNicoViews: Math.max(0, Math.floor(rule?.minNicoViews ?? 0)),
    excludedSongTypes: [...(rule?.excludedSongTypes ?? [])],
    producerId: rule?.producerId,
    producerName: rule?.producerName,
  };
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

  const summary = useMemo(() => formatSmartPlaylistRule(rule), [rule]);
  const derivedExcluded = SMART_DERIVED_SONG_TYPES.every(type => rule.excludedSongTypes.includes(type));

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

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary text-sm" onClick={onClose}>キャンセル</button>
          <button type="button" className="btn-primary text-sm" onClick={submit}>{mode === 'create' ? '条件を保存して作成' : '条件を更新'}</button>
        </div>
      </div>
    </div>
  );
}
