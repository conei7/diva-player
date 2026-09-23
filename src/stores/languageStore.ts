import { create } from 'zustand';
import { storage } from '../utils/storage';

export type AppLanguage = 'ja' | 'en';

type EnglishTranslations = typeof import('../i18n-en');

let englishTranslations: EnglishTranslations | undefined;
let englishTranslationsPromise: Promise<EnglishTranslations> | undefined;

export function getEnglishTranslations() {
  return englishTranslations;
}

export function ensureEnglishTranslations(): Promise<EnglishTranslations> {
  if (englishTranslations) return Promise.resolve(englishTranslations);
  englishTranslationsPromise ??= import('../i18n-en').then(module => {
    englishTranslations = module;
    return module;
  }).catch(error => {
    englishTranslationsPromise = undefined;
    throw error;
  });
  return englishTranslationsPromise;
}

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
  setLanguage: (language: AppLanguage) => Promise<void>;
}

let languageChangeRequest = 0;

export const useLanguageStore = create<LanguageState>((set) => ({
  language: readStoredLanguage(),
  setLanguage: async (language) => {
    const request = ++languageChangeRequest;
    if (language === 'en') {
      try {
        await ensureEnglishTranslations();
      } catch (error) {
        console.error('Could not load English translations.', error);
        return;
      }
    }
    if (request !== languageChangeRequest) return;
    storage.set(LANGUAGE_STORAGE_KEY, language);
    set({ language });
  },
}));
