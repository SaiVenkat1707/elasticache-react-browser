import { useEffect, useState } from 'react';
import { api, BrowseResult, DumpResult, KeyEntry, SearchResult } from './api';
import { logout } from './auth';

type View =
  | { kind: 'browse'; data: BrowseResult | null; loading: boolean; error: string | null }
  | { kind: 'dump';   data: DumpResult   | null; loading: boolean; error: string | null }
  | { kind: 'key';    data: KeyEntry     | null; loading: boolean; error: string | null }
  | { kind: 'search'; data: SearchResult | null; loading: boolean; error: string | null };

interface Props {
  onLogout: () => void;
}

export function BrowserScreen({ onLogout }: Props) {
  const [path, setPath] = useState('');
  const [refresh, setRefresh] = useState(0);   // bump to force a reload of the same path
  const [view, setView] = useState<View>({ kind: 'browse', data: null, loading: true, error: null });

  // Load the prefix view whenever the path changes OR a refresh is requested.
  // Keyed on `path` + `refresh` only — never on `view`, which this effect sets
  // (keying on view would make it re-trigger itself).
  useEffect(() => {
    let cancelled = false;
    setView({ kind: 'browse', data: null, loading: true, error: null });
    api.browse(path).then(
      (data) => { if (!cancelled) setView({ kind: 'browse', data, loading: false, error: null }); },
      (err)  => { if (!cancelled) setView({ kind: 'browse', data: null, loading: false, error: err.message }); },
    );
    return () => { cancelled = true; };
  }, [path, refresh]);

  // Navigate to a prefix. If it's the SAME path (e.g. clicking root at root),
  // bump the refresh counter so the effect still re-runs instead of hanging.
  function goTo(newPath: string) {
    if (newPath === path) {
      setRefresh((r) => r + 1);
    } else {
      setPath(newPath);
    }
  }

  function showDump() {
    setView({ kind: 'dump', data: null, loading: true, error: null });
    api.dump(path).then(
      (data) => setView({ kind: 'dump', data, loading: false, error: null }),
      (err)  => setView({ kind: 'dump', data: null, loading: false, error: err.message }),
    );
  }

  function showKey(key: string) {
    setView({ kind: 'key', data: null, loading: true, error: null });
    api.getValue(key).then(
      (data) => setView({ kind: 'key', data, loading: false, error: null }),
      (err)  => setView({ kind: 'key', data: null, loading: false, error: err.message }),
    );
  }

  function runSearch(q: string, mode: 'prefix' | 'substring') {
    if (!q) return;
    setView({ kind: 'search', data: null, loading: true, error: null });
    api.search(q, mode).then(
      (data) => setView({ kind: 'search', data, loading: false, error: null }),
      (err)  => setView({ kind: 'search', data: null, loading: false, error: err.message }),
    );
  }

  function backToBrowse() {
    // Re-run the browse load for the current path (effect keys on path+refresh)
    setRefresh((r) => r + 1);
  }

  // Build breadcrumb segments
  const segments = path.split(':').filter(Boolean);

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div style={styles.brand}>Cache Browser</div>
        <SearchBar onSearch={runSearch} />
        <button style={styles.logoutBtn} onClick={() => { logout(); onLogout(); }}>
          Sign out
        </button>
      </header>

      <div style={styles.breadcrumb}>
        <span style={styles.crumb} onClick={() => goTo('')}>(root)</span>
        {segments.map((seg, i) => {
          const upto = segments.slice(0, i + 1).join(':') + ':';
          return (
            <span key={i}>
              <span style={styles.crumbSep}> / </span>
              <span style={styles.crumb} onClick={() => goTo(upto)}>{seg}</span>
            </span>
          );
        })}
      </div>

      {view.kind === 'browse' && (
        <BrowseView view={view} path={path} onPrefix={goTo} onShowAll={showDump} onKey={showKey} />
      )}
      {view.kind === 'dump' && (
        <DumpView view={view} onBack={backToBrowse} onKey={showKey} />
      )}
      {view.kind === 'key' && (
        <KeyView view={view} onBack={backToBrowse} />
      )}
      {view.kind === 'search' && (
        <SearchView view={view} onBack={backToBrowse} onKey={showKey} />
      )}
    </div>
  );
}

// ---------- Search bar (in header) ----------

function SearchBar({ onSearch }: { onSearch: (q: string, mode: 'prefix' | 'substring') => void }) {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'prefix' | 'substring'>('prefix');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    onSearch(q.trim(), mode);
  }

  return (
    <form onSubmit={submit} style={styles.searchBar}>
      <input
        style={styles.searchInput}
        type="text"
        placeholder={mode === 'prefix' ? 'Search keys starting with…' : 'Search keys containing…'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <select
        style={styles.searchMode}
        value={mode}
        onChange={(e) => setMode(e.target.value as 'prefix' | 'substring')}
        title="prefix = faster, fewer matches; contains = finds anywhere in the key"
      >
        <option value="prefix">prefix</option>
        <option value="substring">contains</option>
      </select>
      <button type="submit" style={styles.searchBtn}>Search</button>
    </form>
  );
}

// ---------- Sub-views ----------

function BrowseView({ view, path, onPrefix, onShowAll, onKey }: {
  view: Extract<View, { kind: 'browse' }>;
  path: string;
  onPrefix: (p: string) => void;
  onShowAll: () => void;
  onKey: (k: string) => void;
}) {
  if (view.loading) return <p style={styles.message}>Loading…</p>;
  if (view.error)   return <p style={styles.error}>Error: {view.error}</p>;
  if (!view.data)   return null;

  const { prefixes, leafKeys, scanned, truncated } = view.data;
  const hasContent = prefixes.length > 0 || leafKeys.length > 0;

  return (
    <div style={styles.body}>
      <div style={styles.toolbar}>
        <span style={styles.muted}>
          {scanned} key{scanned === 1 ? '' : 's'} scanned at "{path || '(root)'}"
          {truncated && ' (truncated)'}
        </span>
        {hasContent && (
          <button style={styles.actionBtn} onClick={onShowAll}>Show all values</button>
        )}
      </div>

      {!hasContent && <p style={styles.muted}>No keys here.</p>}

      {prefixes.length > 0 && (
        <table style={styles.table}>
          <thead>
            <tr><th style={styles.th}>Prefix</th><th style={styles.thRight}>Keys</th></tr>
          </thead>
          <tbody>
            {prefixes.map((p) => (
              <tr key={p.segment} style={styles.row} onClick={() => onPrefix(p.fullPath)}>
                <td style={styles.td}>{p.segment}:</td>
                <td style={styles.tdRight}>{p.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {leafKeys.length > 0 && (
        <>
          <h3 style={styles.section}>Leaf keys at this level</h3>
          <table style={styles.table}>
            <tbody>
              {leafKeys.map((k) => (
                <tr key={k} style={styles.row} onClick={() => onKey(k)}>
                  <td style={styles.td}>{k}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function DumpView({ view, onBack, onKey }: {
  view: Extract<View, { kind: 'dump' }>;
  onBack: () => void;
  onKey: (k: string) => void;
}) {
  if (view.loading) return <p style={styles.message}>Loading…</p>;
  if (view.error)   return <p style={styles.error}>Error: {view.error}</p>;
  if (!view.data)   return null;

  return (
    <div style={styles.body}>
      <div style={styles.toolbar}>
        <span style={styles.muted}>
          {view.data.entries.length} key{view.data.entries.length === 1 ? '' : 's'}
          {view.data.truncated && ' (truncated)'}
        </span>
        <button style={styles.actionBtn} onClick={onBack}>Back to prefixes</button>
      </div>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Key</th>
            <th style={styles.th}>Type</th>
            <th style={styles.th}>Value</th>
            <th style={styles.thRight}>TTL</th>
          </tr>
        </thead>
        <tbody>
          {view.data.entries.map((e) => (
            <tr key={e.key} style={styles.row} onClick={() => onKey(e.key)}>
              <td style={styles.td}>{e.key}</td>
              <td style={styles.td}>{e.type}</td>
              <td style={styles.tdTrunc}>{previewValue(e.value)}</td>
              <td style={styles.tdRight}>{e.ttl === -1 ? '∞' : e.ttl}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeyView({ view, onBack }: {
  view: Extract<View, { kind: 'key' }>;
  onBack: () => void;
}) {
  if (view.loading) return <p style={styles.message}>Loading…</p>;
  if (view.error)   return <p style={styles.error}>Error: {view.error}</p>;
  if (!view.data)   return null;

  const { key, type, value, ttl } = view.data;
  return (
    <div style={styles.body}>
      <div style={styles.toolbar}>
        <button style={styles.actionBtn} onClick={onBack}>Back</button>
      </div>
      <div style={styles.detail}>
        <div style={styles.detailRow}><span style={styles.label}>Key</span><span>{key}</span></div>
        <div style={styles.detailRow}><span style={styles.label}>Type</span><span>{type}</span></div>
        <div style={styles.detailRow}><span style={styles.label}>TTL</span><span>{ttl === -1 ? '∞ (no expiry)' : `${ttl}s`}</span></div>
        <div style={styles.detailRow}>
          <span style={styles.label}>Value</span>
          <pre style={styles.value}>{JSON.stringify(value, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}

function SearchView({ view, onBack, onKey }: {
  view: Extract<View, { kind: 'search' }>;
  onBack: () => void;
  onKey: (k: string) => void;
}) {
  if (view.loading) return <p style={styles.message}>Searching…</p>;
  if (view.error)   return <p style={styles.error}>Error: {view.error}</p>;
  if (!view.data)   return null;

  const { query, mode, entries, matched, truncated } = view.data;

  return (
    <div style={styles.body}>
      <div style={styles.toolbar}>
        <span style={styles.muted}>
          {matched} match{matched === 1 ? '' : 'es'} for "{query}" ({mode})
          {truncated && ' — truncated, narrow your search'}
        </span>
        <button style={styles.actionBtn} onClick={onBack}>Back to browse</button>
      </div>

      {entries.length === 0 && <p style={styles.muted}>No keys matched.</p>}

      {entries.length > 0 && (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Key</th>
              <th style={styles.th}>Type</th>
              <th style={styles.th}>Value</th>
              <th style={styles.thRight}>TTL</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.key} style={styles.row} onClick={() => onKey(e.key)}>
                <td style={styles.td}>{e.key}</td>
                <td style={styles.td}>{e.type}</td>
                <td style={styles.tdTrunc}>{previewValue(e.value)}</td>
                <td style={styles.tdRight}>{e.ttl === -1 ? '∞' : e.ttl}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function previewValue(v: any): string {
  if (v === null) return '(null)';
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  const json = JSON.stringify(v);
  return json.length > 60 ? json.slice(0, 60) + '…' : json;
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#0f1419', color: '#e5e7eb', fontFamily: 'system-ui, sans-serif' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 24px', borderBottom: '1px solid #1f2937',
  },
  brand: { fontSize: '15px', fontWeight: 600 },
  logoutBtn: {
    background: 'transparent', color: '#9ca3af', border: '1px solid #374151',
    borderRadius: '4px', padding: '6px 12px', cursor: 'pointer', fontSize: '13px',
  },
  searchBar: { display: 'flex', gap: '6px', flex: 1, maxWidth: '480px', margin: '0 16px' },
  searchInput: {
    flex: 1, padding: '6px 10px', background: '#0f1419', border: '1px solid #2d3748',
    borderRadius: '4px', color: '#e5e7eb', fontSize: '13px',
  },
  searchMode: {
    background: '#0f1419', border: '1px solid #2d3748', borderRadius: '4px',
    color: '#e5e7eb', fontSize: '13px', padding: '0 6px',
  },
  searchBtn: {
    background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px',
    padding: '6px 14px', cursor: 'pointer', fontSize: '13px',
  },
  breadcrumb: { padding: '12px 24px', fontSize: '13px', color: '#9ca3af' },
  crumb: { color: '#3b82f6', cursor: 'pointer', textDecoration: 'underline' },
  crumbSep: { color: '#4b5563' },
  body: { padding: '0 24px 24px 24px' },
  toolbar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: '12px',
  },
  actionBtn: {
    background: '#3b82f6', color: 'white', border: 'none', borderRadius: '4px',
    padding: '6px 12px', cursor: 'pointer', fontSize: '13px',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '14px' },
  th: { textAlign: 'left', padding: '10px 8px', borderBottom: '1px solid #1f2937', color: '#9ca3af', fontWeight: 500 },
  thRight: { textAlign: 'right', padding: '10px 8px', borderBottom: '1px solid #1f2937', color: '#9ca3af', fontWeight: 500 },
  row: { cursor: 'pointer' },
  td: { padding: '10px 8px', borderBottom: '1px solid #1f2937' },
  tdRight: { padding: '10px 8px', borderBottom: '1px solid #1f2937', textAlign: 'right', color: '#9ca3af' },
  tdTrunc: { padding: '10px 8px', borderBottom: '1px solid #1f2937', color: '#9ca3af', fontFamily: 'monospace', fontSize: '12px' },
  section: { marginTop: '24px', marginBottom: '8px', fontSize: '14px', color: '#9ca3af', fontWeight: 500 },
  message: { padding: '24px', color: '#9ca3af' },
  error: { padding: '24px', color: '#ef4444' },
  muted: { color: '#9ca3af', fontSize: '13px' },
  detail: { background: '#1a1f2e', padding: '20px', borderRadius: '6px' },
  detailRow: { display: 'flex', gap: '16px', marginBottom: '12px', fontSize: '14px' },
  label: { color: '#9ca3af', minWidth: '60px' },
  value: {
    background: '#0f1419', padding: '12px', borderRadius: '4px', flex: 1, margin: 0,
    fontFamily: 'monospace', fontSize: '12px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  },
};
