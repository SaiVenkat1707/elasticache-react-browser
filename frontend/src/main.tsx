import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { loadConfig } from './config';

// Load runtime config (from /config.json) BEFORE rendering the app, so every
// component sees the real values. If it fails, show a clear message instead
// of a broken app.
const root = ReactDOM.createRoot(document.getElementById('root')!);

loadConfig().then(
  () => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  },
  (err) => {
    root.render(
      <div style={{ color: '#e5e7eb', background: '#0f1419', minHeight: '100vh',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'system-ui, sans-serif', padding: '24px', textAlign: 'center' }}>
        <div>
          <h2>Configuration error</h2>
          <p style={{ color: '#9ca3af' }}>{String(err.message || err)}</p>
          <p style={{ color: '#9ca3af', fontSize: '13px' }}>
            Check that config.json is deployed next to index.html and contains valid values.
          </p>
        </div>
      </div>,
    );
  },
);
