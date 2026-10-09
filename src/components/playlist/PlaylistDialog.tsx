import { useRef, type ReactNode } from 'react';
import { useDialogFocus } from '../../hooks/useDialogFocus';

/** Shared modal boundary: one scroll area, keyboard containment and focus return. */
export default function PlaylistDialog({ titleId, onClose, children, wide = false }: {
  titleId: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/75 p-3 backdrop-blur-sm sm:p-6" onClick={event => event.target === event.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={`max-h-[calc(100dvh-2rem)] w-full overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-[var(--color-bg-card)] p-5 shadow-2xl sm:p-6 ${wide ? 'max-w-3xl' : 'max-w-lg'}`}>
        {children}
      </div>
    </div>
  );
}
