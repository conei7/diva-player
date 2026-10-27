import { cloneElement, createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactElement, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { getMenuNextIndex } from '../../utils/menuNavigation';
import { CheckIcon } from './iconsChrome';
import {
  captureRemovalFocusFallback,
  cx,
  focusElement,
  getFocusableElements,
  transformOriginFor,
  useAnchoredPosition,
  useBodyScrollLock,
  useLatest,
  useMergedRef,
  useOutsidePointerDown,
  useTransientLayer,
} from './overlay';

/* ─── Menu ──────────────────────────────────────────────────────────────── */

export interface MenuProps {
  /** The button that opens the menu (IconButton / Button). It gets aria-haspopup / aria-expanded. */
  trigger: ReactElement;
  /** Which trigger edge the menu lines up with. Default 'start'. */
  align?: 'start' | 'end';
  /** Accessible name of the menu (usually the trigger's label). */
  label?: string;
  /** Width in px. Default: fits the items (180–320px). */
  width?: number;
  /** Controlled open state (use with onOpenChange). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Under 640px the menu is a bottom sheet. Default true. */
  mobileSheet?: boolean;
  children: ReactNode;
}

interface MenuContextValue {
  close: (options?: { restoreFocus?: boolean }) => void;
  /** Closes the menu, runs the item's action, then keeps focus off <body> if the action removed the trigger. */
  select: (onSelect?: () => void) => void;
  sheet: boolean;
}

/** Second look for actions whose removal lands a little later (an async store update). */
const LATE_REMOVAL_CHECK_MS = 400;

const MenuContext = createContext<MenuContextValue | null>(null);

const ITEM_SELECTOR = '[data-menu-item]';

interface TriggerProps {
  ref?: Ref<HTMLElement>;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  'aria-label'?: string;
  /** IconButton's label (used as the menu's name when `label` is not given). */
  label?: string;
}

function isEnabledItem(element: HTMLElement): boolean {
  return element.getAttribute('aria-disabled') !== 'true' && !(element as HTMLButtonElement).disabled;
}

/**
 * The ⋮ / ▾ menu (DESIGN_SPEC §4.5). Opens below the trigger (above when there is no room),
 * focuses the first item, ↑↓ Home End move, Esc returns to the trigger, Tab / outside press /
 * resize close it. Under 640px it is a bottom sheet.
 */
export default function Menu({
  trigger,
  align = 'start',
  label,
  width,
  open: openProp,
  onOpenChange,
  mobileSheet = true,
  children,
}: MenuProps) {
  const menuId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : uncontrolledOpen;
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusTarget = useRef<'first' | 'last'>('first');
  const onOpenChangeRef = useLatest(onOpenChange);

  const triggerProps = trigger.props as TriggerProps;
  const mergedTriggerRef = useMergedRef<HTMLElement>(triggerProps.ref, triggerRef);

  // Decided once per opening; a width change closes the menu anyway.
  const sheet = useMemo(
    () => open && mobileSheet && typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(max-width: 639px)').matches,
    [mobileSheet, open],
  );

  const setOpen = useCallback((next: boolean) => {
    if (!controlled) setUncontrolledOpen(next);
    onOpenChangeRef.current?.(next);
  }, [controlled, onOpenChangeRef]);

  const close = useCallback(({ restoreFocus = true }: { restoreFocus?: boolean } = {}) => {
    // Focus goes back first so a dialog opened by the selected item remembers the trigger.
    if (restoreFocus) focusElement(triggerRef.current);
    setOpen(false);
  }, [setOpen]);

  const select = useCallback((onSelect?: () => void) => {
    // 「「X」から削除」 / 「表示しない」 remove the row and its ⋮ with it: focus then goes to the next
    // row's ⋮ instead of dropping to <body> (where Space would toggle playback).
    const keepFocusOnPage = captureRemovalFocusFallback(triggerRef.current);
    close();
    void Promise.resolve(onSelect?.()).catch(error => { if (error?.name !== 'PlaylistPersistenceError') console.error('[Menu] Action failed', error); });
    requestAnimationFrame(keepFocusOnPage);
    window.setTimeout(keepFocusOnPage, LATE_REMOVAL_CHECK_MS);
  }, [close]);

  const placement = align === 'end' ? 'bottom-end' : 'bottom-start';
  const position = useAnchoredPosition(triggerRef, menuRef, open && !sheet, placement, 4);
  useTransientLayer(open, () => close());
  useOutsidePointerDown(open && !sheet, [menuRef, triggerRef], () => close({ restoreFocus: false }));
  useBodyScrollLock(open && sheet);

  // Close on a real resize (width change); mobile URL-bar height changes are ignored.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const initialWidth = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth !== initialWidth) close({ restoreFocus: false });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [close, open]);

  const getItems = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []).filter(isEnabledItem),
    [],
  );

  // Runs after useAnchoredPosition has placed the menu, so focusing never scrolls the page.
  useLayoutEffect(() => {
    if (!open) return;
    const items = getItems();
    const target = focusTarget.current === 'last' ? items.at(-1) : items[0];
    focusElement(target ?? menuRef.current);
    focusTarget.current = 'first';
  }, [getItems, open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      // Focus the trigger and let the browser move on from there (a dialog's focus trap still sees it).
      close();
      return;
    }
    // Keys pressed in the menu belong to it: the page shortcuts on window (Space / ← →) and key
    // handlers of the trigger's React ancestors must not also act on them. Esc never gets here
    // (useTransientLayer handles it in the capture phase).
    event.stopPropagation();
    const items = getItems();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const row = active?.closest<HTMLElement>(ITEM_SELECTOR) ?? null;
    const index = row ? items.indexOf(row) : -1;
    if (event.key === 'ArrowUp' && index < 0 && items.length > 0) {
      event.preventDefault();
      focusElement(items.at(-1));
      return;
    }
    const next = getMenuNextIndex(event.key, index, items.length);
    if (next !== null) {
      event.preventDefault();
      focusElement(items[next]);
      return;
    }
    if (!row || !active) return;
    if (row.dataset.menuItem === 'content') {
      // A content row (stars etc.): ← → move between the row and the controls inside it,
      // Enter / Space on the row itself step into the first control.
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const stops = [row, ...getFocusableElements(row)];
        const target = stops[stops.indexOf(active) + (event.key === 'ArrowRight' ? 1 : -1)];
        if (target) {
          event.preventDefault();
          focusElement(target);
        }
      } else if (active === row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        focusElement(getFocusableElements(row)[0]);
      }
      return;
    }
    // Buttons and links handle Enter natively and buttons handle Space; links need Space too.
    if (active === row && event.key === ' ' && row.tagName === 'A') {
      event.preventDefault();
      row.click();
    }
  };

  const triggerElement = cloneElement(trigger as ReactElement<TriggerProps & Record<string, unknown>>, {
    ref: mergedTriggerRef,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: (event: MouseEvent<HTMLElement>) => {
      triggerProps.onClick?.(event);
      if (event.defaultPrevented) return;
      focusTarget.current = 'first';
      setOpen(!open);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      triggerProps.onKeyDown?.(event);
      if (event.defaultPrevented || open) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        focusTarget.current = event.key === 'ArrowUp' ? 'last' : 'first';
        setOpen(true);
      }
    },
  });

  const contextValue = useMemo(() => ({ close, select, sheet }), [close, select, sheet]);

  const menu = (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label={label ?? triggerProps['aria-label'] ?? triggerProps.label}
      aria-orientation="vertical"
      // The toast moves above an open bottom sheet (ToastHost looks for this).
      data-menu-sheet={sheet ? '' : undefined}
      tabIndex={-1}
      onKeyDown={onMenuKeyDown}
      // Presses and clicks inside the portal must not reach ancestors in the React tree
      // (clickable cards and rows, long-press selection, the mini player's swipe gesture).
      onPointerDown={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      style={sheet ? undefined : {
        top: position.top,
        left: position.left,
        width: width ? `min(${width}px, calc(100vw - 16px))` : undefined,
        transformOrigin: transformOriginFor(placement, position.side),
      }}
      className={sheet
        ? 'absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-card bg-yt-raised pb-[calc(8px+env(safe-area-inset-bottom))] text-yt-text outline-none'
        : cx(
          'fixed z-[var(--z-menu,90)] max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain rounded-card bg-yt-menu py-2 text-yt-text shadow-[0_4px_32px_rgba(0,0,0,0.5)] outline-none',
          !width && 'w-max min-w-[180px] max-w-[min(320px,calc(100vw-16px))]',
          'scale-100 opacity-100 transition-[opacity,scale] duration-150 ease-out starting:scale-95 starting:opacity-0 motion-reduce:transition-none',
        )}
    >
      {sheet && <div aria-hidden="true" className="mx-auto mb-2 mt-2 h-1 w-8 rounded-full bg-yt-text-disabled" />}
      {children}
    </div>
  );

  return (
    <>
      {triggerElement}
      {open && typeof document !== 'undefined' && createPortal(
        <MenuContext.Provider value={contextValue}>
          {sheet ? (
            <div
              className="fixed inset-0 z-[var(--z-menu,90)] bg-overlay opacity-100 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
              onPointerDown={event => event.stopPropagation()}
              onClick={event => {
                event.stopPropagation();
                if (event.target === event.currentTarget) close();
              }}
            >
              {menu}
            </div>
          ) : menu}
        </MenuContext.Provider>,
        document.body,
      )}
    </>
  );
}

/* ─── Items ─────────────────────────────────────────────────────────────── */

export interface MenuItemProps {
  icon?: ReactNode;
  onSelect?: () => void;
  /** Internal paths use the router (no reload); `external` opens a new tab. */
  href?: string;
  external?: boolean;
  disabled?: boolean;
  /** Grey text at the right end (a shortcut key etc.). */
  hint?: string;
  /**
   * Keep the menu open after selecting. Without `onSelect` the row becomes a content row
   * (a <div>) that may hold its own controls (the star rating); ← → reach them.
   */
  keepOpen?: boolean;
  children: ReactNode;
  'data-testid'?: string;
  className?: string;
  'aria-label'?: string;
  id?: string;
}

export interface MenuItemCheckProps extends MenuItemProps {
  checked: boolean;
}

type ItemRole = 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';

const ICON_SLOT = 'flex size-6 shrink-0 items-center justify-center [&>svg]:size-6';

function MenuItemBase({
  role,
  checked,
  icon,
  onSelect,
  href,
  external = false,
  disabled = false,
  hint,
  keepOpen = false,
  children,
  'data-testid': testId,
  className,
  'aria-label': ariaLabel,
  id,
}: MenuItemProps & { role: ItemRole; checked?: boolean }) {
  const menu = useContext(MenuContext);
  const sheet = menu?.sheet ?? false;
  const contentRow = role === 'menuitem' && keepOpen && !onSelect && !href;

  const rowClass = cx(
    'flex w-full select-none items-center gap-4 px-4 text-left text-sm font-normal leading-5 no-underline outline-none transition-colors duration-150 [-webkit-tap-highlight-color:transparent]',
    sheet ? 'min-h-12' : 'min-h-9',
    disabled
      ? 'cursor-default text-yt-text-disabled'
      : cx('text-yt-text hover:bg-yt-tonal focus-visible:bg-yt-tonal', !contentRow && 'cursor-pointer'),
    contentRow && 'focus-within:bg-yt-tonal',
    className,
  );

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (disabled || event.pointerType !== 'mouse') return;
    const row = event.currentTarget;
    if (!row.contains(document.activeElement)) focusElement(row);
  };

  const onClick = (event: MouseEvent<HTMLElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    if (contentRow) return;
    if (keepOpen || !menu) void Promise.resolve(onSelect?.()).catch(error => { if (error?.name !== 'PlaylistPersistenceError') console.error('[Menu] Action failed', error); });
    else menu.select(onSelect);
  };

  const leading = (
    <>
      {role !== 'menuitem' && (
        <span aria-hidden="true" className={ICON_SLOT}>{checked ? <CheckIcon /> : null}</span>
      )}
      {icon && <span aria-hidden="true" className={ICON_SLOT}>{icon}</span>}
    </>
  );
  const trailing = hint ? <span className="ml-auto shrink-0 pl-2 text-xs leading-4 text-yt-text-secondary">{hint}</span> : null;

  const common = {
    id,
    role,
    'aria-label': ariaLabel,
    'aria-checked': role === 'menuitem' ? undefined : checked,
    'data-testid': testId,
    tabIndex: -1,
    onPointerMove,
    onClick,
  };

  if (contentRow) {
    return (
      <div {...common} data-menu-item="content" aria-disabled={disabled || undefined} className={rowClass}>
        {leading}
        <div className="flex min-w-0 flex-1 items-center">{children}</div>
        {trailing}
      </div>
    );
  }

  const body = (
    <>
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </>
  );

  if (href && !disabled) {
    if (external) {
      return (
        <a {...common} data-menu-item="" href={href} target="_blank" rel="noopener noreferrer" className={rowClass}>
          {body}
        </a>
      );
    }
    return (
      <Link {...common} data-menu-item="" to={href} className={rowClass}>
        {body}
      </Link>
    );
  }

  return (
    <button {...common} type="button" data-menu-item="" disabled={disabled} className={rowClass}>
      {body}
    </button>
  );
}

/** A menu row. Destructive rows keep the same color: put them last, after a divider, with TrashIcon. */
export function MenuItem(props: MenuItemProps) {
  return <MenuItemBase {...props} role="menuitem" />;
}

/** One-of-many choice; shows ✓ in front when checked. */
export function MenuItemRadio(props: MenuItemCheckProps) {
  return <MenuItemBase {...props} role="menuitemradio" />;
}

/** On / off choice; shows ✓ in front when checked. */
export function MenuItemCheckbox(props: MenuItemCheckProps) {
  return <MenuItemBase {...props} role="menuitemcheckbox" />;
}

export function MenuDivider() {
  return <div role="separator" className="my-2 h-px bg-yt-divider" />;
}

/** Small grey heading for a group of items (e.g. 「表示言語」). */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div role="presentation" className="px-4 pb-1 pt-2 text-xs font-medium leading-4 text-yt-text-secondary">{children}</div>;
}

export { Menu };
