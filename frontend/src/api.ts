// Thin wrapper around the cache browser API.
// Every call attaches the stored JWT in the Authorization header.

import { config } from './config';
import { getStoredToken } from './auth';

export interface Prefix {
  segment: string;
  fullPath: string;
  count: number;
}

export interface BrowseResult {
  path: string;
  prefixes: Prefix[];
  leafKeys: string[];
  scanned: number;
  truncated: boolean;
}

export interface KeyEntry {
  key: string;
  type: string;
  value: any;
  ttl: number;
}

export interface DumpResult {
  path: string;
  entries: KeyEntry[];
  truncated: boolean;
}

async function call<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const token = getStoredToken();
  if (!token) throw new Error('Not logged in');

  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${config.apiBaseUrl}${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${endpoint} failed (${res.status}): ${body}`);
  }
  return res.json();
}

export interface SearchResult {
  query: string;
  mode: string;
  entries: KeyEntry[];
  matched: number;
  scanned: number;
  truncated: boolean;
}

export const api = {
  browse: (path: string, delimiter = ':') => call<BrowseResult>('/browse', { path, delimiter }),
  dump:   (path: string, limit = '100')   => call<DumpResult>('/dump',     { path, limit }),
  getValue: (key: string)                 => call<KeyEntry>('/getValue',   { key }),
  search: (q: string, mode: 'prefix' | 'substring') => call<SearchResult>('/search', { q, mode }),
};
