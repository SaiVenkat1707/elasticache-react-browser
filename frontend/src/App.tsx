import { useState } from 'react';
import { LoginScreen } from './LoginScreen';
import { BrowserScreen } from './BrowserScreen';
import { getStoredToken } from './auth';

export function App() {
  const [loggedIn, setLoggedIn] = useState(!!getStoredToken());

  if (!loggedIn) {
    return <LoginScreen onLoggedIn={() => setLoggedIn(true)} />;
  }
  return <BrowserScreen onLogout={() => setLoggedIn(false)} />;
}
