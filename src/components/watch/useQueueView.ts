import { useMemo } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { buildQueueView } from './queueView';
import { getQueuePosition } from '../player/playerUi';

/** The current queue and what the panel / drawer show for it. */
export function useQueueView() {
  const queue = usePlayerStore(state => state.queue);
  const queueIndex = usePlayerStore(state => state.queueIndex);
  const queueSources = usePlayerStore(state => state.queueSources);
  const queueTitle = usePlayerStore(state => state.queueTitle);
  const restoring = usePlayerStore(state => state.restoringQueueWindow);
  const view = useMemo(
    () => {
      if (!restoring) return buildQueueView(queue, queueIndex, queueSources, queueTitle);
      const partial = buildQueueView(restoring.songs, queueIndex - restoring.offset,
        queueSources.slice(restoring.offset), queueTitle);
      const entries = partial.entries.map(entry => ({ ...entry, index: entry.index + restoring.offset }));
      const position = getQueuePosition(queueSources, queueIndex);
      return { ...partial, entries,
        segments: partial.segments.map(segment => ({ ...segment,
          entries: segment.entries.map(entry => ({ ...entry, index: entry.index + restoring.offset })),
        })),
        position: position ? { current: position.position, total: position.total } : null,
        duplicateCount: 0,
      };
    },
    [queue, queueIndex, queueSources, queueTitle, restoring],
  );
  return { queue: restoring?.songs ?? queue, queueIndex, queueTitle, view };
}
