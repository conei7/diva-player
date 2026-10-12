import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslateSourceText } from '../../i18n';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import IconButton from './IconButton';
import { CloseIcon } from './icons';
import { cx, focusElement, getFocusableElements, isImeEvent, useLatest } from './overlay';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';
export type DialogMobileMode = 'center' | 'sheet' | 'fullscreen';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Header h2. Its id becomes aria-labelledby. */
  title?: ReactNode;
  /** When there is no visible title, or a test looks the dialog up by aria-label (e.g. '設定'). */
  ariaLabel?: string;
  /** 400 / 560 / 720 / 880px wide (never wider than the viewport minus 32px). Default 'md'. */
  size?: DialogSize;
  /** How it opens under 640px. Default: 'center' for sm, otherwise 'fullscreen'. */
  mobile?: DialogMobileMode;
  /** Right-aligned buttons in the sticky footer. */
  footer?: ReactNode;
  /** Left-aligned footer content (「すべてクリア」…). */
  footerStart?: ReactNode;
  /** Extra header buttons, left of ×. */
  headerActions?: ReactNode;
  hideClose?: boolean;
  /** Opened on top of another dialog (z-index --z-dialog-nested). */
  nested?: boolean;
  /** Focused when the dialog opens. Default: the first control in the body (then the footer). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Default true. */
  closeOnBackdrop?: boolean;
  bodyClassName?: string;
  /**
   * Extra classes for the panel. To change something the panel already sets, use Tailwind's
   * important modifier, e.g. `sm:max-h-[80vh]!` for the advanced search.
   */
  panelClassName?: string;
  'data-testid'?: string;
  children: ReactNode;
}

const SIZE_CLASS: Record<DialogSize, string> = {
  sm: 'sm:max-w-[400px]',
  md: 'sm:max-w-[560px]',
  lg: 'sm:max-w-[720px]',
  xl: 'sm:max-w-[880px]',
};

/**
 * Open dialogs, oldest first. Esc closes only the newest one. The listener sits on <body> in the
 * bubble phase: controls inside the dialog can still handle Esc first (and preventDefault), and
 * stopping it here keeps page-level Esc handlers (selection mode, shortcuts) from also firing.
 */
const openDialogs: Array<{ element: () => HTMLElement | null; close: () => void }> = [];

function onBodyKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || isImeEvent(event)) return;
  const top = openDialogs.at(-1);
  const own = top?.element();
  if (!top || !own) return;
  // Focus inside another (non-Dialog) modal opened on top: let that one handle its Esc.
  const active = document.activeElement;
  const host = active instanceof Element ? active.closest('[role="dialog"]') : null;
  if (host && host !== own && !own.contains(host)) return;
  event.preventDefault();
  event.stopPropagation();
  top.close();
}

const noop = () => {};
const DIALOG_FOCUS_OPTIONS = { includeToast: true } as const;

/** Modal dialog (DESIGN_SPEC §4.6). Renders nothing while closed. */
export default function Dialog(props: DialogProps) {
  if (!props.open || typeof document === 'undefined') return null;
  return <DialogSurface {...props} />;
}

function DialogSurface({
  onClose,
  title,
  ariaLabel,
  size = 'md',
  mobile = size === 'sm' ? 'center' : 'fullscreen',
  footer,
  footerStart,
  headerActions,
  hideClose = false,
  nested = false,
  initialFocusRef,
  closeOnBackdrop = true,
  bodyClassName,
  panelClassName,
  'data-testid': testId,
  children,
}: DialogProps) {
  const t = useTranslateSourceText();
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const onCloseRef = useLatest(onClose);
  // Captured while rendering, before a child's autoFocus can move focus into the dialog.
  const [returnFocusTo] = useState<Element | null>(() => document.activeElement);

  // Focus trap, Tab wrapping and body scroll lock. Esc is handled by the stack above. A toast raised
  // from inside the dialog (「フィルターを適用しました［元に戻す］」) joins the Tab cycle after the last control.
  useDialogFocus(rootRef, true, noop, DIALOG_FOCUS_OPTIONS);

  useEffect(() => {
    const entry = { element: () => rootRef.current, close: () => onCloseRef.current() };
    openDialogs.push(entry);
    if (openDialogs.length === 1) document.body.addEventListener('keydown', onBodyKeyDown);
    return () => {
      const index = openDialogs.indexOf(entry);
      if (index >= 0) openDialogs.splice(index, 1);
      if (openDialogs.length === 0) document.body.removeEventListener('keydown', onBodyKeyDown);
    };
  }, [onCloseRef]);

  // Initial focus (runs after useDialogFocus, which may have picked the header ×).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const explicit = initialFocusRef?.current;
    if (explicit) {
      focusElement(explicit);
      return;
    }
    const active = document.activeElement;
    // A control that focused itself (autoFocus) wins.
    if (active && active !== root && root.contains(active) && !headerRef.current?.contains(active)) return;
    const target = getFocusableElements(bodyRef.current)[0] ?? getFocusableElements(footerRef.current)[0];
    if (target) focusElement(target);
    // Mount-only: later prop changes must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Return focus to where it was before the dialog opened.
  useEffect(() => () => {
    if (returnFocusTo && returnFocusTo !== document.body) focusElement(returnFocusTo);
  }, [returnFocusTo]);

  const close = () => onCloseRef.current();
  const showHeader = Boolean(title) || Boolean(headerActions) || !hideClose;
  const hasFooter = Boolean(footer) || Boolean(footerStart);
  const fullscreen = mobile === 'fullscreen';
  const sheetHandle = mobile === 'sheet'
    ? <div aria-hidden="true" className="absolute left-1/2 top-2 h-1 w-8 -translate-x-1/2 rounded-full bg-yt-text-disabled sm:hidden" />
    : null;

  return createPortal(
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-label={ariaLabel}
      data-testid={testId}
      tabIndex={-1}
      onPointerDown={event => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={event => {
        const fromBackdrop = pressStartedOnBackdrop.current && event.target === event.currentTarget;
        pressStartedOnBackdrop.current = false;
        if (fromBackdrop && closeOnBackdrop) close();
      }}
      className={cx(
        'fixed inset-0 flex justify-center bg-overlay outline-none',
        nested ? 'z-[var(--z-dialog-nested,80)]' : 'z-[var(--z-dialog,70)]',
        'sm:items-center sm:px-4 sm:py-6',
        mobile === 'center' && 'max-sm:items-center max-sm:p-4',
        mobile === 'sheet' && 'max-sm:items-end',
        fullscreen && 'max-sm:items-stretch',
        'opacity-100 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none',
      )}
    >
      {/* The panel: the only scroll area; header and footer stick inside it.
          data-dialog-panel / -footer: ToastHost places a toast next to them, not over them. */}
      <div
        data-dialog-panel=""
        className={cx(
          'relative flex w-full flex-col overflow-y-auto overscroll-contain bg-yt-raised text-yt-text shadow-[0_8px_40px_rgba(0,0,0,0.5)] outline-none',
          'sm:max-h-[calc(100dvh-48px)] sm:rounded-card',
          SIZE_CLASS[size],
          mobile === 'center' && 'max-sm:max-h-[calc(100dvh-48px)] max-sm:rounded-card',
          mobile === 'sheet' && 'max-sm:max-h-[90dvh] max-sm:origin-bottom max-sm:rounded-t-card',
          fullscreen && 'max-sm:h-dvh max-sm:max-h-dvh',
          'scale-100 opacity-100 transition-[opacity,scale] duration-150 ease-out starting:scale-[0.96] starting:opacity-0 motion-reduce:transition-none',
          panelClassName,
        )}
      >
        {showHeader ? (
          <div
            ref={headerRef}
            className={cx(
              'sticky top-0 z-10 flex min-h-16 shrink-0 items-center gap-2 bg-yt-raised px-6 py-2',
              // The sticky header carries the notch inset so content never scrolls under it.
              fullscreen && 'max-sm:min-h-14 max-sm:px-4 max-sm:pt-[max(8px,env(safe-area-inset-top))]',
              mobile === 'sheet' && 'max-sm:pt-5',
            )}
          >
            {sheetHandle}
            {title
              ? <h2 id={titleId} className="line-clamp-2 min-w-0 flex-1 text-lg font-bold leading-[26px] text-yt-text [overflow-wrap:anywhere]">{title}</h2>
              : <div className="flex-1" />}
            {headerActions && <div className="flex shrink-0 items-center gap-2">{headerActions}</div>}
            {!hideClose && (
              <IconButton
                label={t('閉じる')}
                icon={<CloseIcon />}
                onClick={close}
                className={fullscreen ? 'max-sm:order-first max-sm:-ml-2 sm:-mr-2' : '-mr-2'}
              />
            )}
          </div>
        ) : sheetHandle && <div className="relative h-5 shrink-0">{sheetHandle}</div>}
        <div
          ref={bodyRef}
          className={cx(
            'flex-[1_0_auto] px-6 text-sm leading-5 text-yt-text',
            hasFooter ? 'pb-2' : 'pb-6',
            !showHeader && !sheetHandle && 'pt-6',
            mobile !== 'center' && 'max-sm:px-4',
            bodyClassName,
          )}
        >
          {children}
        </div>
        {hasFooter && (
          <div
            ref={footerRef}
            data-dialog-footer=""
            className={cx(
              'sticky bottom-0 z-10 flex shrink-0 items-center gap-2 bg-yt-raised px-6 py-4',
              mobile !== 'center' && 'max-sm:px-4 max-sm:pb-[max(16px,env(safe-area-inset-bottom))]',
            )}
          >
            {footerStart && <div className="flex min-w-0 items-center gap-2">{footerStart}</div>}
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{footer}</div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
