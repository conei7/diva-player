import { Outlet } from 'react-router-dom';
import Header from './Header';
import PlayerBar from './PlayerBar';
import PlayerEmbed from '../player/PlayerEmbed';
import QueueDrawer from '../player/QueueDrawer';
import HistoryDrawer from '../player/HistoryDrawer';
import SongDetailsModal from '../player/SongDetailsModal';
import { usePlayerStore } from '../../stores/playerStore';

/**
 * メインレイアウト
 * Header + Main Content + 固定PlayerBar の3層構造。
 *
 * PlayerEmbed は画面右下のフローティング動画ウィンドウとして常時レンダリング。
 * - display:none は禁止 (YouTube iframe が停止するため)
 * - hiddenMode 時は visibility:hidden で視覚的に隠す (再生は継続)
 */
export default function Layout() {
  const { currentSong, hiddenMode } = usePlayerStore();
  const showVideo = !!currentSong && !hiddenMode;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg-primary)' }}>
      <Header />
      
      <main
        className="flex-1"
        style={{
          paddingTop: 'var(--header-height)',
          paddingBottom: 'calc(var(--player-bar-height) + 16px)',
          overflowX: 'hidden',
        }}
      >
        <div className="w-full px-3 sm:px-5 lg:px-8 py-6">
          <Outlet />
        </div>
      </main>

      {/*
        フローティング動画プレイヤー (YouTube Music の PiP スタイル)
        display:none は使用禁止。visibility:hidden で視覚的に隠す。
        bottom: PlayerBar の高さ分上に配置。
      */}
      <div
        style={{
          position: 'fixed',
          bottom: 'calc(var(--player-bar-height) + 8px)',
          right: '16px',
          width: '240px',
          height: '135px',
          borderRadius: '12px',
          overflow: 'hidden',
          zIndex: 45,
          visibility: showVideo ? 'visible' : 'hidden',
          opacity: showVideo ? 1 : 0,
          transition: 'opacity 0.3s ease, visibility 0.3s ease',
          pointerEvents: showVideo ? 'auto' : 'none',
          boxShadow: showVideo ? '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08)' : 'none',
        }}
      >
        <PlayerEmbed />
      </div>

      <PlayerBar />
      <QueueDrawer />
      <HistoryDrawer />
      <SongDetailsModal />
    </div>
  );
}
