import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ensureEnglishTranslations, useLanguageStore } from './stores/languageStore';
import './index.css';
import App from './App';

async function renderApp() {
  if (useLanguageStore.getState().language === 'en') {
    try {
      await ensureEnglishTranslations();
    } catch (error) {
      console.error('Could not load English translations. Showing the Japanese interface instead.', error);
      useLanguageStore.setState({ language: 'ja' });
    }
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void renderApp();
