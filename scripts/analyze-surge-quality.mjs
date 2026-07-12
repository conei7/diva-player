const DEFAULT_TIMEOUT_MS = 35_000;

function getBaseUrl() {
  const argumentIndex = process.argv.indexOf('--base-url');
  const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.SBC_API_URL;
  if (!provided) throw new Error('Set SBC_API_URL or pass --base-url http://192.168.40.79:5000.');
  return new URL(provided).toString().replace(/\/$/, '');
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
  return response.json();
}

function summarize(items) {
  const lengths = items.map(item => item.lengthSeconds).filter(Number.isFinite).sort((a, b) => a - b);
  const favorites = items.map(item => item.favoritedTimes).filter(Number.isFinite).sort((a, b) => a - b);
  const quality = items.map(item => item.qualityScore).filter(Number.isFinite);
  const count = items.length || 1;
  const percentile = values => values.length ? values[Math.floor(values.length * 0.5)] : null;
  return {
    count: items.length,
    short45: items.filter(item => Number(item.lengthSeconds) < 45).length,
    short75: items.filter(item => Number(item.lengthSeconds) < 75).length,
    favoriteZero: items.filter(item => Number(item.favoritedTimes) === 0).length,
    nicoPresent: items.filter(item => Number(item.nicoViews) > 0).length,
    medianLengthSeconds: percentile(lengths),
    medianFavorites: percentile(favorites),
    averageQuality: quality.length ? quality.reduce((sum, value) => sum + value, 0) / quality.length : null,
    qualityReasons: [...new Set(items.flatMap(item => item.qualityReasons ?? []))].slice(0, 20),
    topNames: items.slice(0, 5).map(item => item.name),
    denominator: count,
  };
}

async function main() {
  const baseUrl = getBaseUrl();
  const [legacy, quality] = await Promise.all([
    getJson(baseUrl, '/api/songs/trending?days=7&start=0&maxResults=100&mode=surge&ranking=legacy'),
    getJson(baseUrl, '/api/songs/trending?days=7&start=0&maxResults=100&mode=surge&ranking=quality&debug=true'),
  ]);
  const legacyItems = legacy.items ?? [];
  const qualityItems = quality.items ?? [];
  const legacyIds = new Set(legacyItems.map(item => item.id));
  const qualityIds = new Set(qualityItems.map(item => item.id));
  const overlap = [...qualityIds].filter(id => legacyIds.has(id)).length;

  console.log(JSON.stringify({
    baseUrl,
    legacy: summarize(legacyItems),
    quality: summarize(qualityItems),
    top100Overlap: overlap,
    changedTop24: qualityItems.slice(0, 24).filter((item, index) => legacyItems[index]?.id !== item.id).length,
  }, null, 2));
}

main().catch(error => {
  console.error(`Surge quality analysis failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
