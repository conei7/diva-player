import { useEffect, useRef, useState } from 'react';
import {
  createFullBackup,
  downloadFullBackup,
  executeFullBackupImport,
  getCurrentBackupCounts,
  parseFullBackup,
  readCurrentBackupCounts,
  type FullBackupCounts,
  type FullBackupPreview,
} from '../../services/fullBackup';

interface BackupModalProps {
  isOpen: boolean;
  onBack: () => void;
  onClose: () => void;
}

const countItems = [
  ['historyEvents', '履歴'],
  ['ratingCount', '評価'],
  ['playlistCount', 'プレイリスト'],
  ['playlistSongCount', '登録曲'],
  ['folderCount', 'フォルダ'],
  ['favoriteProducerCount', 'お気に入りP'],
  ['hiddenSongCount', '表示しない曲'],
] as const;

function BackupCounts({ counts, prefix }: { counts: FullBackupCounts; prefix: string }) {
  return (
    <div className="backup-count-grid" aria-label={`${prefix}のデータ件数`}>
      {countItems.map(([key, label]) => (
        <div key={key} className="backup-count-card">
          <span>{label}</span>
          <strong>{counts[key].toLocaleString()}</strong>
        </div>
      ))}
    </div>
  );
}

function previewCounts(preview: FullBackupPreview): FullBackupCounts {
  return {
    historyEvents: preview.historyCount,
    ratingCount: preview.ratingCount,
    playlistCount: preview.playlistCount,
    playlistSongCount: preview.playlistSongCount,
    folderCount: preview.folderCount,
    favoriteProducerCount: preview.favoriteProducerCount,
    hiddenSongCount: preview.hiddenSongCount,
  };
}

export default function BackupModal({ isOpen, onBack, onClose }: BackupModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<FullBackupPreview | null>(null);
  const [currentCounts, setCurrentCounts] = useState<FullBackupCounts | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [ratingPriority, setRatingPriority] = useState<'backup' | 'current'>('backup');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    backButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const exportBackup = async () => {
    setBusy(true);
    setMessage('バックアップを作成中…');
    try {
      const payload = await createFullBackup();
      downloadFullBackup(payload);
      setCurrentCounts(getCurrentBackupCounts(payload));
      setMessage('完全バックアップを保存しました。');
    } catch (error) {
      console.error(error);
      setMessage('バックアップの作成に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const readBackup = (file: File) => {
    setBusy(true);
    setMessage('ファイルを確認中…');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseFullBackup(JSON.parse(String(reader.result)));
        setPreview(parsed);
        setCurrentCounts(null);
        setMode('merge');
        setRatingPriority('backup');
        if (parsed) {
          void readCurrentBackupCounts().then(setCurrentCounts).catch(error => {
            console.error('[FullBackup] Current count read failed', error);
          });
        }
        setMessage(parsed ? '内容と復元方法を確認してください。' : 'DIVA Playerの対応バックアップではありません。');
      } catch {
        setPreview(null);
        setMessage('JSONファイルを読み込めませんでした。');
      } finally {
        setBusy(false);
      }
    };
    reader.onerror = () => {
      setBusy(false);
      setMessage('ファイルを読み込めませんでした。');
    };
    reader.readAsText(file);
  };

  const importBackup = async () => {
    if (!preview) return;
    if (mode === 'replace' && !window.confirm('現在の履歴・評価・プレイリスト・表示しない曲をバックアップの内容へ置き換えます。続行しますか？')) return;
    setBusy(true);
    setMessage('復元中…');
    try {
      const result = await executeFullBackupImport(preview, { mode, ratingPriority });
      setPreview(null);
      setCurrentCounts(result.after);
      setMessage(mode === 'replace' ? 'バックアップの内容へ置き換えました。' : 'バックアップを現在のデータへ追加しました。');
    } catch (error) {
      console.error(error);
      setMessage('復元に失敗しました。現在のデータは維持されています。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="データとバックアップ">
      <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label="閉じる" onClick={onClose} />
      <div className="backup-modal-shell">
        <div className="backup-modal-header">
          <button ref={backButtonRef} type="button" className="backup-back-button" onClick={onBack}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
            設定に戻る
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold" style={{ color: 'var(--color-text-primary)' }}>データとバックアップ</h2>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>端末内のデータを保存・復元します</p>
          </div>
          <button type="button" className="btn-ghost rounded-full w-10 h-10 flex items-center justify-center" onClick={onClose} aria-label="閉じる">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
          </button>
        </div>

        <div className="backup-modal-content">
          <div className="backup-intro">
            <span className="backup-version-badge">完全バックアップ v6</span>
            <h3>履歴から設定まで、ひとつのファイルに保存</h3>
            <p>履歴・評価・プレイリスト・フォルダ・お気に入りP・表示しない曲・表示設定をJSONにまとめます。音声や動画ファイルは含みません。</p>
          </div>

          <div className="backup-flow-grid">
            <section className="settings-section backup-action-section" aria-labelledby="backup-export-title">
              <div className="backup-step-number">1</div>
              <div>
                <h3 id="backup-export-title" className="setting-row-title">この端末のデータを保存</h3>
                <p className="setting-row-desc mt-1">定期的に保存しておくと、ブラウザ変更や端末移行時にも復元できます。</p>
              </div>
              <button type="button" className="btn-primary w-full mt-auto" disabled={busy} onClick={() => void exportBackup()}>
                完全バックアップを保存
              </button>
            </section>

            <section className="settings-section backup-action-section" aria-labelledby="backup-import-title">
              <div className="backup-step-number">2</div>
              <div>
                <h3 id="backup-import-title" className="setting-row-title">保存済みファイルから復元</h3>
                <p className="setting-row-desc mt-1">ファイルを選んだ後、件数と復元方法を確認してから反映します。</p>
              </div>
              <input ref={inputRef} className="hidden" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) readBackup(file); }} />
              <button type="button" className="btn-secondary w-full mt-auto" disabled={busy} onClick={() => inputRef.current?.click()}>
                バックアップファイルを選択
              </button>
            </section>
          </div>

          {preview && (
            <section className="backup-preview" aria-labelledby="backup-preview-title">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="backup-version-badge">復元前の確認</span>
                  <h3 id="backup-preview-title" className="text-sm font-semibold mt-2" style={{ color: 'var(--color-text-primary)' }}>バックアップに含まれるデータ</h3>
                </div>
                <span className={`backup-validation-badge ${preview.canRestore ? 'is-valid' : 'is-invalid'}`}>
                  {preview.canRestore ? '検証済み' : '復元不可'}
                </span>
              </div>

              <BackupCounts counts={previewCounts(preview)} prefix="バックアップ" />
              {currentCounts && (
                <details className="backup-current-details">
                  <summary>現在の端末データと比較</summary>
                  <BackupCounts counts={currentCounts} prefix="現在" />
                </details>
              )}

              {(preview.validationMessages.length > 0 || preview.invalidItems > 0) && (
                <div className="backup-warning-list" role="alert">
                  {preview.validationMessages.map(item => <p key={item}>{item}</p>)}
                  {preview.invalidItems > 0 && <p>無効な項目 {preview.invalidItems.toLocaleString()}件は除外されます。</p>}
                </div>
              )}

              <fieldset className="mt-4">
                <legend className="settings-section-title">復元方法</legend>
                <div className="backup-option-grid">
                  <label className="backup-option" data-active={mode === 'merge'}>
                    <input type="radio" name="backup-mode" value="merge" checked={mode === 'merge'} onChange={() => setMode('merge')} />
                    <span><strong>現在のデータへ追加</strong><small>おすすめ。重複を整理しながら統合します</small></span>
                  </label>
                  <label className="backup-option is-danger" data-active={mode === 'replace'}>
                    <input type="radio" name="backup-mode" value="replace" checked={mode === 'replace'} onChange={() => setMode('replace')} />
                    <span><strong>すべて置き換える</strong><small>現在の対象データを削除して復元します</small></span>
                  </label>
                </div>
              </fieldset>

              {mode === 'merge' && (
                <fieldset className="mt-4">
                  <legend className="settings-section-title">同じ曲の評価がある場合</legend>
                  <div className="ui-segmented w-full">
                    <button type="button" data-active={ratingPriority === 'backup'} onClick={() => setRatingPriority('backup')}>バックアップを優先</button>
                    <button type="button" data-active={ratingPriority === 'current'} onClick={() => setRatingPriority('current')}>現在の評価を優先</button>
                  </div>
                </fieldset>
              )}

              <button type="button" className="btn-primary mt-4 w-full" disabled={busy || !preview.canRestore} onClick={() => void importBackup()}>
                {mode === 'replace' ? '確認して置き換える' : '現在のデータへ追加する'}
              </button>
            </section>
          )}

          {currentCounts && !preview && (
            <section className="settings-section" aria-label="現在のデータ件数">
              <div className="settings-section-title">現在のデータ</div>
              <BackupCounts counts={currentCounts} prefix="現在" />
            </section>
          )}

          {message && <p className="backup-status" role="status" aria-live="polite">{message}</p>}
        </div>
      </div>
    </div>
  );
}
