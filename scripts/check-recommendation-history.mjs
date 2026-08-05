import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function add(violations, condition, id, actual, threshold) {
  if (condition) violations.push({ id, actual, threshold });
}

export function collectRecommendationViolations(report) {
  const violations = [];
  const thresholds = report?.quality?.thresholds ?? {};
  const latency = report?.latency ?? {};
  add(violations, report?.health?.discoveryQuality?.ok === false,
    'health.discoveryQuality', false, true);
  add(violations, report?.health?.audioFeatures?.ok === false,
    'health.audioFeatures', false, true);
  add(violations, Number(latency.p95Ms) > Number(latency.maximumMs),
    'latency.overall.p95', latency.p95Ms, latency.maximumMs);
  for (const [endpoint, values] of Object.entries(latency.endpoints ?? {})) {
    add(violations, Number(values?.p95Ms) > Number(latency.maximumMs),
      `latency.${endpoint}.p95`, values?.p95Ms, latency.maximumMs);
  }
  add(violations, Number(report?.seedProducerShare) > Number(thresholds.maxSeedProducerShare),
    'seed.producerShare', report?.seedProducerShare, thresholds.maxSeedProducerShare);
  for (const endpoint of ['/api/recommend', '/api/recommend/metadata', '/api/recommend/audio']) {
    const applicable = (report?.seedResults ?? []).filter(
      seed => endpoint !== '/api/recommend/audio' || seed.group !== 'audio-missing',
    );
    const nonEmptyCount = applicable.filter(seed => Number(seed?.counts?.[endpoint]) > 0).length;
    add(violations, applicable.length > 0 && nonEmptyCount < applicable.length,
      `availability.${endpoint}`, nonEmptyCount, applicable.length);
  }
  for (const quality of report?.quality?.endpoints ?? []) {
    const prefix = `quality.${quality.endpoint}`;
    add(violations, Number(quality.maxArtistShare) > Number(thresholds.maxArtistShare),
      `${prefix}.artistShare`, quality.maxArtistShare, thresholds.maxArtistShare);
    if (Number(quality.groupMetadataCoverage) >= 0.8) {
      add(violations, Number(quality.maxProducerShare) > Number(thresholds.maxProducerShare),
        `${prefix}.producerShare`, quality.maxProducerShare, thresholds.maxProducerShare);
      add(violations, Number(quality.maxVocalistShare) > Number(thresholds.maxVocalistShare),
        `${prefix}.vocalistShare`, quality.maxVocalistShare, thresholds.maxVocalistShare);
    }
    add(violations, Number(quality.maxSeedOverlap) > Number(thresholds.maxSeedOverlap),
      `${prefix}.seedOverlap`, quality.maxSeedOverlap, thresholds.maxSeedOverlap);
    add(violations, Number(quality.uniqueRatio) < Number(thresholds.minUniqueRatio),
      `${prefix}.uniqueRatio`, quality.uniqueRatio, thresholds.minUniqueRatio);
    if (quality.endpoint === '/api/recommend') {
      add(violations, Number(quality.minorShare) < Number(thresholds.minHybridMinorShare),
        `${prefix}.minorShare.low`, quality.minorShare, thresholds.minHybridMinorShare);
      add(violations, Number(quality.minorShare) > Number(thresholds.maxHybridMinorShare),
        `${prefix}.minorShare.high`, quality.minorShare, thresholds.maxHybridMinorShare);
    }
  }
  add(violations, Number(report?.quality?.maxModeOverlap) > Number(thresholds.maxModeOverlap),
    'quality.modeOverlap', report?.quality?.maxModeOverlap, thresholds.maxModeOverlap);
  add(violations, Number(report?.dig?.latencyMs) > Number(latency.maximumMs),
    'dig.latency', report?.dig?.latencyMs, latency.maximumMs);
  add(violations, Number(report?.dig?.generationOverlap) >= 0.85,
    'dig.generationOverlap', report?.dig?.generationOverlap, 0.85);
  add(violations, Number(report?.dig?.maxProducerShare) >= 0.5,
    'dig.producerShare', report?.dig?.maxProducerShare, 0.5);
  return violations;
}

export function evaluateRecommendationHistory(reports, requiredConsecutive = 2) {
  if (!Number.isInteger(requiredConsecutive) || requiredConsecutive < 2) {
    throw new Error('requiredConsecutive must be an integer of at least 2');
  }
  const recent = reports.slice(-requiredConsecutive);
  const violationSets = recent.map(report => new Map(
    collectRecommendationViolations(report).map(item => [item.id, item]),
  ));
  const currentViolations = violationSets.at(-1) ? [...violationSets.at(-1).values()] : [];
  const sustainedViolations = recent.length < requiredConsecutive ? [] : currentViolations.filter(
    item => violationSets.every(values => values.has(item.id)),
  );
  return {
    generatedAt: new Date().toISOString(),
    status: sustainedViolations.length ? 'critical' : currentViolations.length ? 'warning' : 'healthy',
    requiredConsecutive,
    historyRunCount: reports.length,
    evaluatedRunCount: recent.length,
    newestReportAt: reports.at(-1)?.generatedAt ?? null,
    currentViolations,
    sustainedViolations,
  };
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const historyFile = option('--history-file');
  const outputFile = option('--output-file');
  const requiredConsecutive = Number(option('--consecutive', '2'));
  if (!historyFile) throw new Error('--history-file is required');
  const rows = (await readFile(historyFile, 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const result = evaluateRecommendationHistory(rows, requiredConsecutive);
  if (outputFile) await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'critical' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
}
