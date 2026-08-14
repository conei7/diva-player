import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertRecommendationReport,
  buildSeedEndpointDiagnostics,
  persistAndAssertRecommendationReport,
} from './test-recommendation-regression.mjs';

const endpoints = ['/api/recommend', '/api/recommend/metadata', '/api/recommend/audio'];

function passingReport() {
  return {
    generatedAt: '2026-08-11T00:00:00.000Z',
    seedProducerShare: 0.1,
    seedResults: [{
      id: 1501,
      group: 'popular',
      audioComputed: true,
      counts: Object.fromEntries(endpoints.map(endpoint => [endpoint, 20])),
      endpointDiagnostics: {
        '/api/recommend': {
          resultSongIds: [11, 12],
          maxArtistShare: 0.5,
          dominantArtistIds: ['name:gumi', 'name:hatsune miku'],
          maxProducerShare: 0.5,
          dominantProducerIds: [7, 8],
          maxVocalistShare: 0.5,
          dominantVocalistIds: [39, 40],
          elapsedMs: 321,
        },
      },
    }],
    health: { requestElapsedMs: 456 },
    latency: {
      p95Ms: 500,
      maximumMs: 15_000,
      endpoints: Object.fromEntries(endpoints.map(endpoint => [endpoint, { p50Ms: 100, p95Ms: 500 }])),
    },
    dig: {
      count: 20,
      latencyMs: 200,
      alternateLatencyMs: 180,
      generationOverlap: 0.2,
      maxProducerShare: 0.2,
    },
    quality: {
      maxModeOverlap: 0.2,
      thresholds: {
        maxArtistShare: 0.75,
        maxProducerShare: 0.70,
        maxVocalistShare: 0.85,
        maxSeedOverlap: 0.85,
        maxModeOverlap: 0.95,
        minUniqueRatio: 0.35,
        minHybridMinorShare: 0.20,
        maxHybridMinorShare: 0.80,
        maxSeedProducerShare: 0.40,
      },
      endpoints: endpoints.map(endpoint => ({
        endpoint,
        maxArtistShare: 0.2,
        maxProducerShare: 0.2,
        maxVocalistShare: endpoint === '/api/recommend' ? 0.85 : 0.2,
        maxSeedOverlap: 0.2,
        uniqueRatio: 0.8,
        minorShare: 0.4,
        groupMetadataCoverage: 1,
      })),
    },
  };
}

const diagnostics = buildSeedEndpointDiagnostics([
  { songId: 11, artist: ' Hatsune Miku ', producerIds: [7, 8, 7], vocalistIds: [39, 40] },
  { songId: 12, artist: 'HATSUNE MIKU', producerIds: [7], vocalistIds: [39] },
  { songId: 13, artist: 'GUMI', producerIds: [8], vocalistIds: [40] },
  { songId: 14, artist: 'gumi', producerIds: [], vocalistIds: [] },
]);
assert.deepEqual(diagnostics.resultSongIds, [11, 12, 13, 14]);
assert.equal(diagnostics.maxArtistShare, 0.5);
assert.deepEqual(
  new Set(diagnostics.dominantArtistIds),
  new Set(['name:hatsune miku', 'name:gumi']),
);
assert.equal(diagnostics.maxProducerShare, 0.5);
assert.deepEqual(diagnostics.dominantProducerIds, [7, 8]);
assert.equal(diagnostics.maxVocalistShare, 0.5);
assert.deepEqual(diagnostics.dominantVocalistIds, [39, 40]);
assert.deepEqual(buildSeedEndpointDiagnostics([]), {
  resultSongIds: [],
  maxArtistShare: 0,
  dominantArtistIds: [],
  maxProducerShare: 0,
  dominantProducerIds: [],
  maxVocalistShare: 0,
  dominantVocalistIds: [],
});

assert.doesNotThrow(() => assertRecommendationReport(passingReport()));

const failing = passingReport();
failing.quality.endpoints[0].maxVocalistShare = 0.95;
const directory = await mkdtemp(join(tmpdir(), 'diva-recommendation-report-'));
const reportFile = join(directory, 'report.json');
const historyFile = join(directory, 'history.jsonl');
try {
  await assert.rejects(
    persistAndAssertRecommendationReport(failing, { reportFile, historyFile }),
    /\/api\/recommend vocalist share 0\.950 exceeded 0\.85/,
  );
  const savedReport = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.equal(savedReport.generatedAt, failing.generatedAt);
  assert.equal(savedReport.seedResults[0].counts['/api/recommend'], 20);
  assert.deepEqual(
    savedReport.seedResults[0].endpointDiagnostics['/api/recommend'].dominantVocalistIds,
    [39, 40],
  );
  assert.equal(
    savedReport.seedResults[0].endpointDiagnostics['/api/recommend'].elapsedMs,
    321,
  );
  assert.equal(savedReport.health.requestElapsedMs, 456);
  assert.equal(savedReport.dig.alternateLatencyMs, 180);
  const history = (await readFile(historyFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(history.length, 1);
  assert.equal(history[0].quality.endpoints[0].maxVocalistShare, 0.95);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('PASS recommendation regression per-seed diagnostics and pre-assert report persistence');
