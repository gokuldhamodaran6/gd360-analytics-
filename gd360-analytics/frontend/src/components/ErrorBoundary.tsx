import React from "react";

// 2026-10-07 (real end-to-end run): two separate bugs each turned the
// whole app into a blank white page, because a render error anywhere
// unmounts everything when nothing catches it. This boundary is the
// safety net: the page that failed is replaced by a plain, honest notice
// with a way forward, the rest of the session is untouched, and the
// error is logged to the console for whoever investigates.
//
// It resets itself when the route changes (resetKey), so navigating away
// from a broken page always works.

type Props = { children: React.ReactNode; resetKey?: string };
type State = { error: Error | null };

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("[GD360] A page failed to render:", error, info?.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex min-h-screen items-center justify-center bg-base px-6 py-16">
        <div className="w-full max-w-md rounded-card border border-border bg-surface p-6 text-center">
          <h1 className="text-section font-semibold text-text">This page couldn't be displayed</h1>
          <p className="mt-2 text-ui text-muted">
            Something went wrong while drawing this screen. Your data and your dashboards are not affected.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              className="ui-focus h-9 rounded-ctl bg-primary px-3.5 text-ui font-medium text-on-primary hover:opacity-90"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              type="button"
              className="ui-focus h-9 rounded-ctl border border-border bg-surface px-3.5 text-ui font-medium text-text hover:bg-subtle"
              onClick={() => window.location.reload()}
            >
              Reload the page
            </button>
            <a href="/" className="ui-focus h-9 rounded-ctl px-3.5 text-ui font-medium leading-9 text-brand-ink hover:underline">
              Go to the home page
            </a>
          </div>
          <details className="mt-5 text-left">
            <summary className="cursor-pointer text-caption text-muted">Technical detail</summary>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-ctl border border-border bg-subtle p-2 font-mono text-[12px] text-secondary">
              {String(this.state.error?.message || this.state.error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
