import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../../stores/playerStore';

/**
 * VideoPlayer - 16:9レスポンシブ YouTube プレイヤーのプレースホルダー
 *
 * 実際の iframe (PlayerEmbed) は Layout.tsx 内の GlobalPlayer に存在します。
 * このコンポーネントは、WatchPage 内でのプレイヤーの表示位置とサイズを計算し、
 * GlobalPlayer がそこにピタリと重なるように指示（setPlayerRect）する役割を持ちます。
 */
export default function VideoPlayer() {
  const { setPlayerRect } = usePlayerStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    
    let animationFrameId: number;
    let lastRectString = '';

    const updateRect = () => {
      if (ref.current) {
        const rect = ref.current.getBoundingClientRect();
        // スクロールしても位置が変わらないよう、ドキュメント全体の絶対座標を計算する
        const absoluteTop = rect.top + window.scrollY;
        const absoluteLeft = rect.left + window.scrollX;
        
        // パフォーマンス最適化のため、変更がある場合のみ更新
        const rectString = `${absoluteTop},${absoluteLeft},${rect.width},${rect.height}`;
        if (rectString !== lastRectString) {
          lastRectString = rectString;
          setPlayerRect({
            top: absoluteTop,
            left: absoluteLeft,
            width: rect.width,
            height: rect.height,
            bottom: absoluteTop + rect.height,
            right: absoluteLeft + rect.width,
            x: absoluteLeft,
            y: absoluteTop,
            toJSON: () => {}
          } as DOMRect);
        }
      }
    };

    const scheduleUpdate = () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      animationFrameId = requestAnimationFrame(updateRect);
    };

    // 初期化時
    updateRect();

    // VideoPlayer自身だけでなく、ページ上部の接続状態バナーを含む
    // レイアウト領域も監視する。バナーは通常フロー内で表示・非表示が
    // 切り替わるため、親の高さが変わった後に確定した位置を再計測する。
    const observer = new ResizeObserver(() => {
      scheduleUpdate();
    });
    observer.observe(ref.current);
    const backendStatusLayout = document.querySelector<HTMLElement>(
      '[data-testid="backend-status-layout"]',
    );
    if (backendStatusLayout) observer.observe(backendStatusLayout);
    
    // ウィンドウリサイズ時
    const handleResize = () => {
      scheduleUpdate();
    };
    
    window.addEventListener('resize', handleResize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      setPlayerRect(null);
    };
  }, [setPlayerRect]);

  return (
    <div 
      ref={ref} 
      className="video-player-wrapper" 
      style={{ borderRadius: '12px', background: 'transparent' }} 
    />
  );
}
