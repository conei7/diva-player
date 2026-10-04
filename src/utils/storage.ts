/**
 * LocalStorage アダプター
 * 
 * 将来的なBaaS移行を見据えた疎結合設計。
 * このファイルのインターフェースを維持したまま、
 * バックエンドの保存先を変更可能。
 */

const STORAGE_PREFIX = 'diva_';

export interface StorageAdapter {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): boolean;
  setMany(entries: Array<{ key: string; value: unknown }>): { success: boolean; rollbackSucceeded: boolean };
  remove(key: string): void;
  keys(): string[];
}

export const storage: StorageAdapter = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      console.warn(`[Storage] Failed to parse key: ${key}`);
      return null;
    }
  },

  set<T>(key: string, value: T): boolean {
    try {
      localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error(`[Storage] Failed to save key: ${key}`, error);
      return false;
    }
  },

  setMany(entries) {
    let snapshots: Array<{ key: string; value: string | null }>;
    try {
      snapshots = entries.map(({ key }) => ({
        key: STORAGE_PREFIX + key,
        value: localStorage.getItem(STORAGE_PREFIX + key),
      }));
    } catch (error) {
      console.error('[Storage] Failed to read multi-key save snapshot', error);
      return { success: false, rollbackSucceeded: true };
    }
    const written: string[] = [];
    try {
      for (const { key, value } of entries) {
        const storageKey = STORAGE_PREFIX + key;
        localStorage.setItem(storageKey, JSON.stringify(value));
        written.push(storageKey);
      }
      return { success: true, rollbackSucceeded: true };
    } catch (error) {
      console.error('[Storage] Failed to save multiple keys', error);
      let rollbackSucceeded = true;
      for (const snapshot of snapshots.filter(item => written.includes(item.key)).reverse()) {
        try {
          if (snapshot.value === null) localStorage.removeItem(snapshot.key);
          else localStorage.setItem(snapshot.key, snapshot.value);
        } catch (rollbackError) {
          rollbackSucceeded = false;
          console.error(`[Storage] Failed to restore key: ${snapshot.key.slice(STORAGE_PREFIX.length)}`, rollbackError);
        }
      }
      return { success: false, rollbackSucceeded };
    }
  },

  remove(key: string): void {
    localStorage.removeItem(STORAGE_PREFIX + key);
  },

  keys(): string[] {
    const result: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) {
        result.push(key.slice(STORAGE_PREFIX.length));
      }
    }
    return result;
  },
};
