import type { ListeningPlayEvent } from '../stores/historyStore';
import { HISTORY_STORES, openHistoryDb } from './historyDatabase';

const BACKUP_KIND = 'diva-player-history';
const BACKUP_VERSION = 1;
const MAX_IMPORT_EVENTS = 1_000_000;

export interface HistoryBackupPayload {
  kind: typeof BACKUP_KIND;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  events: ListeningPlayEvent[];
}

export interface HistoryBackupSummary {
  eventCount: number;
  excludedActiveEvents: number;
}

export interface HistoryImportResult {
  imported: number;
  duplicates: number;
  skipped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Active events are intentionally excluded: they cannot be completed after a restore. */
export function normalizeImportedEvent(value: unknown): ListeningPlayEvent | null {
  if (!isRecord(value)) return null;

  const songId = asFiniteNumber(value.s);
  const playedAt = asFiniteNumber(value.t);
  if (songId === undefined || playedAt === undefined
    || !Number.isInteger(songId) || songId <= 0
    || !Number.isInteger(playedAt) || playedAt <= 0) return null;

  const source = value.o === 1 ? 1 : 0;
  const progress = asFiniteNumber(value.p);
  const duration = asFiniteNumber(value.d);

  return {
    s: songId,
    t: playedAt,
    o: source,
    ...(progress === undefined ? {} : { p: Math.max(0, Math.round(progress)) }),
    ...(duration === undefined ? {} : { d: Math.max(0, Math.round(duration)) }),
    ...(value.c === 1 ? { c: 1 as const } : { c: 0 as const }),
    f: 1,
  };
}

export function playEventFingerprint(event: ListeningPlayEvent): string {
  return [event.s, event.t, event.o ?? 0, event.p ?? '', event.d ?? '', event.c ?? 0].join(':');
}

export function parseHistoryBackup(data: unknown): ListeningPlayEvent[] | null {
  if (!isRecord(data)
    || data.kind !== BACKUP_KIND
    || data.version !== BACKUP_VERSION
    || !Array.isArray(data.events)
    || data.events.length > MAX_IMPORT_EVENTS) {
    return null;
  }

  return data.events
    .map(normalizeImportedEvent)
    .filter((event): event is ListeningPlayEvent => event !== null);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function readAllEvents(): Promise<ListeningPlayEvent[]> {
  const db = await openHistoryDb();
  const tx = db.transaction(HISTORY_STORES.plays, 'readonly');
  return requestToPromise(tx.objectStore(HISTORY_STORES.plays).getAll()) as Promise<ListeningPlayEvent[]>;
}

export async function createHistoryBackup(): Promise<{ payload: HistoryBackupPayload; summary: HistoryBackupSummary }> {
  const allEvents = await readAllEvents();
  const events = allEvents
    .filter(event => event.f !== 0)
    .map(event => normalizeImportedEvent(event))
    .filter((event): event is ListeningPlayEvent => event !== null);

  return {
    payload: {
      kind: BACKUP_KIND,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      events,
    },
    summary: {
      eventCount: events.length,
      excludedActiveEvents: allEvents.length - events.length,
    },
  };
}

/**
 * Importing invalidates only derived data. The raw event log remains the source of truth,
 * so the next statistics read rebuilds summaries deterministically.
 */
export async function importHistoryBackup(data: unknown): Promise<HistoryImportResult> {
  const parsed = parseHistoryBackup(data);
  if (parsed === null) throw new Error('This is not a supported DIVA listening-history backup.');

  const existingEvents = await readAllEvents();
  const existingFingerprints = new Set(existingEvents.map(playEventFingerprint));
  const seenInBackup = new Set<string>();
  const eventsToAdd: ListeningPlayEvent[] = [];
  let duplicates = 0;

  for (const event of parsed) {
    const fingerprint = playEventFingerprint(event);
    if (existingFingerprints.has(fingerprint) || seenInBackup.has(fingerprint)) {
      duplicates += 1;
      continue;
    }
    seenInBackup.add(fingerprint);
    eventsToAdd.push(event);
  }
  const skipped = (data as { events: unknown[] }).events.length - parsed.length;

  if (eventsToAdd.length === 0) return { imported: 0, duplicates, skipped };

  const db = await openHistoryDb();
  const tx = db.transaction(Object.values(HISTORY_STORES), 'readwrite');
  const playStore = tx.objectStore(HISTORY_STORES.plays);
  for (const event of eventsToAdd) playStore.add(event);

  // Rebuild rather than attempting to merge untrusted imported aggregates.
  tx.objectStore(HISTORY_STORES.pending).clear();
  tx.objectStore(HISTORY_STORES.applied).clear();
  tx.objectStore(HISTORY_STORES.songStats).clear();
  tx.objectStore(HISTORY_STORES.yearStats).clear();
  tx.objectStore(HISTORY_STORES.meta).clear();
  await transactionToPromise(tx);

  return { imported: eventsToAdd.length, duplicates, skipped };
}
