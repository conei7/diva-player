import { create } from 'zustand';
import { storage } from '../utils/storage';

export type AppLanguage = 'ja' | 'en';

const LANGUAGE_STORAGE_KEY = 'uiLanguage';

export function resolveAppLanguage(stored: unknown, browserLanguages: readonly string[]): AppLanguage {
  if (stored === 'ja' || stored === 'en') return stored;
  return browserLanguages.some(language => /^ja(?:-|$)/i.test(language.trim())) ? 'ja' : 'en';
}

function readStoredLanguage(): AppLanguage {
  if (typeof window === 'undefined') return 'ja';
  const browserLanguages = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ];
  return resolveAppLanguage(storage.get<unknown>(LANGUAGE_STORAGE_KEY), browserLanguages);
}

interface LanguageState {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: readStoredLanguage(),
  setLanguage: (language) => {
    storage.set(LANGUAGE_STORAGE_KEY, language);
    set({ language });
  },
}));
