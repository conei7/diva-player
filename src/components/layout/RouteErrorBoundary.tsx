import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { translateSourceText } from '../../i18n';
import { useLanguageStore } from '../../stores/languageStore';
import { showToast } from '../../stores/toastStore';
import Button, { buttonClassName } from '../ui/Button';

/** A page chunk that could not be downloaded (deploy or network); only a reload can fetch it again. */
function isChunkLoadError(error: Error): boolean {
  return error.name === 'ChunkLoadError'
    || /dynamically imported module|Importing a module script failed/i.test(error.message);
}

/**
 * What the page area shows when it has nothing to show (an error, an unknown path): one 20px line
 * centered in <main> and its buttons, no description (DESIGN_SPEC §6.1.7). `alert` announces it.
 */
export function PageMessage({ title, alert = false, children }: { title: string; alert?: boolean; children: ReactNode }) {
  const heading = <h1 className="text-xl font-medium leading-7">{title}</h1>;
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center gap-6 px-6 py-12 text-center text-yt-text">
      {alert ? <div role="alert">{heading}</div> : heading}
      <div className="flex flex-wrap items-center justify-center gap-2">{children}</div>
    </div>
  );
}

interface RouteErrorBoundaryProps {
  /** Changing it (pathname + search) clears the error, so moving to another page recovers. */
  resetKey: string;
  children: ReactNode;
}

interface RouteErrorBoundaryState {
  error: Error | null;
  resetKey: string;
}

/**
 * Page-level error boundary inside <main> (DESIGN_SPEC §6.1.7). The top bar, the guide and the
 * player stay usable; the page area shows 「問題が発生しました」 with [再試行] and [ホームに戻る].
 */
export default class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<RouteErrorBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: RouteErrorBoundaryProps, state: RouteErrorBoundaryState): Partial<RouteErrorBoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('DIVA Player page error', error, errorInfo);
  }

  private retry = (): void => {
    if (this.state.error && isChunkLoadError(this.state.error)) {
      window.location.reload();
      return;
    }
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    const language = useLanguageStore.getState().language;
    return (
      <PageMessage title={translateSourceText(language, '問題が発生しました')} alert>
        <Button variant="primary" onClick={this.retry}>{translateSourceText(language, '再試行')}</Button>
        <Link to="/" className={buttonClassName({ variant: 'tonal' })}>{translateSourceText(language, 'ホームに戻る')}</Link>
      </PageMessage>
    );
  }
}

interface OverlayErrorBoundaryProps {
  /** Closes the overlay that failed (it is not drawn again until it is reopened). */
  onError: () => void;
  /** Changing it clears the error (e.g. the overlay's open flag or its content). */
  resetKey?: unknown;
  children: ReactNode;
}

interface OverlayErrorBoundaryState {
  failed: boolean;
  resetKey: unknown;
}

/**
 * Wraps one lazy overlay of the layout (queue, song details, save to playlist, selection bar,
 * settings). A failure closes that overlay and shows the toast 「表示できませんでした」 instead of
 * taking the page down.
 */
export class OverlayErrorBoundary extends Component<OverlayErrorBoundaryProps, OverlayErrorBoundaryState> {
  state: OverlayErrorBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<OverlayErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: OverlayErrorBoundaryProps, state: OverlayErrorBoundaryState): Partial<OverlayErrorBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failed: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('DIVA Player overlay error', error, errorInfo);
    showToast(translateSourceText(useLanguageStore.getState().language, '表示できませんでした'));
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface DeferredBoundaryProps {
  /** Shown instead when the part fails (default: nothing). */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Wraps a part of the frame that loads after the first paint (the ⋮ menus, the mini player's
 * controls, autoplay, the connection band). If its code cannot be downloaded (offline, a new
 * deploy) or it throws, only that part falls back quietly; the page and the playing iframe stay.
 */
export class DeferredBoundary extends Component<DeferredBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('DIVA Player deferred part failed', error, errorInfo);
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
