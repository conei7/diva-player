import { useCallback, useRef, useState } from 'react';

/** Serialize a form's submit and consume errors already reported by the persistence layer. */
export function useAsyncAction() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (action: () => void | Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try { await action(); }
    catch { /* The caller/store provides the error message; keep the form open. */ }
    finally { running.current = false; setBusy(false); }
  }, []);
  return { busy, run };
}
