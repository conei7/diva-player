import { describe, expect, it } from 'vitest';
import source from './useAutoQueue.ts?raw';

describe('auto queue request generation contract', () => {
  it('rejects an aborted or stale generation before recording its debug snapshot', () => {
    const finalRanking = source.indexOf('const nextSongs = detailed.ranked.map');
    const finalGuard = source.indexOf(
      'if (controller.signal.aborted || generation !== requestGenerationRef.current) return;',
      finalRanking,
    );
    const snapshot = source.indexOf(
      'useRecommendationDebugStore.getState().recordSnapshot({',
      finalRanking,
    );

    expect(finalRanking).toBeGreaterThanOrEqual(0);
    expect(finalGuard).toBeGreaterThan(finalRanking);
    expect(snapshot).toBeGreaterThan(finalGuard);
  });
});
