import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { cx } from '../ui/overlay';
import { VIDEO_FRAME_CLASS } from './videoFrame';

/**
 * VideoPlayer - 16:9 の動画枠（プレースホルダー）
 *
 * 実際の iframe (PlayerEmbed) は App 直下の GlobalPlayer に常駐している。
 * この枠はページ上の位置と大きさを測って setPlayerRect で渡し、
 * GlobalPlayer がそこにぴったり重なる（iframe を外したり隠したりしない）。
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
    // 選択バーの表示中は、この領域の padding-top（--selection-bar-height）だけが
    // 変わるので、border-box で見張る（content-box では padding の変化に気付かない）。
    const observer = new ResizeObserver(() => {
      scheduleUpdate();
    });
    observer.observe(ref.current);
    const backendStatusLayout = document.querySelector<HTMLElement>(
      '[data-testid="backend-status-layout"]',
    );
    if (backendStatusLayout) observer.observe(backendStatusLayout, { box: 'border-box' });

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

  return <div ref={ref} className={cx(VIDEO_FRAME_CLASS, 'bg-black')} />;
}
