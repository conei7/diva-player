import { useMemo } from 'react';
import { usePlayerStore } from '../../stores/playerStore';
import { buildQueueView } from './queueView';

/** The current queue and what the panel / drawer show for it. */
export function useQueueView() {
  const queue = usePlayerStore(state => state.queue);
  const queueIndex = usePlayerStore(state => state.queueIndex);
  const queueSources = usePlayerStore(state => state.queueSources);
  const queueTitle = usePlayerStore(state => state.queueTitle);
  const view = useMemo(
    () => buildQueueView(queue, queueIndex, queueSources, queueTitle),
    [queue, queueIndex, queueSources, queueTitle],
  );
  return { queue, queueIndex, queueTitle, view };
}
