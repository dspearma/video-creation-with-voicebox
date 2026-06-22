const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Token storage path (persisted so user doesn't re-auth on every restart)
const TOKEN_PATH = path.join(__dirname, '..', '.google-tokens.json');

let oAuth2Client = null;

/**
 * Initialize the OAuth2 client from environment variables.
 */
function getOAuth2Client() {
  if (oAuth2Client) return oAuth2Client;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

  if (!clientId || !clientSecret) {
    return null; // Google auth not configured
  }

  oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // Load saved tokens if they exist
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      oAuth2Client.setCredentials(tokens);
    } catch {
      // Ignore corrupted token file
    }
  }

  // Auto-refresh tokens and save new ones
  oAuth2Client.on('tokens', (tokens) => {
    const existing = fs.existsSync(TOKEN_PATH)
      ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
      : {};
    const merged = { ...existing, ...tokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  });

  return oAuth2Client;
}

/**
 * Generate the Google OAuth consent URL.
 * Requests read-only access to Google Docs and Google Drive.
 */
function getAuthUrl() {
  const client = getOAuth2Client();
  if (!client) return null;

  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/documents.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  });
}

/**
 * Exchange an authorization code for tokens and persist them.
 */
async function handleCallback(code) {
  const client = getOAuth2Client();
  if (!client) throw new Error('Google OAuth not configured');

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), 'utf-8');
  return tokens;
}

/**
 * Check whether the user has valid Google credentials.
 */
function isAuthenticated() {
  const client = getOAuth2Client();
  if (!client) return false;
  const creds = client.credentials;
  return !!(creds && creds.access_token);
}

/**
 * Get an authenticated OAuth2 client (or null if not authenticated).
 */
function getAuthenticatedClient() {
  const client = getOAuth2Client();
  if (!client) return null;
  if (!client.credentials || !client.credentials.access_token) return null;
  return client;
}

/**
 * Revoke Google credentials and clear stored tokens.
 */
async function revokeAuth() {
  const client = getOAuth2Client();
  if (client && client.credentials && client.credentials.access_token) {
    try {
      await client.revokeCredentials();
    } catch {
      // Ignore revocation errors
    }
  }
  if (fs.existsSync(TOKEN_PATH)) {
    fs.unlinkSync(TOKEN_PATH);
  }
  oAuth2Client = null;
}

module.exports = {
  getOAuth2Client,
  getAuthUrl,
  handleCallback,
  isAuthenticated,
  getAuthenticatedClient,
  revokeAuth,
};
