import { useEffect, useRef, useState } from 'react';
import {
  createFullBackup,
  downloadFullBackup,
  executeFullBackupImport,
  parseFullBackup,
  type FullBackupPreview,
} from '../../services/fullBackup';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<FullBackupPreview | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [ratingPriority, setRatingPriority] = useState<'backup' | 'current'>('backup');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setPreview(null);
      setMessage('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const exportBackup = async () => {
    setBusy(true);
    setMessage('バックアップを作成中…');
    try {
      downloadFullBackup(await createFullBackup());
      setMessage('バックアップを保存しました。');
    } catch (error) {
      console.error(error);
      setMessage('バックアップの作成に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const readBackup = (file: File) => {
    setBusy(true);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseFullBackup(JSON.parse(String(reader.result)));
        setPreview(parsed);
        setMessage(parsed ? '内容を確認してください。' : '対応していないバックアップです。');
      } catch {
        setPreview(null);
        setMessage('JSONを読み込めませんでした。');
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
    if (mode === 'replace' && !window.confirm('現在の履歴・評価・プレイリストを置き換えます。続行しますか？')) return;
    setBusy(true);
    setMessage('復元中…');
    try {
      await executeFullBackupImport(preview, { mode, ratingPriority });
      setPreview(null);
      setMessage('復元が完了しました。');
    } catch (error) {
      console.error(error);
      setMessage('復元に失敗しました。現在のデータは維持されています。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="設定・バックアップ">
      <button type="button" className="absolute inset-0 bg-black/70" aria-label="閉じる" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-2xl p-5 shadow-2xl" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        <div className="flex items-center justify-between gap-3 mb-5">
          <h2 className="text-lg font-bold">設定・バックアップ</h2>
          <button type="button" className="btn-ghost rounded-lg px-2 py-1" onClick={onClose} aria-label="閉じる">×</button>
        </div>
        <div className="flex flex-col gap-3">
          <button type="button" className="btn-primary w-full" disabled={busy} onClick={() => void exportBackup()}>履歴・評価・プレイリストをバックアップ</button>
          <input ref={inputRef} className="hidden" type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) readBackup(file); }} />
          <button type="button" className="btn-secondary w-full" disabled={busy} onClick={() => inputRef.current?.click()}>完全バックアップを選択</button>
          {preview && (
            <div className="rounded-xl p-3 text-sm" style={{ background: 'var(--color-bg-secondary)' }}>
              <p>履歴 {preview.historyCount.toLocaleString()}件 / 評価 {preview.ratingCount.toLocaleString()}件 / プレイリスト {preview.playlistCount.toLocaleString()}件 / フォルダ {preview.folderCount.toLocaleString()}件</p>
              {preview.invalidItems > 0 && <p className="mt-1 text-amber-300">無効項目 {preview.invalidItems}件を除外</p>}
              <div className="flex flex-wrap gap-3 mt-3">
                <label><input type="radio" checked={mode === 'merge'} onChange={() => setMode('merge')} /> 追加</label>
                <label><input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> 置換</label>
              </div>
              {mode === 'merge' && (
                <div className="flex flex-wrap gap-3 mt-2">
                  <span>評価の優先:</span>
                  <label><input type="radio" checked={ratingPriority === 'backup'} onChange={() => setRatingPriority('backup')} /> バックアップ</label>
                  <label><input type="radio" checked={ratingPriority === 'current'} onChange={() => setRatingPriority('current')} /> 現在</label>
                </div>
              )}
              <button type="button" className="btn-primary mt-3 w-full" disabled={busy} onClick={() => void importBackup()}>この内容を復元</button>
            </div>
          )}
          {message && <p className="text-sm text-center" role="status">{message}</p>}
        </div>
      </div>
    </div>
  );
}
