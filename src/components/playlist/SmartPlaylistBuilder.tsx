import { useEffect, useMemo, useState } from 'react';
import type { Artist, SmartPlaylistRule, Song } from '../../types/vocadb';
import { searchProducersByName, searchSmartPlaylistSongs } from '../../api/vocadb';
import {
  SMART_DERIVED_SONG_TYPES, SMART_PLAYLIST_MAX_SONGS, SMART_PLAYLIST_SORTS, SMART_PLAYLIST_PRESETS,
  formatSmartPlaylistRule, filterSmartPlaylistSongs, normalizeSmartPlaylistRule,
  applySmartPlaylistPreset, validateSmartPlaylistRule,
} from '../../utils/smartPlaylist';
import { useTranslateSourceText } from '../../i18n';
import PlaylistDialog from './PlaylistDialog';

export interface SmartPlaylistBuilderValues { name: string; rule: SmartPlaylistRule }
interface SmartPlaylistBuilderProps {
  mode: 'create' | 'edit'; initialName?: string; initialRule?: SmartPlaylistRule;
  onClose: () => void; onSubmit: (values: SmartPlaylistBuilderValues) => void;
}
function translateRuleSummary(item: string, t: (source: string, values?: Record<string, string | number>) => string): string {
  let match = item.match(/^YouTube ([\d,]+)以上$/);
  if (match) return t('YouTube {count}以上', { count: match[1] });
  match = item.match(/^ニコニコ ([\d,]+)以上$/);
  if (match) return t('ニコニコ {count}以上', { count: match[1] });
  match = item.match(/^上限 (\d+)曲$/);
  if (match) return t('上限 {count}曲', { count: match[1] });
  match = item.match(/^公開年 (.*?)〜(.*?)$/);
  if (match) return t('公開年 {from}〜{to}', { from: match[1], to: match[2] });
  match = item.match(/^長さ (.*?)〜(.*?)秒$/);
  if (match) return t('長さ {from}〜{to} 秒', { from: match[1], to: match[2] });
  if (item.startsWith('除外: ')) return t('除外: {types}', { types: item.slice(4).split('・').map(type => t(type)).join(', ') });
  return t(item);
}
export function SmartPlaylistRuleSummary({ rule, compact = false }: { rule: SmartPlaylistRule; compact?: boolean }) {
  const t = useTranslateSourceText();
  return <div className={`flex flex-wrap gap-1.5 ${compact ? 'text-[11px]' : 'text-xs'}`}>{formatSmartPlaylistRule(rule).map(item => <span key={item} className="rounded-md bg-white/5 px-2 py-1 text-neutral-300">{translateRuleSummary(item, t)}</span>)}</div>;
}
const PRESET_HINTS: Record<string, string> = {
  classics: '再生数と支持数から定番曲を集めます。', niconico: 'ニコニコで再生できる人気曲を集めます。', audio: '音響データがある曲を集めます。',
};
export default function SmartPlaylistBuilder({ mode, initialName = '', initialRule, onClose, onSubmit }: SmartPlaylistBuilderProps) {
  const t = useTranslateSourceText();
  const [name, setName] = useState(initialName);
  const [rule, setRule] = useState<SmartPlaylistRule>(() => normalizeSmartPlaylistRule(initialRule ?? applySmartPlaylistPreset('classics', 50)));
  const [presetId, setPresetId] = useState(initialRule ? '' : 'classics');
  const [producerQuery, setProducerQuery] = useState('');
  const [producers, setProducers] = useState<Artist[]>([]);
  const [producerError, setProducerError] = useState(false);
  const [allowEmpty, setAllowEmpty] = useState(false);
  const [preview, setPreview] = useState<{ state: 'loading' | 'success' | 'empty' | 'error'; matchedCount?: number; songs?: Song[] }>({ state: 'loading' });
  const validation = validateSmartPlaylistRule(rule);
  const derivedExcluded = SMART_DERIVED_SONG_TYPES.every(type => rule.excludedSongTypes.includes(type));
  const initialHasAdvanced = useMemo(() => Boolean(initialRule?.minYoutubeViews || initialRule?.minNicoViews || initialRule?.lengthMinSeconds || initialRule?.lengthMaxSeconds || initialRule?.audioComputed && initialRule.audioComputed !== 'any'), [initialRule]);
  useEffect(() => {
    if (validation) return;
    const controller = new AbortController();
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); setPreview({ state: 'error' }); }, 12_000);
    const timer = window.setTimeout(() => {
      void searchSmartPlaylistSongs(rule, 5, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        const songs = filterSmartPlaylistSongs(result.items, rule);
        setPreview({ state: songs.length ? 'success' : 'empty', matchedCount: result.totalCount, songs });
      }).catch(() => {
        if (!controller.signal.aborted || timedOut) setPreview({ state: 'error' });
      }).finally(() => window.clearTimeout(timeout));
    }, 400);
    return () => { controller.abort(); window.clearTimeout(timeout); window.clearTimeout(timer); };
  }, [rule, validation]);
  useEffect(() => {
    if (!producerQuery.trim()) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void searchProducersByName(producerQuery, 6).then(items => { if (active) { setProducers(items); setProducerError(false); } })
        .catch(() => { if (active) { setProducers([]); setProducerError(true); } });
    }, 350);
    return () => { active = false; window.clearTimeout(timer); };
  }, [producerQuery]);
  const updateRule = (patch: Partial<SmartPlaylistRule>) => {
    setRule(current => ({ ...current, ...patch })); setPreview({ state: 'loading' }); setAllowEmpty(false); setPresetId('');
  };
  const choosePreset = (id: string) => {
    setRule(applySmartPlaylistPreset(id, rule.maxSongs)); setPresetId(id); setPreview({ state: 'loading' }); setAllowEmpty(false); setProducerQuery(''); setProducers([]);
    if (!name.trim()) setName(t(SMART_PLAYLIST_PRESETS.find(item => item.id === id)?.label ?? 'スマートプレイリスト'));
  };
  const submit = () => {
    if (validation || preview.state === 'loading' || (preview.state === 'empty' && !allowEmpty)) return;
    onSubmit({ name: name.trim() || t(SMART_PLAYLIST_PRESETS.find(item => item.id === presetId)?.label ?? 'スマートプレイリスト'), rule: normalizeSmartPlaylistRule(rule) });
  };
  return (
    <PlaylistDialog titleId="smart-playlist-builder-title" onClose={onClose} wide>
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-xs font-medium text-violet-300">{t('スマートプレイリスト')}</p><h2 id="smart-playlist-builder-title" className="mt-1 text-xl font-bold">{mode === 'create' ? t('条件で曲を集める') : t('曲を集める条件を編集')}</h2><p className="mt-2 max-w-xl text-sm leading-6 text-neutral-400">{t('条件に合う曲を自動で集めます。開くたびに最新の候補へ更新され、手動で足した曲や並び順は次回更新で置き換わります。')}</p></div>
        <button type="button" className="h-11 w-11 shrink-0 rounded-xl text-xl text-neutral-400 hover:bg-white/10" onClick={onClose} aria-label={t('閉じる')}>×</button>
      </div>
      <section className="mt-5"><h3 className="text-sm font-semibold">{t('1 集めたい曲を選ぶ')}</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">{SMART_PLAYLIST_PRESETS.map(preset => <button key={preset.id} type="button" aria-pressed={presetId === preset.id} onClick={() => choosePreset(preset.id)} className={`rounded-xl border p-3 text-left ${presetId === preset.id ? 'border-violet-300/40 bg-violet-300/10' : 'border-white/10 hover:bg-white/5'}`}><span className="block text-sm font-semibold">{t(preset.label)}</span><span className="mt-1 block text-xs leading-5 text-neutral-400">{t(PRESET_HINTS[preset.id])}</span></button>)}</div>
        <button type="button" className="mt-2 min-h-11 text-xs text-neutral-400 hover:text-white" onClick={() => choosePreset('')}>{t('条件をリセットして指定する')}</button>
      </section>
      <div className="mt-3 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-4"><h3 className="text-sm font-semibold">{t('2 条件を調整する')}</h3>
          <label className="block text-xs text-neutral-300">{t('プレイリスト名')}<input className="playlist-field mt-1 w-full text-sm" value={name} onChange={event => setName(event.target.value)} placeholder={t('例: 定番曲・高再生数')} /></label>
          <label className="block text-xs text-neutral-300">{t('利用可能PV')}<select className="playlist-field mt-1 w-full text-sm" value={rule.pvService ?? 'any'} onChange={event => updateRule({ pvService: event.target.value as SmartPlaylistRule['pvService'] })}><option value="any">{t('指定なし')}</option><option value="youtube">{t('YouTubeあり')}</option><option value="niconico">{t('ニコニコあり')}</option><option value="both">{t('両方あり')}</option></select></label>
          <div className="grid grid-cols-2 gap-2">{(['publishYearFrom', 'publishYearTo'] as const).map((key, index) => <label key={key} className="block text-xs text-neutral-300">{t(index ? '公開年（終了）' : '公開年（開始）')}<input className="playlist-field mt-1 w-full text-sm" inputMode="numeric" value={rule[key] ?? ''} onChange={event => updateRule({ [key]: event.target.value.replace(/\D/g, '').slice(0, 4) })} placeholder={index ? '2026' : '2020'} /></label>)}</div>
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-neutral-300"><input type="checkbox" checked={derivedExcluded} onChange={() => updateRule({ excludedSongTypes: derivedExcluded ? rule.excludedSongTypes.filter(type => !SMART_DERIVED_SONG_TYPES.includes(type)) : Array.from(new Set([...rule.excludedSongTypes, ...SMART_DERIVED_SONG_TYPES])) })} />{t('カバー・派生曲を除外')}</label>
          <div className="text-xs text-neutral-300">{t('プロデューサー')}
            {rule.producerId ? <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-white/10 p-2 text-sm"><span className="min-w-0 truncate">{rule.producerName || `ID: ${rule.producerId}`}</span><button type="button" aria-label={t('プロデューサーの条件を解除')} onClick={() => updateRule({ producerId: undefined, producerName: undefined })} className="h-9 w-9">×</button></div> : <>
              <input className="playlist-field mt-1 w-full text-sm" aria-label={t('プロデューサーを検索')} placeholder={t('名前で検索（任意）')} value={producerQuery} onChange={event => { setProducerQuery(event.target.value); setProducers([]); setProducerError(false); }} />
              {producers.length > 0 && <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-white/10">{producers.map(producer => <li key={producer.id}><button type="button" className="min-h-11 w-full px-3 text-left text-sm hover:bg-white/5" onClick={() => { updateRule({ producerId: producer.id, producerName: producer.name }); setProducerQuery(''); setProducers([]); }}>{producer.name}</button></li>)}</ul>}
              {producerError && <p role="alert" className="mt-1 text-xs text-amber-200">{t('プロデューサーを取得できませんでした。名前を入力し直してください。')}</p>}
            </>}
          </div>
          <details open={initialHasAdvanced || undefined} className="rounded-xl border border-white/10 p-3">
            <summary className="cursor-pointer py-1 text-xs text-neutral-300">{t('再生数・長さ・音響データの条件')}</summary>
            <p className="mt-3 text-xs leading-5 text-neutral-500">{t('0は指定なし。YouTubeとニコニコの最低再生数を両方指定すると、両方を満たす曲だけが対象です。')}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">{(['minYoutubeViews', 'minNicoViews'] as const).map((key, index) => <label key={key} className="block text-xs text-neutral-400">{t(index ? 'ニコニコ最低再生数' : 'YouTube最低再生数')}<input className="playlist-field mt-1 w-full text-sm" type="number" min={0} step={1000} value={rule[key]} onChange={event => updateRule({ [key]: Math.max(0, Number(event.target.value) || 0) })} /></label>)}
              {(['lengthMinSeconds', 'lengthMaxSeconds'] as const).map((key, index) => <label key={key} className="block text-xs text-neutral-400">{t(index ? '長さ（最長秒）' : '長さ（最短秒）')}<input className="playlist-field mt-1 w-full text-sm" inputMode="numeric" value={rule[key] ?? ''} onChange={event => updateRule({ [key]: event.target.value.replace(/\D/g, '') })} placeholder={index ? '360' : '60'} /></label>)}
            </div>
            <label className="mt-3 block text-xs text-neutral-400">{t('音響データ')}<select className="playlist-field mt-1 w-full text-sm" value={rule.audioComputed ?? 'any'} onChange={event => updateRule({ audioComputed: event.target.value as SmartPlaylistRule['audioComputed'] })}><option value="any">{t('指定なし')}</option><option value="yes">{t('あり')}</option><option value="no">{t('なし')}</option></select></label>
          </details>
        </section>
        <section className="min-w-0 space-y-4"><h3 className="text-sm font-semibold">{t('3 集め方と結果を確認する')}</h3>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-neutral-300">{t('保存曲数')}<select className="playlist-field mt-1 w-full text-sm" value={rule.maxSongs ?? 200} onChange={event => updateRule({ maxSongs: Number(event.target.value) as SmartPlaylistRule['maxSongs'] })}>{SMART_PLAYLIST_MAX_SONGS.map(value => <option key={value} value={value}>{t('{count}曲', { count: value })}</option>)}</select></label>
            <label className="text-xs text-neutral-300">{t('並び順')}<select className="playlist-field mt-1 w-full text-sm" value={rule.sortBy ?? 'FavoritedTimes'} onChange={event => updateRule({ sortBy: event.target.value as SmartPlaylistRule['sortBy'] })}>{SMART_PLAYLIST_SORTS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}</select></label>
          </div>
          <p className="text-xs leading-5 text-neutral-400">{t('選んだ順序の上位曲を保存します。ランダム抽選や好みの学習ではありません。条件はすべて同時に適用します。')}</p>
          <div className="rounded-xl border border-white/10 p-3"><p className="mb-2 text-xs text-neutral-400">{t('現在の条件')}</p><SmartPlaylistRuleSummary rule={rule} compact /></div>
          <div className="rounded-xl border border-violet-300/20 bg-violet-300/5 p-4" aria-live="polite" aria-busy={preview.state === 'loading' && !validation}>
            <h4 className="text-sm font-semibold">{t('一致件数プレビュー')}</h4>
            {validation ? <p role="alert" className="mt-2 text-sm text-amber-200">{t(validation)}</p> : <>
              {preview.state === 'loading' && <p className="mt-2 text-sm text-neutral-400">{t('確認中…')}</p>}
              {preview.state === 'success' && <><p className="mt-2 text-sm text-violet-100">{t('総一致 {matched}曲 / 保存予定 {saved}曲', { matched: preview.matchedCount ?? 0, saved: Math.min(preview.matchedCount ?? 0, rule.maxSongs ?? 200) })}</p><ol className="mt-3 space-y-3">{preview.songs?.map((song, index) => <li key={song.id} className="flex min-w-0 items-start gap-2 text-xs"><span className="text-neutral-500">{index + 1}</span><div className="min-w-0"><p className="truncate text-neutral-200">{song.name}</p><p className="mt-0.5 truncate text-neutral-500">{song.artistString}</p></div></li>)}</ol></>}
              {preview.state === 'empty' && <><p className="mt-2 text-sm text-amber-200">{t('一致する曲はありません。条件を減らすか、最低再生数を下げてください。')}</p><label className="mt-3 flex items-start gap-2 text-xs leading-5 text-neutral-400"><input type="checkbox" checked={allowEmpty} onChange={event => setAllowEmpty(event.target.checked)} className="mt-1" />{t('0曲の条件として保存し、次に開いたときに再確認する')}</label></>}
              {preview.state === 'error' && <p className="mt-2 text-sm leading-6 text-amber-200">{t('一致件数を取得できませんでした。条件は保存できますが、更新にはAPI接続が必要です。')}</p>}
            </>}
          </div>
        </section>
      </div>
      <footer className="mt-6 flex flex-col-reverse gap-2 border-t border-white/10 pt-4 sm:flex-row sm:justify-end">
        <button type="button" className="btn-secondary min-h-11 text-sm" onClick={onClose}>{t('キャンセル')}</button>
        <button type="button" className="btn-primary min-h-11 text-sm" disabled={Boolean(validation) || preview.state === 'loading' || (preview.state === 'empty' && !allowEmpty)} onClick={submit}>{mode === 'create' ? t('条件を保存して作成') : t('条件を更新')}</button>
      </footer>
    </PlaylistDialog>
  );
}
