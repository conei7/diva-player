import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export default function PlaylistPopoverMenu({ trigger, children, align = 'right' }: {
  trigger: ReactNode; children: ReactNode; align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !menu.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(align === 'right' ? rect.right - bounds.width : rect.left, innerWidth - bounds.width - 8)),
      top: Math.max(8, rect.bottom + bounds.height + 8 <= innerHeight ? rect.bottom + 6 : rect.top - bounds.height - 6),
    });
    menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const close = () => setOpen(false);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); setOpen(false); anchor.current?.querySelector('button')?.focus();
      }
      if (event.key === 'Tab') setOpen(false);
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  return (
    <div ref={anchor} className="relative shrink-0">
      {isValidElement<{ onClick?: () => void; 'aria-expanded'?: boolean; 'aria-haspopup'?: 'menu' }>(trigger)
        ? cloneElement(trigger, { onClick: () => setOpen(value => !value), 'aria-expanded': open, 'aria-haspopup': 'menu' }) : trigger}
      {open && createPortal(
        <div ref={menu} role="menu" style={position}
          className="fixed z-[65] max-h-[calc(100dvh-1rem)] w-60 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-white/15 bg-neutral-950 p-1.5 shadow-2xl shadow-black/60"
          onClick={() => { anchor.current?.querySelector('button')?.focus(); setOpen(false); }}>
          {children}
        </div>, document.body,
      )}
    </div>
  );
}
