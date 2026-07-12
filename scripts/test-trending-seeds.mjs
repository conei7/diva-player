const argumentIndex = process.argv.indexOf('--base-url');
const provided = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.SBC_API_URL;
if (!provided) throw new Error('Set SBC_API_URL or pass --base-url http://192.168.40.79:5000.');
const baseUrl = new URL(provided).toString().replace(/\/$/, '');

async function fetchItems(seed) {
  const url = `${baseUrl}/api/songs/trending?days=7&start=0&maxResults=24&mode=surge&seed=${seed}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const data = await response.json();
  return data.items ?? [];
}

const [sameA, sameB, different] = await Promise.all([
  fetchItems(11),
  fetchItems(11),
  fetchItems(12),
]);

const ids = items => items.map(item => item.id);
if (JSON.stringify(ids(sameA)) !== JSON.stringify(ids(sameB))) {
  throw new Error('The same ranking seed produced different results.');
}
if (sameA.length > 1 && JSON.stringify(ids(sameA)) === JSON.stringify(ids(different))) {
  throw new Error('Different ranking seeds produced an identical result.');
}

const differentIds = new Set(ids(different));
const overlap = ids(sameA).filter(id => differentIds.has(id)).length;
console.log(`PASS trending seed stability: same=${sameA.length}, different=${different.length}, overlap=${overlap}`);
