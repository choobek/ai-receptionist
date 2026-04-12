const path = require('node:path');
const { deriveKeyFromSecret, sha256Hex } = require('./crypto');

function readEnv(name, fallback = '') {
  const value = process.env[name];
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stripTrailingSlash(value) {
  if (!value) return '';
  return value.replace(/\/+$/, '');
}

function parseScopes(value) {
  const raw = String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return raw.length > 0
    ? raw
    : [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/userinfo.email'
      ];
}

function loadConfig(env = process.env) {
  const port = parsePort(env.CALENDAR_GATEWAY_PORT, 3000);
  const publicBaseUrl = stripTrailingSlash(
    readEnv('CALENDAR_GATEWAY_PUBLIC_BASE_URL', `http://localhost:${port}`)
  );
  const encryptionSecret = readEnv('CALENDAR_GATEWAY_ENCRYPTION_KEY');
  const connectToken = readEnv('CALENDAR_GATEWAY_CONNECT_TOKEN');
  const internalApiKey = readEnv('CALENDAR_GATEWAY_INTERNAL_API_KEY');
  const config = {
    nodeEnv: readEnv('NODE_ENV', 'development'),
    port,
    clinicName: readEnv('CLINIC_NAME', 'Clinic'),
    publicBaseUrl,
    publicCalendarBaseUrl: `${publicBaseUrl}/calendar`,
    oauthCallbackUrl: `${publicBaseUrl}/calendar/oauth/callback`,
    dataDir: readEnv('CALENDAR_GATEWAY_DATA_DIR', path.join(__dirname, '..', '..', 'data')),
    dataFilePath: path.join(
      readEnv('CALENDAR_GATEWAY_DATA_DIR', path.join(__dirname, '..', '..', 'data')),
      'connections.json'
    ),
    defaultConnectionId: readEnv('GOOGLE_CALENDAR_CONNECTION_ID', 'clinic-default'),
    defaultCalendarId: readEnv('GOOGLE_CALENDAR_ID', 'primary'),
    connectToken,
    connectTokenHash: connectToken ? sha256Hex(connectToken) : '',
    internalApiKey,
    encryptionKey: deriveKeyFromSecret(encryptionSecret),
    googleClientId: readEnv('GOOGLE_OAUTH_CLIENT_ID'),
    googleClientSecret: readEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    googleScopes: parseScopes(readEnv('GOOGLE_OAUTH_SCOPES')),
    stateTtlMs: 15 * 60 * 1000,
    selectionTtlMs: 30 * 60 * 1000
  };

  config.readyChecks = {
    publicConnect: Boolean(
      config.connectToken &&
        config.encryptionKey &&
        config.googleClientId &&
        config.googleClientSecret &&
        config.publicBaseUrl
    ),
    internalApi: Boolean(config.internalApiKey && config.encryptionKey),
    googleOAuth: Boolean(
      config.googleClientId &&
        config.googleClientSecret &&
        config.publicBaseUrl &&
        config.encryptionKey
    )
  };

  const warnings = [];
  if (!config.connectToken) warnings.push('CALENDAR_GATEWAY_CONNECT_TOKEN is not set');
  if (!config.internalApiKey) warnings.push('CALENDAR_GATEWAY_INTERNAL_API_KEY is not set');
  if (!config.encryptionKey) warnings.push('CALENDAR_GATEWAY_ENCRYPTION_KEY is not set');
  if (!config.googleClientId) warnings.push('GOOGLE_OAUTH_CLIENT_ID is not set');
  if (!config.googleClientSecret) warnings.push('GOOGLE_OAUTH_CLIENT_SECRET is not set');
  if (!config.publicBaseUrl) warnings.push('CALENDAR_GATEWAY_PUBLIC_BASE_URL is not set');
  config.startupWarnings = warnings;
  return config;
}

module.exports = {
  loadConfig
};
