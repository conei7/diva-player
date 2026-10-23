import { create } from 'zustand';
import { storage } from '../utils/storage';
import { showToast } from './toastStore';

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

export const LANGUAGE_STORAGE_KEY = 'uiLanguage';

/** Restore only after translations and persistence are ready. */
export async function restoreLanguage(language: AppLanguage): Promise<void> {
  const request = ++languageChangeRequest;
  if (language === 'en') await ensureEnglishTranslations();
  if (request !== languageChangeRequest) throw new Error('Language change superseded');
  if (!storage.set(LANGUAGE_STORAGE_KEY, language)) throw new Error('Could not save language');
  useLanguageStore.setState({ language });
}

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

/**
 * 原文方式の訳（i18n.ts の translateSourceText と同じ規則。i18n.ts がこのストアを読むので、循環しないようにここで引く）。
 * 英語の訳を読めなかった時に出すので、実際にはほぼ原文（日本語）のまま出る。
 */
function sourceText(language: AppLanguage, source: string): string {
  return (language === 'en' ? englishTranslations?.englishSourceText[source] : undefined) ?? source;
}

export const useLanguageStore = create<LanguageState>((set, get) => ({
  language: readStoredLanguage(),
  setLanguage: async (language) => {
    const request = ++languageChangeRequest;
    if (language === 'en') {
      try {
        await ensureEnglishTranslations();
      } catch (error) {
        console.error('Could not load English translations.', error);
        // 設定・上部の ⋮ のどちらから切り替えても同じ通知を出す（DESIGN_SPEC §6.8.3）
        if (request === languageChangeRequest) {
          const current = get().language;
          showToast(sourceText(current, '言語を切り替えられませんでした'), {
            action: { label: sourceText(current, '再試行'), onAction: () => void get().setLanguage(language) },
          });
        }
        return;
      }
    }
    if (request !== languageChangeRequest) return;
    storage.set(LANGUAGE_STORAGE_KEY, language);
    set({ language });
  },
}));
