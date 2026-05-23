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

    // 初期化時
    updateRect();

    // ResizeObserverでサイズ変更を監視
    const observer = new ResizeObserver(() => {
      animationFrameId = requestAnimationFrame(updateRect);
    });
    observer.observe(ref.current);
    
    // ウィンドウリサイズ時
    const handleResize = () => {
      animationFrameId = requestAnimationFrame(updateRect);
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
