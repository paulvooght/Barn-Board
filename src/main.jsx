import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
// Self-hosted fonts (bundled + service-worker precached → no Google round-trip,
// no flash-of-fallback after first load). Weights match the old Google URL.
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/dm-sans/800.css';
// Kodchasan is headings-only (grades, numbers, "BARN BOARD") → latin subset is enough.
import '@fontsource/kodchasan/latin-600.css';
import '@fontsource/kodchasan/latin-700.css';
import './App.css';

// iOS Safari: reset viewport zoom when any input loses focus.
// If the browser auto-zoomed on focus (font-size < 16px edge cases),
// this ensures the user can always get back to normal zoom.
if (/iPhone|iPad|iPod/.test(navigator.userAgent)) {
  document.addEventListener('blur', () => {
    // Briefly set maximum-scale=1 to snap back, then restore flexibility
    const vp = document.querySelector('meta[name="viewport"]');
    if (vp) {
      const original = vp.getAttribute('content');
      vp.setAttribute('content', original + ', maximum-scale=1.0');
      requestAnimationFrame(() => {
        vp.setAttribute('content', original);
      });
    }
  }, true); // capture phase to catch all input blurs
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
