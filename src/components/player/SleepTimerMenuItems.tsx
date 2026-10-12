import { useTranslate, useTranslateSourceText } from '../../i18n';
import { SLEEP_TIMER_OPTIONS, useSleepTimerStore } from '../../stores/sleepTimerStore';
import { MenuItemRadio, MenuLabel } from '../ui/Menu';
import { formatRemainingClock, getSleepTimerChoice } from './playerUi';
import { useSleepTimerRemaining } from './useSleepTimerRemaining';

/**
 * The sleep timer group for a ⋮ menu (mini player, song page): a label with the remaining time,
 * then 「オフ」「15分」「30分」「60分」「90分」 as radios. Renders only while the menu is open.
 * The always-mounted SleepTimerWatcher (SleepTimer.tsx) records which option started each
 * deadline, so every menu shows the same checked option.
 */
export default function SleepTimerMenuItems() {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const until = useSleepTimerStore(state => state.until);
  const start = useSleepTimerStore(state => state.start);
  const clear = useSleepTimerStore(state => state.clear);
  const remainingMs = useSleepTimerRemaining();
  const active = until !== null && remainingMs > 0;
  const chosen = active ? getSleepTimerChoice(until) : null;

  return (
    <>
      <MenuLabel>
        {t('スリープタイマー')}
        {active && <span className="tabular-nums"> · {t('残り {time}', { time: formatRemainingClock(remainingMs) })}</span>}
      </MenuLabel>
      <MenuItemRadio checked={!active} onSelect={clear}>{t('オフ')}</MenuItemRadio>
      {SLEEP_TIMER_OPTIONS.map(minutes => (
        <MenuItemRadio key={minutes} checked={chosen === minutes} onSelect={() => start(minutes)}>
          {tk('minutes', { count: minutes })}
        </MenuItemRadio>
      ))}
    </>
  );
}
