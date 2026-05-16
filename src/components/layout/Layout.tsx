import { Outlet } from 'react-router-dom';
import Header from './Header';
import PlayerBar from './PlayerBar';
import PlayerEmbed from '../player/PlayerEmbed';
import QueueSidebar from '../player/QueueSidebar';
import HistoryDrawer from '../player/HistoryDrawer';
import SongDetailsModal from '../player/SongDetailsModal';
import { usePlayerStore } from '../../stores/playerStore';

/**
 * メインレイアウト
 * Header + Main Content + 固定PlayerBar の3層構造。
 *
 * 右サイドバー (デスクトップ):
 *   - 常時 position:fixed で右端にレンダリング (YouTube iframe のアンマウント防止)
 *   - 上部: 動画プレイヤー (320×180px)
 *   - 下部: 再生キュー (常時表示)
 *   - visibility:hidden で隠す (display:none 禁止 → autoplay が切れる)
 *
 * モバイル:
 *   - サイドバーは CSS で非表示 (.sidebar-mobile-hidden)
 *   - iframe は viewport 内に留まるため autoplay 継続
 */
export default function Layout() {
  const { currentSong, hiddenMode } = usePlayerStore();
  const showSidebar = !!currentSong;
  const showVideo = showSidebar && !hiddenMode;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg-primary)' }}>
      <Header />

      {/* メインコンテンツ: デスクトップではサイドバー分 margin-right を確保 */}
      <main
        className={`flex-1 transition-all duration-300 ${showSidebar ? 'lg:mr-80' : ''}`}
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
        右サイドバー: 動画 + 再生キュー
        ─────────────────────────────────────────────────────────
        • 常に position:fixed right:0 に置く → viewport 内に留まる
        • visibility:hidden / opacity:0 で視覚的に隠す (display:none は禁止)
        • モバイルでは .sidebar-mobile-hidden クラスで常に非表示
        • showSidebar=false 時も DOM に存在し続けるため
          PlayerEmbed (YouTube iframe) が再マウントされず再生継続
      */}
      <div
        className="sidebar-mobile-hidden"
        style={{
          position: 'fixed',
          top: 'var(--header-height)',
          right: 0,
          bottom: 'var(--player-bar-height)',
          width: '320px',
          zIndex: 40,
          background: 'var(--color-surface)',
          borderLeft: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          visibility: showSidebar ? 'visible' : 'hidden',
          opacity: showSidebar ? 1 : 0,
          transition: 'opacity 0.3s ease, visibility 0.3s ease',
        }}
      >
        {/* 動画エリア (hiddenMode 時は縮める) */}
        <div
          style={{
            width: '320px',
            height: showVideo ? '180px' : '0px',
            flexShrink: 0,
            background: '#000',
            overflow: 'hidden',
            transition: 'height 0.3s ease',
            // 動画は常に DOM に残す (visibility のみ制御)
            visibility: showSidebar ? 'visible' : 'hidden',
          }}
        >
          <PlayerEmbed />
        </div>

        {/* キューリスト */}
        <div className="flex-1 overflow-hidden">
          <QueueSidebar />
        </div>
      </div>

      <PlayerBar />
      <HistoryDrawer />
      <SongDetailsModal />
    </div>
  );
}

