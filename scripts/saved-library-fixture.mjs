/** Observe the durable library, rather than assuming the legacy localStorage format. */
export async function installSavedLibraryReader(page) {
  await page.evaluateOnNewDocument(() => {
    window.__readSavedPlaylists = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('diva-playlists', 1);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onerror = () => request.error?.name === 'AbortError'
        ? resolve(JSON.parse(localStorage.getItem('diva_playlists') || '[]')) : reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('playlists')) {
          db.close(); resolve(JSON.parse(localStorage.getItem('diva_playlists') || '[]')); return;
        }
        const tx = db.transaction(['playlists', 'meta']);
        const lists = tx.objectStore('playlists').getAll();
        const meta = tx.objectStore('meta').get('current');
        tx.oncomplete = () => {
          db.close();
          const byId = new Map(lists.result.map(item => [item.id, item]));
          resolve(meta.result?.ids.map(id => byId.get(id)) || []);
        };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  });
}
