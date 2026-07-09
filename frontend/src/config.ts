// Cache Browser configuration — loaded at RUNTIME from /config.json.
//
// The four values are NOT compiled into the build. They live in
// public/config.json, which is copied into dist/ as a standalone file.
// This makes the built dist/ portable: anyone can edit config.json and
// deploy without rebuilding. loadConfig() is called once at startup
// (see main.tsx) before the app renders.

export interface AppConfig {
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  apiBaseUrl: string;
}

// Populated by loadConfig() before the app renders.
export let config: AppConfig = {
  region: '',
  userPoolId: '',
  userPoolClientId: '',
  apiBaseUrl: '',
};

export async function loadConfig(): Promise<void> {
  const res = await fetch('/config.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load config.json (${res.status}). Is it deployed next to index.html?`);
  }
  config = await res.json();
}
