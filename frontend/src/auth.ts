// Cognito custom-UI login.
// We use the AWS SDK's CognitoIdentityProviderClient to call Cognito directly
// (USER_PASSWORD_AUTH flow). No Hosted UI redirect.
//
// Handles two challenges:
//   - NEW_PASSWORD_REQUIRED: the user logs in with the temporary password
//     emailed to them, then must set a permanent one before getting a JWT.

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { config } from './config';

// Created lazily — config is loaded at runtime (after fetch), so we must not
// read config.region at module-load time. First call builds the client once.
let _cognito: CognitoIdentityProviderClient | null = null;
function cognitoClient(): CognitoIdentityProviderClient {
  if (!_cognito) {
    _cognito = new CognitoIdentityProviderClient({ region: config.region });
  }
  return _cognito;
}

const TOKEN_KEY = 'cb_id_token';
const REFRESH_KEY = 'cb_refresh_token';

export type LoginResult =
  | { kind: 'ok'; idToken: string }
  | { kind: 'newPasswordRequired'; session: string; username: string };

export async function login(username: string, password: string): Promise<LoginResult> {
  const out = await cognitoClient().send(new InitiateAuthCommand({
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: config.userPoolClientId,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  }));

  if (out.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
    return { kind: 'newPasswordRequired', session: out.Session!, username };
  }

  const idToken = out.AuthenticationResult?.IdToken;
  const refreshToken = out.AuthenticationResult?.RefreshToken;
  if (!idToken) throw new Error('Login succeeded but no token returned');

  localStorage.setItem(TOKEN_KEY, idToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  return { kind: 'ok', idToken };
}

export async function completeNewPassword(
  username: string,
  session: string,
  newPassword: string,
): Promise<string> {
  const out = await cognitoClient().send(new RespondToAuthChallengeCommand({
    ClientId: config.userPoolClientId,
    ChallengeName: 'NEW_PASSWORD_REQUIRED',
    Session: session,
    ChallengeResponses: { USERNAME: username, NEW_PASSWORD: newPassword },
  }));

  const idToken = out.AuthenticationResult?.IdToken;
  const refreshToken = out.AuthenticationResult?.RefreshToken;
  if (!idToken) throw new Error('Password change accepted but no token returned');

  localStorage.setItem(TOKEN_KEY, idToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  return idToken;
}

export function getStoredToken(): string | null {
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) return null;
  // Naively check expiry (decode the JWT payload, check `exp`)
  try {
    const payload = JSON.parse(atob(t.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) {
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return t;
  } catch {
    return null;
  }
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}
