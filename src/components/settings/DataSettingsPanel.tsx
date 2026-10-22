import { useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Link } from 'react-router';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import {
  createFullBackup,
  downloadFullBackup,
  getCurrentBackupCounts,
  parseFullBackup,
  readCurrentBackupCounts,
} from '../../services/fullBackup';
import type { FullBackupCounts, FullBackupPreview } from '../../services/fullBackup';
import { useHiddenSongStore } from '../../stores/hiddenSongStore';
import { useLanguageStore } from '../../stores/languageStore';
import { showToast } from '../../stores/toastStore';
import { formatCount } from '../../utils/songMeta';
import Button from '../ui/Button';
import { ChevronRightIcon, DownloadIcon, UploadIcon } from '../ui/icons';
import RestoreBackupDialog from './RestoreBackupDialog';
import { SettingsSection } from './settingsControls';
import { useRefocusAfterBusy } from './useRefocusAfterBusy';

const HIDDEN_SONGS_PATH = '/settings/hidden-songs';

interface DataSettingsPanelProps {
  /** ページへのリンク（未適用のフィルターがあれば確認してから閉じる） */
  onLinkClick: (event: MouseEvent<HTMLAnchorElement>, path: string) => void;
}

/** タブ「データ」: バックアップの保存と復元、表示しない曲への入口。 */
export default function DataSettingsPanel({ onLinkClick }: DataSettingsPanelProps) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const ids = useId();
  const language = useLanguageStore(state => state.language);
  const locale = language === 'en' ? 'en-US' : 'ja-JP';
  const hiddenSongCount = useHiddenSongStore(state => Object.keys(state.hiddenSongs).length);
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [counts, setCounts] = useState<FullBackupCounts | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [restore, setRestore] = useState<{ id: number; preview: FullBackupPreview } | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  // 保存中・読み込み中はボタンが押せなくなりフォーカスが外れるので、終わったら（復元ダイアログを閉じたら）戻す
  useRefocusAfterBusy(saveButtonRef, saving);
  useRefocusAfterBusy(restoreButtonRef, reading || restore !== null);

  useEffect(() => {
    let cancelled = false;
    readCurrentBackupCounts()
      .then(next => { if (!cancelled) setCounts(next); })
      .catch(error => console.error('[FullBackup] Current count read failed', error));
    return () => { cancelled = true; };
  }, []);

  const saveBackup = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const payload = await createFullBackup();
      downloadFullBackup(payload);
      setCounts(getCurrentBackupCounts(payload));
      showToast(tk('settingsBackupSaved'));
    } catch (error) {
      console.error('[FullBackup] Export failed', error);
      showToast(tk('settingsBackupSaveFailed'), {
        action: { label: t('再試行'), onAction: () => void saveBackup() },
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const readBackupFile = async (file: File) => {
    setReading(true);
    try {
      const preview = parseFullBackup(JSON.parse(await file.text()));
      if (!preview) throw new Error('Not a supported DIVA Player full backup');
      setRestore({ id: Date.now(), preview });
    } catch (error) {
      console.error('[FullBackup] Backup file could not be read', error);
      showToast(t('バックアップファイルを読み込めませんでした'));
    } finally {
      setReading(false);
    }
  };

  const format = (value: number) => value.toLocaleString(locale);

  return (
    <div>
      <SettingsSection first title={t('バックアップ')} titleId={`${ids}-backup`}>
        <p className="text-xs leading-[18px] text-yt-text-secondary">{t('テーマとアクセントカラーも保存します')}</p>
        <p className="min-h-[18px] text-xs leading-[18px] tabular-nums text-yt-text-secondary">
          {counts && t('履歴 {history} · 評価 {ratings} · プレイリスト {playlists}', {
            history: format(counts.historyEvents),
            ratings: format(counts.ratingCount),
            playlists: format(counts.playlistCount),
          })}
        </p>
        <div className="flex flex-wrap gap-2 pb-4 pt-3">
          <Button
            ref={saveButtonRef}
            size="lg"
            icon={<DownloadIcon />}
            loading={saving}
            className="max-sm:w-full"
            onClick={() => void saveBackup()}
          >
            {saving ? tk('settingsSavingBackup') : tk('settingsSaveBackup')}
          </Button>
          <Button
            ref={restoreButtonRef}
            size="lg"
            icon={<UploadIcon />}
            loading={reading}
            className="max-sm:w-full"
            onClick={() => inputRef.current?.click()}
          >
            {t('ファイルから復元')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            tabIndex={-1}
            aria-hidden="true"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void readBackupFile(file);
            }}
          />
        </div>
      </SettingsSection>

      <div className="border-t border-yt-divider py-2">
        <Link
          to={HIDDEN_SONGS_PATH}
          onClick={event => onLinkClick(event, HIDDEN_SONGS_PATH)}
          className="-mx-3 flex min-h-14 items-center gap-4 rounded-row px-3 text-sm leading-5 text-yt-text no-underline transition-colors duration-150 hover:bg-yt-tonal"
        >
          <span className="min-w-0 flex-1">{t('表示しない曲')}</span>
          <span className="tabular-nums text-yt-text-secondary">{formatCount(hiddenSongCount, 'song', language)}</span>
          <span aria-hidden="true" className="-mr-1 flex text-yt-text-secondary"><ChevronRightIcon size={20} /></span>
        </Link>
      </div>

      <p className="mt-2 text-xs leading-[18px] text-yt-text-disabled">{t('データはこのブラウザに保存されています')}</p>

      {restore && (
        <RestoreBackupDialog
          key={restore.id}
          preview={restore.preview}
          currentCounts={counts}
          onClose={() => setRestore(null)}
          onRestored={after => {
            setCounts(after);
            setRestore(null);
          }}
        />
      )}
    </div>
  );
}
