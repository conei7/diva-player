import { Component, type ErrorInfo, type ReactNode } from 'react';
import { translateSourceText } from '../i18n';
import { useLanguageStore } from '../stores/languageStore';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

/** Keeps one malformed API row from replacing the entire app with a blank root. */
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

  private translate = (source: string): string =>
    translateSourceText(useLanguageStore.getState().language, source);

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main
        className="flex min-h-screen items-center justify-center px-6"
        style={{ background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}
      >
        <section
          className="w-full max-w-lg rounded-2xl p-6 text-center"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
          role="alert"
        >
          <h1 className="text-lg font-semibold">{this.translate('画面を表示できませんでした')}</h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--color-text-secondary)' }}>
            {this.translate('曲データの一部に対応できない形式が含まれています。再読み込みすると復旧する場合があります。')}
          </p>
          <button
            type="button"
            className="mt-5 rounded-lg px-4 py-2 text-sm font-medium"
            style={{ background: 'var(--color-accent-cyan)', color: 'var(--color-bg-primary)' }}
            onClick={this.reloadApp}
          >
            {this.translate('再読み込み')}
          </button>
        </section>
      </main>
    );
  }
}
