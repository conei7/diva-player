import { Component, type ErrorInfo, type ReactNode } from 'react';
import { translateSourceText } from '../i18n';
import { useLanguageStore } from '../stores/languageStore';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

/**
 * The last line of defence (DESIGN_SPEC §6.1.7): if the whole app fails to render, show the logo,
 * 「問題が発生しました」 and [再読み込み] instead of a blank page. Page and overlay failures are
 * caught closer to where they happen (RouteErrorBoundary / OverlayErrorBoundary).
 */
export default class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('DIVA Player rendering error', error, errorInfo);
  }

  private reloadApp = (): void => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const language = useLanguageStore.getState().language;

    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-yt-bg px-6 text-center text-yt-text">
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-xl text-white"
          style={{ background: 'var(--gradient-brand)' }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="m12 3 .01 10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4.01 4S14 19.21 14 17V7h4V3h-6z" />
          </svg>
        </span>
        <div role="alert">
          <h1 className="text-xl font-medium leading-7">{translateSourceText(language, '問題が発生しました')}</h1>
        </div>
        <button
          type="button"
          className="inline-flex h-9 cursor-pointer items-center justify-center rounded-full bg-yt-inverse px-4 text-sm font-medium leading-5 text-yt-on-inverse transition-colors duration-150 hover:bg-yt-inverse-hover"
          onClick={this.reloadApp}
        >
          {translateSourceText(language, '再読み込み')}
        </button>
      </main>
    );
  }
}
