import { lazy, Suspense, useRef } from 'react';
import { useTranslateSourceText } from '../../i18n';
import { resolveConfirm, useConfirmStore } from '../../stores/confirmStore';
import Button from './Button';

// Loaded with the first confirmation so the app shell's initial bundle stays small.
const Dialog = lazy(() => import('./Dialog'));

/** Shows confirmDialog() requests one at a time (DESIGN_SPEC §4.7). One per app, in App. */
export default function ConfirmHost() {
  const request = useConfirmStore(state => state.requests[0]);
  const t = useTranslateSourceText();
  const cancelRef = useRef<HTMLButtonElement>(null);
  if (!request) return null;

  const answer = (confirmed: boolean) => resolveConfirm(request.id, confirmed);
  return (
    <Suspense fallback={null}>
      <Dialog
        key={request.id}
        open
        onClose={() => answer(false)}
        title={request.title}
        size="sm"
        nested
        hideClose
        initialFocusRef={cancelRef}
        footer={(
          <>
            <Button ref={cancelRef} variant="ghost" onClick={() => answer(false)}>
              {request.cancelLabel ?? t('キャンセル')}
            </Button>
            <Button variant="primary" onClick={() => answer(true)}>
              {request.confirmLabel}
            </Button>
          </>
        )}
      >
        {request.message && <p className="line-clamp-2 text-sm leading-5 text-yt-text-secondary">{request.message}</p>}
      </Dialog>
    </Suspense>
  );
}
