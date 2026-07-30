// Bounded read-only audit for VocaDB custom-name artist rows.
// These rows can contain a display name without the nested `artist` object.

const API_BASE = 'https://vocadb.net/api';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const inline = process.argv.find(argument => argument.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : fallback;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer.`);
  return number;
}

function isCustomProducer(row) {
  return row?.categories?.includes('Producer') && !row.artist && typeof row.name === 'string' && row.name.trim().length > 0;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

async function auditSongIds(ids) {
  const songs = [];
  for (const id of ids) {
    songs.push(await getJson(`${API_BASE}/songs/${id}?fields=Artists&lang=Japanese`));
  }
  return songs;
}

async function auditPages(pageSize, maxPages) {
  const songs = [];
  let totalCount = null;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({
      fields: 'Artists',
      lang: 'Japanese',
      maxResults: String(pageSize),
      start: String(page * pageSize),
      getTotalCount: 'true',
      sort: 'FavoritedTimes',
    });
    const result = await getJson(`${API_BASE}/songs?${params}`);
    totalCount ??= result.totalCount ?? null;
    const items = Array.isArray(result.items) ? result.items : [];
    songs.push(...items);
    process.stdout.write(`Scanned page ${page + 1}/${maxPages}: ${songs.length} songs\n`);
    if (items.length < pageSize || songs.length >= (totalCount ?? Number.POSITIVE_INFINITY)) break;
  }
  return { songs, totalCount };
}

async function main() {
  const ids = process.argv
    .filter(argument => argument.startsWith('--song-id='))
    .map(argument => positiveInteger(argument.slice('--song-id='.length), '--song-id'));
  const pageSize = positiveInteger(option('--page-size', DEFAULT_PAGE_SIZE), '--page-size');
  const maxPages = positiveInteger(option('--max-pages', DEFAULT_MAX_PAGES), '--max-pages');
  const pageResult = ids.length > 0 ? { songs: await auditSongIds(ids), totalCount: ids.length } : await auditPages(pageSize, maxPages);
  const customRows = pageResult.songs.flatMap(song => (song.artists ?? [])
    .filter(isCustomProducer)
    .map(artist => ({ songId: song.id, songName: song.name, producerName: artist.name, artistRowId: artist.id })));
  const affectedSongIds = [...new Set(customRows.map(row => row.songId))];

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: API_BASE,
    scannedSongs: pageResult.songs.length,
    catalogTotalCount: pageResult.totalCount,
    affectedSongCount: affectedSongIds.length,
    customProducerRowCount: customRows.length,
    affectedSongIds,
    examples: customRows.slice(0, 20),
  }, null, 2));
}

main().catch(error => {
  console.error(`Custom producer audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
