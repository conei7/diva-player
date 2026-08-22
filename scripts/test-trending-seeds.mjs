const argumentIndex = process.argv.indexOf('--base-url');
const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.SBC_API_URL;
if (!provided) throw new Error('Set SBC_API_URL or pass --base-url http://192.168.40.79:5000.');
const baseUrl = new URL(provided).toString().replace(/\/$/, '');

async function fetchItems(mode, days, seed) {
  const url = `${baseUrl}/api/songs/trending?days=${days}&start=0&maxResults=24&mode=${mode}&seed=${seed}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const data = await response.json();
  return data.items ?? [];
}

const rankings = [
  ['weekly', 7],
  ['alltime', 30],
  ['pace', 30],
  ['surge', 7],
  ['recent', 30],
];
const ids = items => items.map(item => item.id);

for (const [mode, days] of rankings) {
  const [first, second] = await Promise.all([
    fetchItems(mode, days, 11),
    fetchItems(mode, days, 12),
  ]);
  if (JSON.stringify(ids(first)) !== JSON.stringify(ids(second))) {
    throw new Error(`${mode} ranking changed with its exploration seed.`);
  }
  console.log(`PASS deterministic ${mode} ranking: ${first.length} items`);
}
