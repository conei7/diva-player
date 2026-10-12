import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * 処理中の Button（`loading`）は disabled になるので、押したボタンからフォーカスが外れて body へ落ちる
 * （キーボードでは押した場所を見失い、重なったダイアログでは次の Tab で後ろのダイアログへ抜ける）。
 * busy が終わった時にフォーカスがどこにも無ければ、そのボタンへ戻す。
 */
export function useRefocusAfterBusy(ref: RefObject<HTMLElement | null>, busy: boolean) {
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus({ preventScroll: true });
  }, [busy, ref]);
}
