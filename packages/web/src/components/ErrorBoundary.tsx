import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Remount key — changing it (e.g. on route change) clears a caught error. */
  resetKey?: string;
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/** Catches render/effect errors in a page so one bad view degrades to a message
 * instead of unmounting the whole app (blank screen). The engine-truth principle
 * applies to the UI too: never silently stall — say what broke. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="app-error" role="alert">
        <h1>Something went wrong on this page</h1>
        <p className="muted">The rest of the console is still running — try another view, or reload.</p>
        <pre className="app-error-detail">{error.message}</pre>
        <button onClick={() => window.location.reload()}>Reload</button>
      </section>
    );
  }
}
