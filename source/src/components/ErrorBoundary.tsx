import { Component, ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Surface in the console so users (or me) can grab the trace on a bug.
    console.error('Unhandled exception:', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  reload = () => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-screen bg-gray-900 text-white p-6 flex items-center justify-center">
        <div className="max-w-md w-full bg-gray-800 rounded-xl p-6 space-y-4">
          <h1 className="text-2xl font-bold">Something broke</h1>
          <p className="text-gray-300 text-sm">
            The tool hit an error. Your queued files are still in the browser — try
            continuing, or reload if it keeps happening.
          </p>
          <pre className="text-xs bg-gray-950 rounded p-3 overflow-auto max-h-32 text-red-300">
            {this.state.error.message}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={this.reset}
              className="flex-1 px-3 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition"
            >
              Try again
            </button>
            <button
              onClick={this.reload}
              className="flex-1 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm font-medium transition"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
