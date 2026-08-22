import React from 'react';
import ErrorScreen from './ErrorScreen';

// Top-level render-error catch. Without this, any unhandled render error
// white-screens the whole app (see CURRENT_STATE.md "No error boundary").
// Wraps <App /> in main.jsx.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] caught render error:', error, info);
  }

  render() {
    if (this.state.error) {
      const detail = this.state.error?.stack || this.state.error?.message || String(this.state.error);
      return (
        <ErrorScreen
          title="Something went wrong"
          message="The app hit an unexpected snag. Reloading usually sorts it out — nothing you've saved has been lost."
          retryLabel="Reload the app"
          onRetry={() => window.location.reload()}
          detail={detail}
        />
      );
    }
    return this.props.children;
  }
}
