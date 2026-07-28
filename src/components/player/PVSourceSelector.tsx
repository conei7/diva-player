import type { Song } from '../../types/vocadb';
import { usePlayerStore } from '../../stores/playerStore';
import { getPVServiceLabel } from '../../utils/pvService';

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
  const playablePVs = targetSong?.pvs?.filter(pv => !pv.disabled && (pv.service === 'Youtube' || pv.service === 'NicoNicoDouga')) ?? [];

  if (!targetSong || playablePVs.length < 2 || currentSong?.id !== targetSong.id) return null;

  const currentKey = currentPV ? `${currentPV.service}:${currentPV.pvId || currentPV.id}` : '';
  return (
    <label className={compact ? 'inline-flex items-center' : 'flex items-center gap-2'}>
      {!compact && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>再生PV</span>}
      <select
        className="input max-w-[14rem] text-xs"
        value={currentKey}
        onChange={event => {
          const next = playablePVs.find(pv => `${pv.service}:${pv.pvId || pv.id}` === event.target.value);
          if (next) selectPV(next);
        }}
        aria-label="再生PVを選択"
      >
        {playablePVs.map(pv => (
          <option key={`${pv.service}:${pv.pvId || pv.id}`} value={`${pv.service}:${pv.pvId || pv.id}`}>
            {labelForPV(pv)}
          </option>
        ))}
      </select>
    </label>
  );
}
