import React from 'react';

// Friendly, on-brand full-screen notice for the two ways the app can fail to
// come up (an unhandled render error via ErrorBoundary, or the boot sequence
// giving up because the backend is unreachable/slow — see App.jsx bootError).
// Presentational only — no data fetching, no side effects.
export default function ErrorScreen({ title, message, onRetry, retryLabel, detail }) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        background: '#FFAB94',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          background: '#fff',
          borderRadius: 16,
          padding: 24,
          maxWidth: 360,
          width: '100%',
          boxSizing: 'border-box',
          textAlign: 'center',
          boxShadow: '0 4px 24px rgba(0,0,0,0.12)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-heading)',
            color: '#1A0A00',
            fontWeight: 700,
            fontSize: 20,
            marginBottom: 10,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-body)',
            color: '#1A0A00',
            fontSize: 15,
            lineHeight: 1.5,
            marginBottom: 20,
          }}
        >
          {message}
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 44,
              width: '100%',
              boxSizing: 'border-box',
              background: '#0047FF',
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              fontFamily: 'var(--font-body)',
              fontWeight: 600,
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            {retryLabel || 'Try again'}
          </button>
        )}
        {detail && (
          <details style={{ marginTop: 16, textAlign: 'left' }}>
            <summary
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 12,
                color: '#8a8a8a',
                cursor: 'pointer',
              }}
            >
              Technical details
            </summary>
            <div
              style={{
                marginTop: 8,
                fontFamily: 'monospace',
                fontSize: 11,
                color: '#8a8a8a',
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
              }}
            >
              {detail}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
