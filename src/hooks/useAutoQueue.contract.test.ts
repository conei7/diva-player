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

  it('records recommendation evidence only after the atomic playback guard accepts the append', () => {
    const append = source.indexOf('const appendApplied = addManyToQueue(');
    const rejected = source.indexOf('if (!appendApplied) return;', append);
    const snapshot = source.indexOf(
      'useRecommendationDebugStore.getState().recordSnapshot({',
      append,
    );
    const metadata = source.indexOf('const metadata = buildRecommendationMetadata(', append);
    const decisions = source.indexOf(
      'useAutoQueueDecisionStore.getState().recordDecisions(metadata.decisions);',
      append,
    );

    expect(append).toBeGreaterThanOrEqual(0);
    expect(rejected).toBeGreaterThan(append);
    expect(snapshot).toBeGreaterThan(rejected);
    expect(metadata).toBeGreaterThan(snapshot);
    expect(decisions).toBeGreaterThan(metadata);
  });

  it('loads root-vector and root-producer evidence without fixed discovery slots', () => {
    expect(source).toContain('getSimilarSongs(anchorSong.id');
    expect(source).toContain('getSongsByProducerFromBackend(anchorSong.id');
    expect(source).toContain('rootVector: orderedFilteredSongs(rootVectorCandidates)');
    expect(source).toContain('rootProducer: orderedFilteredSongs(rootProducerCandidates)');
    expect(source).not.toContain('targetKnown:');
    expect(source).not.toContain('targetUnknown:');
  });
});
