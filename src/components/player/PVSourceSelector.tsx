import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { getPVServiceLabel } from '../../utils/pvService';
import { isPlayablePV } from '../../utils/playablePV';

interface PVSourceSelectorProps {
  song?: Song | null;
  compact?: boolean;
}

function labelForPV(pv: NonNullable<Song['pvs']>[number]): string {
  const type = pv.pvType === 'Original' ? '公式' : pv.pvType === 'Reprint' ? '再投稿' : 'その他';
  return `${getPVServiceLabel(pv.service)}・${type}${pv.name ? `: ${pv.name}` : ''}`;
}

export default function PVSourceSelector({ song, compact = false }: PVSourceSelectorProps) {
  const currentSong = usePlayerStore(state => state.currentSong);
  const currentPV = usePlayerStore(state => state.currentPV);
  const selectPV = usePlayerStore(state => state.selectPV);
  const targetSong = song ?? currentSong;
  const playablePVs = targetSong?.pvs?.filter(isPlayablePV) ?? [];

  if (!targetSong || playablePVs.length < 2 || currentSong?.id !== targetSong.id) return null;

  const currentKey = currentPV ? `${currentPV.service}:${currentPV.pvId || currentPV.id}` : '';
  return (
    <label className={compact ? 'inline-flex min-w-0 items-center' : 'flex min-w-0 items-center gap-2'}>
      {!compact && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>再生PV</span>}
      <span className={`relative min-w-0 ${compact ? 'w-[min(20rem,42vw)] max-w-[20rem]' : 'w-full max-w-[32rem]'}`}>
        <select
          className="input w-full min-w-0 appearance-none truncate pr-10 text-xs"
          value={currentKey}
          onChange={event => {
            const next = playablePVs.find(pv => `${pv.service}:${pv.pvId || pv.id}` === event.target.value);
            if (next) selectPV(next);
          }}
          aria-label="再生PVを選択"
          style={{
            color: 'var(--color-text-primary)',
            background: 'var(--color-bg-secondary)',
            colorScheme: 'dark',
          }}
        >
          {playablePVs.map(pv => (
            <option
              key={`${pv.service}:${pv.pvId || pv.id}`}
              value={`${pv.service}:${pv.pvId || pv.id}`}
              style={{ background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)' }}
            >
              {labelForPV(pv)}
            </option>
          ))}
        </select>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 flex w-9 items-center justify-center border-l"
          style={{ color: 'var(--color-text-secondary)', borderColor: 'var(--color-border)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="m7 10 5 5 5-5z" />
          </svg>
        </span>
      </span>
    </label>
  );
}
