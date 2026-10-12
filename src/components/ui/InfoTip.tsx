import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import IconButton from './IconButton';
import Popover from './Popover';
import { InfoIcon } from './icons';

export interface InfoTipProps {
  /** Tooltip / aria-label of the ⓘ button and label of the popover. */
  label: string;
  /** The explanation (14px/20px, max 320px wide). This is where descriptions live. */
  children: ReactNode;
  /** Default 'bottom-start'. */
  placement?: 'bottom-start' | 'bottom-end';
}

/**
 * ⓘ icon button (32px) that toggles a popover with the explanation. Opening moves focus to the
 * popover (its text is read out); Esc / Tab return to the ⓘ.
 */
export function InfoTip({ label, children, placement = 'bottom-start' }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  return (
    <>
      <IconButton
        ref={anchorRef}
        size="sm"
        label={label}
        icon={<InfoIcon size={20} />}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={event => {
          // An ⓘ inside a clickable card or row must not also activate it.
          event.stopPropagation();
          setOpen(previous => !previous);
        }}
      />
      <Popover anchor={anchorRef} open={open} onClose={() => setOpen(false)} placement={placement} label={label} id={popoverId}>
        <div className="max-w-[320px] text-sm leading-5 font-normal text-yt-text">{children}</div>
      </Popover>
    </>
  );
}

export default InfoTip;
