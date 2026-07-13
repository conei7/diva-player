import { useState, useRef, useEffect } from 'react';
import { createFullBackup, downloadFullBackup, parseFullBackup, executeFullBackupImport, type FullBackupPreview } from '../../services/fullBackup';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<FullBackupPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState('');
  const [strategyType, setStrategyType] = useState<'merge' | 'replace'>('merge');
  const [ratingPriority, setRatingPriority] = useState<'backup' | 'current'>('backup');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setPreview(null);
      setMessage('');
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleExport = async () => {
    try {
      setExporting(true);
      setMessage('バックアップを作成中...');
      const payload = await createFullBackup();
      downloadFullBackup(payload);
      setMessage('バックアップを保存しました。');
    } catch (e) {
      console.error(e);
      setMessage('バックアップの作成に失敗しました。');
    } finally {
      setExporting(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setMessage('ファイルを読み込み中...');
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string);
        const parsedPreview = parseFullBackup(data);
        if (!parsedPreview) {
          setMessage('無効なバックアップファイルです。');
        } else {
          setPreview(parsedPreview);
          setMessage('');
        }
      } catch {
        setMessage('ファイルのパースに失敗しました。');
      }
    };
    reader.onerror = () => {
      setMessage('ファイルの読み込みに失敗しました。');
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset
  };

  const handleImport = async () => {
    if (!preview) return;
    try {
      setImporting(true);
      setMessage('復元中...');
      await executeFullBackupImport(preview, { type: strategyType, ratingPriority });
      setMessage('復元が完了しました。');
      setPreview(null);
    } catch (e) {
      console.error(e);
      setMessage('復元に失敗しました。既存のデータは保護されました。');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl overflow-hidden glass shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <h2 className="text-lg font-bold">設定・バックアップ</h2>
          <button onClick={onClose} className="p-2 rounded-full btn-ghost" title="閉じる">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          <section className="mb-8">
            <h3 className="text-md font-bold mb-3 border-l-4 pl-2" style={{ borderColor: 'var(--color-accent-cyan)' }}>完全バックアップ</h3>
            <p className="text-sm mb-4" style={{ color: 'var(--color-text-secondary)' }}>
              履歴・評価・すべてのプレイリストを1つのJSONファイルに保存します。
            </p>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="px-4 py-2 rounded-xl text-sm font-bold transition-all"
              style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-primary)' }}
            >
              {exporting ? '作成中...' : 'バックアップをダウンロード'}
            </button>
          </section>

          <section>
            <h3 className="text-md font-bold mb-3 border-l-4 pl-2" style={{ borderColor: 'var(--color-accent-purple)' }}>完全復元</h3>
            
            {!preview ? (
              <>
                <p className="text-sm mb-4" style={{ color: 'var(--color-text-secondary)' }}>
                  完全バックアップファイルを選択してデータを復元します。
                </p>
                <input
                  type="file"
                  accept="application/json"
                  className="hidden"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 rounded-xl text-sm font-bold transition-all"
                  style={{ background: 'var(--color-surface-hover)', color: 'var(--color-text-primary)' }}
                >
                  ファイルを選択...
                </button>
              </>
            ) : (
              <div className="p-4 rounded-xl text-sm" style={{ background: 'rgba(255,255,255,0.05)' }}>
                <h4 className="font-bold mb-2">プレビュー</h4>
                <ul className="mb-4 space-y-1" style={{ color: 'var(--color-text-secondary)' }}>
                  <li>履歴: {preview.historyCount} 件</li>
                  <li>評価: {preview.ratingCount} 件</li>
                  <li>プレイリスト: {preview.playlistCount} 個 ({preview.folderCount} フォルダ)</li>
                  {preview.invalidItems > 0 && <li className="text-red-400">無効項目: {preview.invalidItems} 件 (無視されます)</li>}
                </ul>

                <div className="mb-4">
                  <label className="block text-xs font-bold mb-1">復元方式</label>
                  <select
                    value={strategyType}
                    onChange={(e) => setStrategyType(e.target.value as 'merge' | 'replace')}
                    className="w-full p-2 rounded bg-black/30 border text-sm"
                    style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                  >
                    <option value="merge">安全に既存へマージする (推奨)</option>
                    <option value="replace">完全置換 (既存データをすべて削除)</option>
                  </select>
                </div>

                {strategyType === 'merge' && (
                  <div className="mb-4">
                    <label className="block text-xs font-bold mb-1">評価(星)の衝突解決</label>
                    <select
                      value={ratingPriority}
                      onChange={(e) => setRatingPriority(e.target.value as 'backup' | 'current')}
                      className="w-full p-2 rounded bg-black/30 border text-sm"
                      style={{ borderColor: 'var(--color-border)', color: 'var(--color-text-primary)' }}
                    >
                      <option value="backup">バックアップを優先 (上書き)</option>
                      <option value="current">現在の評価を優先</option>
                    </select>
                  </div>
                )}

                <div className="flex gap-2 mt-4">
                  <button
                    onClick={handleImport}
                    disabled={importing}
                    className="px-4 py-2 rounded-xl text-sm font-bold transition-all flex-1"
                    style={{ background: 'var(--gradient-primary)', color: 'white' }}
                  >
                    {importing ? '復元中...' : (strategyType === 'replace' ? '既存を削除して復元' : 'マージして復元')}
                  </button>
                  <button
                    onClick={() => setPreview(null)}
                    disabled={importing}
                    className="px-4 py-2 rounded-xl text-sm font-bold transition-all"
                    style={{ background: 'var(--color-surface)', color: 'var(--color-text-primary)' }}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </section>

          {message && (
            <div className="mt-6 p-3 rounded-xl text-sm text-center font-medium" style={{ background: 'rgba(255,255,255,0.1)' }}>
              {message}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
