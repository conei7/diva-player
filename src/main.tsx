import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ensureEnglishTranslations, useLanguageStore } from './stores/languageStore';
import './index.css';
import App from './App';
import { initializeTheme } from './stores/themeStore';
import { initializeUiLayout, useUiLayoutStore } from './stores/uiLayoutStore';
import { ensureMusicShell } from './components/music/musicShellLoader';
import type { UiLayout } from './utils/uiLayout';

const prepareUiLayout = (layout: UiLayout) => (layout === 'music' ? ensureMusicShell() : Promise.resolve());

initializeTheme();
initializeUiLayout(prepareUiLayout);

async function renderApp() {
  // The music frame downloads alongside the English strings; the standard layout waits for nothing.
  const musicShellReady = useUiLayoutStore.getState().layout === 'music'
    ? ensureMusicShell().catch(error => {
      // This session shows the standard layout; the saved choice stays, so the next start tries again.
      console.error('Could not load the music layout. Showing the standard layout instead.', error);
    })
    : undefined;
  if (useLanguageStore.getState().language === 'en') {
    try {
      await ensureEnglishTranslations();
    } catch (error) {
      console.error('Could not load English translations. Showing the Japanese interface instead.', error);
      useLanguageStore.setState({ language: 'ja' });
    }
  }
  await musicShellReady;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void renderApp();
