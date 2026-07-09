import { useState } from 'react';
import { login, completeNewPassword } from './auth';

interface Props {
  onLoggedIn: () => void;
}

export function LoginScreen({ onLoggedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState<{ session: string; username: string } | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await login(email, password);
      if (result.kind === 'newPasswordRequired') {
        setChallenge({ session: result.session, username: result.username });
      } else {
        onLoggedIn();
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleNewPassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== newPassword2) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await completeNewPassword(challenge!.username, challenge!.session, newPassword);
      onLoggedIn();
    } catch (err: any) {
      setError(err.message || 'Password change failed');
    } finally {
      setLoading(false);
    }
  }

  if (challenge) {
    return (
      <div style={styles.wrap}>
        <form onSubmit={handleNewPassword} style={styles.form}>
          <h1 style={styles.title}>Set a new password</h1>
          <p style={styles.subtitle}>First-time login. Choose a permanent password.</p>
          <input
            style={styles.input}
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            autoFocus
          />
          <input
            style={styles.input}
            type="password"
            placeholder="Confirm new password"
            value={newPassword2}
            onChange={(e) => setNewPassword2(e.target.value)}
            required
          />
          {error && <p style={styles.error}>{error}</p>}
          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? 'Setting…' : 'Set password'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <form onSubmit={handleLogin} style={styles.form}>
        <h1 style={styles.title}>Cache Browser</h1>
        <p style={styles.subtitle}>Sign in to continue</p>
        <input
          style={styles.input}
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
        <input
          style={styles.input}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p style={styles.error}>{error}</p>}
        <button type="submit" style={styles.button} disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f1419',
  },
  form: {
    background: '#1a1f2e',
    padding: '32px',
    borderRadius: '8px',
    width: '320px',
    color: '#e5e7eb',
  },
  title: { margin: '0 0 4px 0', fontSize: '20px', fontWeight: 600 },
  subtitle: { margin: '0 0 24px 0', fontSize: '13px', color: '#9ca3af' },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    marginBottom: '12px',
    background: '#0f1419',
    border: '1px solid #2d3748',
    borderRadius: '4px',
    color: '#e5e7eb',
    fontSize: '14px',
  },
  button: {
    width: '100%',
    padding: '10px',
    background: '#3b82f6',
    border: 'none',
    borderRadius: '4px',
    color: 'white',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    marginTop: '4px',
  },
  error: {
    color: '#ef4444',
    fontSize: '13px',
    margin: '0 0 12px 0',
  },
};
