import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Artist, SmartPlaylistRule, Song } from '../../types/vocadb';
import { searchProducersByName } from '../../api/vocadb';
import { searchSmartPlaylistSongs } from '../../api/smartPlaylist';
import { useTranslateSourceText } from '../../i18n';
import { MOBILE_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useLanguageStore } from '../../stores/languageStore';
import {
  SMART_DERIVED_SONG_TYPES, SMART_PLAYLIST_MAX_SONGS, SMART_PLAYLIST_SORTS, SMART_PLAYLIST_PRESETS,
  filterSmartPlaylistSongs, normalizeSmartPlaylistRule,
  applySmartPlaylistPreset, validateSmartPlaylistRule,
} from '../../utils/smartPlaylist';
import { formatArtistLine } from '../../utils/songMeta';
import Button from '../ui/Button';
import { Chip, RemovableChip } from '../ui/Chip';
import Dialog from '../ui/Dialog';
import SongThumbnail from '../ui/SongThumbnail';
import Switch from '../ui/Switch';
import { ChevronDownIcon, SpinnerIcon } from '../ui/icons';
import { cx } from '../ui/overlay';
import { PLAYLIST_FIELD_CLASS, PLAYLIST_FIELD_LABEL_CLASS } from './playlistDisplay';

export interface SmartPlaylistBuilderValues { name: string; rule: SmartPlaylistRule }
interface SmartPlaylistBuilderProps {
  mode: 'create' | 'edit'; initialName?: string; initialRule?: SmartPlaylistRule;
  onClose: () => void; onSubmit: (values: SmartPlaylistBuilderValues) => void | Promise<void>;
}

type PreviewState = { state: 'loading' | 'success' | 'empty' | 'error'; matchedCount?: number; songs?: Song[] };

const YEAR_ERRORS = new Set(['公開年は4桁で入力してください', '公開年の範囲が正しくありません']);

function Field({ label, htmlFor, children, error }: { label: ReactNode; htmlFor?: string; children: ReactNode; error?: string | null }) {
  return (
    <div>
      {htmlFor
        ? <label htmlFor={htmlFor} className={PLAYLIST_FIELD_LABEL_CLASS}>{label}</label>
        : <span className={PLAYLIST_FIELD_LABEL_CLASS}>{label}</span>}
      {children}
      {error && <p role="alert" className="m-0 mt-1 text-xs leading-[18px] text-yt-danger">{error}</p>}
    </div>
  );
}

/** スマートプレイリストを作成 / 条件を編集: rules on the left, a live preview on the right. */
export default function SmartPlaylistBuilder({ mode, initialName = '', initialRule, onClose, onSubmit }: SmartPlaylistBuilderProps) {
  const { busy: saving, run: runSave } = useAsyncAction();
  const t = useTranslateSourceText();
  const language = useLanguageStore(state => state.language);
  const ids = useId();
  const mobile = useMediaQuery(MOBILE_MEDIA_QUERY);
  const [name, setName] = useState(initialName);
  const [rule, setRule] = useState<SmartPlaylistRule>(() => normalizeSmartPlaylistRule(initialRule ?? applySmartPlaylistPreset('classics')));
  const [presetId, setPresetId] = useState(initialRule ? '' : 'classics');
  const [producerQuery, setProducerQuery] = useState('');
  const [producers, setProducers] = useState<Artist[]>([]);
  const [producerError, setProducerError] = useState(false);
  const [allowEmpty, setAllowEmpty] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ state: 'loading' });
  const validation = validateSmartPlaylistRule(rule);
  const derivedExcluded = SMART_DERIVED_SONG_TYPES.every(type => rule.excludedSongTypes.includes(type));
  const initialHasAdvanced = useMemo(() => Boolean(initialRule?.minYoutubeViews || initialRule?.minNicoViews || initialRule?.lengthMinSeconds || initialRule?.lengthMaxSeconds || (initialRule?.audioComputed && initialRule.audioComputed !== 'any')), [initialRule]);

  useEffect(() => {
    if (validation) return undefined;
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
    if (!producerQuery.trim()) return undefined;
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
    if (id === presetId) return;
    setRule(applySmartPlaylistPreset(id, rule.maxSongs)); setPresetId(id); setPreview({ state: 'loading' }); setAllowEmpty(false); setProducerQuery(''); setProducers([]);
    if (!name.trim() && id) setName(t(SMART_PLAYLIST_PRESETS.find(item => item.id === id)?.label ?? 'スマートプレイリスト'));
  };
  const blocked = Boolean(validation) || preview.state === 'loading' || (preview.state === 'empty' && !allowEmpty);
  const submit = () => {
    if (blocked) return;
    void runSave(() => onSubmit({ name: name.trim() || t(SMART_PLAYLIST_PRESETS.find(item => item.id === presetId)?.label ?? 'スマートプレイリスト'), rule: normalizeSmartPlaylistRule(rule) }));
  };

  const matched = preview.matchedCount ?? 0;
  const saved = rule.maxSongs === 'all' ? matched : Math.min(matched, rule.maxSongs ?? 200);
  const formatNumber = (value: number) => value.toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US');
  const summary = rule.maxSongs === 'all'
    ? t('{matched}曲が一致 · 全曲を保存', { matched: formatNumber(matched) })
    : matched === 1
    ? t('1曲が一致 · 上位{saved}曲を保存', { saved: formatNumber(saved) })
    : t('{matched}曲が一致 · 上位{saved}曲を保存', { matched: formatNumber(matched), saved: formatNumber(saved) });
  const shortSummary = matched === 1 ? t('1曲が一致') : t('{count}曲が一致', { count: formatNumber(matched) });
  // 「2020 〜 2026」 / 「2020 – 2026」
  const rangeSeparator = <span aria-hidden="true" className="text-yt-text-secondary">{t('〜')}</span>;
  const yearError = validation && YEAR_ERRORS.has(validation) ? t(validation) : null;
  const lengthError = validation && !YEAR_ERRORS.has(validation) ? t(validation) : null;
  const viewsValue = (value: number) => (value > 0 ? String(value) : '');

  const previewBody = validation ? null : (
    <>
      {preview.state === 'loading' && (
        <p className="m-0 flex items-center gap-2 text-sm leading-5 text-yt-text-secondary"><SpinnerIcon size={20} />{t('読み込み中…')}</p>
      )}
      {preview.state === 'success' && (
        <>
          <p className="m-0 text-sm leading-5 text-yt-text tabular-nums">{summary}</p>
          <ol className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
            {preview.songs?.map(song => (
              <li key={song.id} className="flex min-w-0 items-center gap-2">
                <SongThumbnail song={song} className="w-[100px]" radius="sm" showDuration={false} />
                <div className="min-w-0 flex-1">
                  <p className="m-0 line-clamp-2 text-sm font-medium leading-5 text-yt-text">{song.name}</p>
                  <p className="m-0 truncate text-xs leading-[18px] text-yt-text-secondary">{formatArtistLine(song)}</p>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
      {preview.state === 'empty' && (
        <>
          <p className="m-0 text-sm leading-5 text-yt-text">{t('一致する曲がありません')}</p>
          <label className="mt-3 flex min-h-10 cursor-pointer items-center gap-2 text-sm leading-5 text-yt-text">
            <input type="checkbox" checked={allowEmpty} onChange={event => setAllowEmpty(event.target.checked)} className="size-4 accent-yt-link" />
            {t('0曲でも保存する')}
          </label>
        </>
      )}
      {preview.state === 'error' && <p className="m-0 text-sm leading-5 text-yt-text-secondary">{t('プレビューを読み込めませんでした')}</p>}
    </>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'create' ? t('スマートプレイリストを作成') : t('条件を編集')}
      size="lg"
      data-testid="smart-playlist-builder"
      footerStart={mobile && !validation ? (
        <span className="truncate text-sm leading-5 text-yt-text-secondary tabular-nums" aria-live="polite">
          {preview.state === 'loading' ? t('読み込み中…') : preview.state === 'error' ? t('プレビューを読み込めませんでした') : shortSummary}
        </span>
      ) : undefined}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{t('キャンセル')}</Button>
          <Button variant="primary" loading={saving} disabled={blocked || saving} onClick={submit} data-testid="smart-playlist-submit">
            {mode === 'create' ? t('作成') : t('保存')}
          </Button>
        </>
      )}
    >
      <p className="m-0 mb-4 text-xs leading-[18px] text-yt-text-secondary">{t('開くたびに自動で更新されます（手動の変更は保持されません）')}</p>
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Field label={t('プリセット')}>
            <div className="flex flex-wrap gap-2">
              {SMART_PLAYLIST_PRESETS.map(preset => (
                <Chip key={preset.id} selected={presetId === preset.id} onClick={() => choosePreset(preset.id)}>{t(preset.label)}</Chip>
              ))}
              <Chip selected={presetId === ''} onClick={() => choosePreset('')}>{t('カスタム')}</Chip>
            </div>
          </Field>
          <Field label={t('タイトル')} htmlFor={`${ids}-name`}>
            <input id={`${ids}-name`} className={PLAYLIST_FIELD_CLASS} value={name} onChange={event => setName(event.target.value)} placeholder={t('タイトルを入力')} maxLength={150} />
          </Field>
          <Field label={t('再生できる動画')} htmlFor={`${ids}-pv`}>
            <select id={`${ids}-pv`} className={PLAYLIST_FIELD_CLASS} value={rule.pvService ?? 'any'} onChange={event => updateRule({ pvService: event.target.value as SmartPlaylistRule['pvService'] })}>
              <option value="any">{t('すべて')}</option>
              <option value="youtube">YouTube</option>
              <option value="niconico">{t('ニコニコ')}</option>
              <option value="both">{t('両方')}</option>
            </select>
          </Field>
          <Field label={t('公開年')} error={yearError}>
            <div className="flex items-center gap-2">
              <input
                className={PLAYLIST_FIELD_CLASS}
                inputMode="numeric"
                aria-label={t('公開年（から）')}
                aria-invalid={yearError ? true : undefined}
                value={rule.publishYearFrom ?? ''}
                onChange={event => updateRule({ publishYearFrom: event.target.value.replace(/\D/g, '').slice(0, 4) })}
                placeholder="2020"
              />
              {rangeSeparator}
              <input
                className={PLAYLIST_FIELD_CLASS}
                inputMode="numeric"
                aria-label={t('公開年（まで）')}
                aria-invalid={yearError ? true : undefined}
                value={rule.publishYearTo ?? ''}
                onChange={event => updateRule({ publishYearTo: event.target.value.replace(/\D/g, '').slice(0, 4) })}
                placeholder="2026"
              />
            </div>
          </Field>
          <Field label={t('ボカロP')} htmlFor={rule.producerId ? undefined : `${ids}-producer`}>
            {rule.producerId ? (
              <RemovableChip
                label={rule.producerName || `ID: ${rule.producerId}`}
                onRemove={() => updateRule({ producerId: undefined, producerName: undefined })}
              />
            ) : (
              <>
                <input
                  id={`${ids}-producer`}
                  type="search"
                  className={PLAYLIST_FIELD_CLASS}
                  placeholder={t('ボカロPを検索')}
                  value={producerQuery}
                  onChange={event => { setProducerQuery(event.target.value); setProducers([]); setProducerError(false); }}
                />
                {producers.length > 0 && (
                  <ul className="m-0 mt-1 max-h-48 list-none overflow-y-auto rounded-chip bg-yt-menu p-0 py-1">
                    {producers.map(producer => (
                      <li key={producer.id}>
                        <button
                          type="button"
                          className="flex min-h-10 w-full cursor-pointer items-center px-3 text-left text-sm text-yt-text hover:bg-yt-tonal"
                          onClick={() => { updateRule({ producerId: producer.id, producerName: producer.name }); setProducerQuery(''); setProducers([]); }}
                        >
                          {producer.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {producerError && <p role="alert" className="m-0 mt-1 text-xs leading-[18px] text-yt-danger">{t('読み込めませんでした')}</p>}
              </>
            )}
          </Field>
          <Switch
            checked={derivedExcluded}
            onChange={() => updateRule({ excludedSongTypes: derivedExcluded ? rule.excludedSongTypes.filter(type => !SMART_DERIVED_SONG_TYPES.includes(type)) : Array.from(new Set([...rule.excludedSongTypes, ...SMART_DERIVED_SONG_TYPES])) })}
            label={t('カバー・派生曲を除外')}
            className="min-h-10"
          />
          <details open={initialHasAdvanced || undefined} className="group/details">
            <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1 text-sm font-medium text-yt-text [&::-webkit-details-marker]:hidden">
              <ChevronDownIcon size={20} className="-rotate-90 transition-transform duration-150 group-open/details:rotate-0" />
              {t('詳細な条件')}
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Field label={t('YouTube 再生数（以上）')} htmlFor={`${ids}-yt`}>
                <input id={`${ids}-yt`} className={PLAYLIST_FIELD_CLASS} type="number" min={0} step={1000} placeholder={t('指定なし')} value={viewsValue(rule.minYoutubeViews)} onChange={event => updateRule({ minYoutubeViews: Math.max(0, Number(event.target.value) || 0) })} />
              </Field>
              <Field label={t('ニコニコ 再生数（以上）')} htmlFor={`${ids}-nico`}>
                <input id={`${ids}-nico`} className={PLAYLIST_FIELD_CLASS} type="number" min={0} step={1000} placeholder={t('指定なし')} value={viewsValue(rule.minNicoViews)} onChange={event => updateRule({ minNicoViews: Math.max(0, Number(event.target.value) || 0) })} />
              </Field>
              <div className="col-span-2">
                <Field label={t('長さ（秒）')} error={lengthError}>
                  <div className="flex items-center gap-2">
                    <input className={PLAYLIST_FIELD_CLASS} inputMode="numeric" aria-label={t('長さの最小（秒）')} aria-invalid={lengthError ? true : undefined} value={rule.lengthMinSeconds ?? ''} onChange={event => updateRule({ lengthMinSeconds: event.target.value.replace(/\D/g, '') })} placeholder="60" />
                    {rangeSeparator}
                    <input className={PLAYLIST_FIELD_CLASS} inputMode="numeric" aria-label={t('長さの最大（秒）')} aria-invalid={lengthError ? true : undefined} value={rule.lengthMaxSeconds ?? ''} onChange={event => updateRule({ lengthMaxSeconds: event.target.value.replace(/\D/g, '') })} placeholder="360" />
                  </div>
                </Field>
              </div>
              <div className="col-span-2">
                {/* Same words as 詳細検索 (音響解析: 指定なし / 解析済み / 未解析). */}
                <Field label={t('音響解析')} htmlFor={`${ids}-audio`}>
                  <select id={`${ids}-audio`} className={PLAYLIST_FIELD_CLASS} value={rule.audioComputed ?? 'any'} onChange={event => updateRule({ audioComputed: event.target.value as SmartPlaylistRule['audioComputed'] })}>
                    <option value="any">{t('指定なし')}</option>
                    <option value="yes">{t('解析済み')}</option>
                    <option value="no">{t('未解析')}</option>
                  </select>
                </Field>
              </div>
            </div>
          </details>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('曲数')} htmlFor={`${ids}-max`}>
              <select id={`${ids}-max`} className={PLAYLIST_FIELD_CLASS} value={rule.maxSongs ?? 200} onChange={event => updateRule({ maxSongs: (event.target.value === 'all' ? 'all' : Number(event.target.value)) as SmartPlaylistRule['maxSongs'] })}>
                {SMART_PLAYLIST_MAX_SONGS.map(value => <option key={value} value={value}>{value === 'all' ? t('全曲') : t('{count}曲', { count: value })}</option>)}
              </select>
            </Field>
            <Field label={t('並び順')} htmlFor={`${ids}-sort`}>
              <select id={`${ids}-sort`} className={PLAYLIST_FIELD_CLASS} value={rule.sortBy ?? 'FavoritedTimes'} onChange={event => updateRule({ sortBy: event.target.value as SmartPlaylistRule['sortBy'] })}>
                {SMART_PLAYLIST_SORTS.map(option => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
              </select>
            </Field>
          </div>
          {mobile && !validation && preview.state === 'empty' && (
            <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm leading-5 text-yt-text">
              <input type="checkbox" checked={allowEmpty} onChange={event => setAllowEmpty(event.target.checked)} className="size-4 accent-yt-link" />
              {t('0曲でも保存する')}
            </label>
          )}
        </div>

        {!mobile && (
          <section
            aria-labelledby={`${ids}-preview`}
            aria-live="polite"
            aria-busy={preview.state === 'loading' && !validation}
            className={cx('min-w-0 self-start rounded-card bg-yt-tonal p-4 md:sticky md:top-20')}
          >
            <h3 id={`${ids}-preview`} className="m-0 mb-2 text-sm font-medium leading-5 text-yt-text">{t('プレビュー')}</h3>
            {previewBody ?? <p className="m-0 text-sm leading-5 text-yt-text-secondary">—</p>}
          </section>
        )}
      </div>
    </Dialog>
  );
}
