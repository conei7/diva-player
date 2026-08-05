import assert from 'node:assert/strict';
import { collectRecommendationViolations, evaluateRecommendationHistory } from './check-recommendation-history.mjs';

function report({ artistShare = 0.2, latency = 500 } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    seedProducerShare: 0.1,
    health: { discoveryQuality: { ok: true }, audioFeatures: { ok: true } },
    seedResults: [{
      group: 'popular', counts: {
        '/api/recommend': 20, '/api/recommend/metadata': 20, '/api/recommend/audio': 20,
      },
    }],
    latency: { p95Ms: latency, maximumMs: 4000, endpoints: { '/api/recommend': { p95Ms: latency } } },
    dig: { latencyMs: 500, generationOverlap: 0.2, maxProducerShare: 0.2 },
    quality: {
      maxModeOverlap: 0.2,
      thresholds: {
        maxArtistShare: 0.5, maxProducerShare: 0.5, maxVocalistShare: 0.5,
        maxSeedOverlap: 0.8, maxModeOverlap: 0.8, minUniqueRatio: 0.2,
        minHybridMinorShare: 0.2, maxHybridMinorShare: 0.8, maxSeedProducerShare: 0.5,
      },
      endpoints: [{
        endpoint: '/api/recommend', maxArtistShare: artistShare, maxProducerShare: 0.2,
        maxVocalistShare: 0.2, maxSeedOverlap: 0.2, uniqueRatio: 0.8,
        minorShare: 0.4, groupMetadataCoverage: 1,
      }],
    },
  };
}

assert.deepEqual(collectRecommendationViolations(report()), []);
assert.equal(evaluateRecommendationHistory([report(), report({ artistShare: 0.8 })]).status, 'warning');
const sustained = evaluateRecommendationHistory([report({ artistShare: 0.7 }), report({ artistShare: 0.8 })]);
assert.equal(sustained.status, 'critical');
assert.deepEqual(sustained.sustainedViolations.map(item => item.id), ['quality./api/recommend.artistShare']);
assert.equal(evaluateRecommendationHistory([report({ latency: 5000 }), report()]).status, 'healthy');
const unavailable = report();
unavailable.seedResults[0].counts['/api/recommend/metadata'] = 0;
assert.deepEqual(
  collectRecommendationViolations(unavailable).map(item => item.id),
  ['availability./api/recommend/metadata'],
);
console.log('PASS recommendation history sustained-deviation evaluation');
