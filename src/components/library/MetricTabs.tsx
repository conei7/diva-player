import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '../ui/overlay';

export interface MetricTab<K extends string> {
  key: K;
  label: string;
  /** The big number (already formatted). */
  value: string;
  /** Optional 12px line under the number. */
  sub?: ReactNode;
}

export interface MetricTabsProps<K extends string> {
  tabs: MetricTab<K>[];
  selected: K;
  onSelect: (key: K) => void;
  /** aria-label of the tab list. */
  label: string;
  /** Tab ids are `${idPrefix}-${key}`; the chart panel uses aria-labelledby with them. */
  idPrefix: string;
  panelId: string;
}

/** YouTube Studio-style metric tabs: label, a 24px number and a 2px underline on the selected one. */
export default function MetricTabs<K extends string>({ tabs, selected, onSelect, label, idPrefix, panelId }: MetricTabsProps<K>) {
  const buttons = useRef(new Map<K, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    // The arrows belong to the tabs here, not to the player's seek shortcut on window.
    event.preventDefault();
    event.stopPropagation();
    const tab = tabs[next];
    onSelect(tab.key);
    buttons.current.get(tab.key)?.focus();
  };

  return (
    <div role="tablist" aria-label={label} className="grid grid-cols-2 border-b border-yt-divider sm:grid-cols-4">
      {tabs.map((tab, index) => {
        const active = tab.key === selected;
        return (
          <button
            key={tab.key}
            ref={element => {
              if (element) buttons.current.set(tab.key, element);
              else buttons.current.delete(tab.key);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-${tab.key}`}
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(tab.key)}
            onKeyDown={event => onKeyDown(event, index)}
            className={cx(
              'relative flex min-h-[88px] min-w-0 cursor-pointer flex-col items-start justify-start gap-1 px-4 py-3 text-left transition-colors duration-150 hover:bg-yt-tonal',
              active ? 'text-yt-text' : 'text-yt-text-secondary',
            )}
          >
            <span className="max-w-full truncate text-sm leading-5 font-medium">{tab.label}</span>
            <span className="max-w-full truncate text-2xl leading-8 font-medium tabular-nums text-yt-text">{tab.value}</span>
            {tab.sub && <span className="max-w-full truncate text-xs leading-4 text-yt-text-secondary tabular-nums">{tab.sub}</span>}
            <span aria-hidden="true" className={cx('absolute inset-x-0 bottom-0 h-0.5', active ? 'bg-yt-text' : 'bg-transparent')} />
          </button>
        );
      })}
    </div>
  );
}
