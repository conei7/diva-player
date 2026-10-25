import type { Song } from '../types/vocadb';

/** A bounded viewport queue. Moving the viewport replaces queued work, but
 * never discards a useful response that is already on its way. */
export class AtlasSongLoader {
  readonly songs = new Map<number, Song>();
  private wanted: number[] = [];
  private pending = new Set<number>();
  private retryAfter = new Map<number, number>();
  private listeners = new Set<() => void>();
  private running = 0;
  private fetchSongs: (ids: number[]) => Promise<Song[]>;
  private limit: number;
  constructor(fetchSongs: (ids: number[]) => Promise<Song[]>, initial: readonly Song[] = [], limit = 4096) {
    this.fetchSongs = fetchSongs;
    this.limit = limit;
    initial.forEach(song => this.songs.set(song.id, song));
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  request(ids: readonly number[]) {
    this.wanted = [...new Set(ids)].slice(0, 320);
    for (const id of this.wanted) {
      const song = this.songs.get(id);
      if (song) { this.songs.delete(id); this.songs.set(id, song); }
    }
    this.pump();
  }
  private pump() {
    while (this.running < 1) {
      const ids = this.wanted.filter(id => !this.songs.has(id) && !this.pending.has(id)
        && (this.retryAfter.get(id) ?? 0) <= Date.now()).slice(0, 32);
      if (!ids.length) return;
      ids.forEach(id => this.pending.add(id));
      this.running++;
      void this.fetchSongs(ids).then(songs => {
        songs.forEach(song => { this.songs.delete(song.id); this.songs.set(song.id, song); });
        // Metadata from an earlier viewport remains useful when returning to it.
        const protectedIds = new Set(this.wanted);
        for (const id of this.songs.keys()) {
          if (this.songs.size <= this.limit) break;
          if (!protectedIds.has(id)) this.songs.delete(id);
        }
        this.listeners.forEach(listener => listener());
      }).catch(() => undefined).finally(() => {
        ids.forEach(id => {
          this.pending.delete(id);
          if (!this.songs.has(id)) this.retryAfter.set(id, Date.now() + 5000);
        });
        while (this.retryAfter.size > 320) this.retryAfter.delete(this.retryAfter.keys().next().value!);
        this.running--;
        this.pump();
      });
    }
  }
}
