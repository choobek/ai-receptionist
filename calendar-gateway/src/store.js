const fs = require('node:fs/promises');
const path = require('node:path');
const { decryptJson, encryptJson } = require('./crypto');

function createEmptyState() {
  return {
    version: 1,
    connections: {}
  };
}

function sanitizeConnection(record) {
  if (!record) return null;
  return {
    connectionId: record.connectionId,
    status: record.status || 'not_connected',
    googleAccountEmail: record.googleAccountEmail || null,
    googleUserId: record.googleUserId || null,
    googleVerifiedEmail: record.googleVerifiedEmail === true,
    scopes: Array.isArray(record.scopes) ? record.scopes : [],
    selectedCalendarId: record.selectedCalendarId || null,
    selectedCalendarSummary: record.selectedCalendarSummary || null,
    connectedAt: record.connectedAt || null,
    updatedAt: record.updatedAt || null,
    lastVerifiedAt: record.lastVerifiedAt || null,
    lastError: record.lastError || null,
    hasRefreshToken: Boolean(record.secrets)
  };
}

class ConnectionStore {
  constructor({ filePath, encryptionKey }) {
    this.filePath = filePath;
    this.encryptionKey = encryptionKey;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch (error) {
      await this.#saveUnlocked(createEmptyState());
    }
  }

  async #loadUnlocked() {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.connections !== 'object') {
        return createEmptyState();
      }
      return parsed;
    } catch (error) {
      if (error && error.code === 'ENOENT') return createEmptyState();
      throw error;
    }
  }

  async #saveUnlocked(state) {
    const nextState = state && typeof state === 'object' ? state : createEmptyState();
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, this.filePath);
  }

  async #withWriteLock(fn) {
    let result;
    this.writeQueue = this.writeQueue.then(async () => {
      const state = await this.#loadUnlocked();
      result = await fn(state);
      await this.#saveUnlocked(state);
      return result;
    });
    await this.writeQueue;
    return result;
  }

  async getConnection(connectionId) {
    const state = await this.#loadUnlocked();
    return sanitizeConnection(state.connections[connectionId] || null);
  }

  async getConnectionWithSecrets(connectionId) {
    const state = await this.#loadUnlocked();
    const record = state.connections[connectionId];
    if (!record) return null;
    const secrets = record.secrets ? decryptJson(record.secrets, this.encryptionKey) : null;
    return {
      connection: sanitizeConnection(record),
      refreshToken: secrets && typeof secrets.refreshToken === 'string' ? secrets.refreshToken : null,
      raw: record
    };
  }

  async saveConnectedAccount({
    connectionId,
    profile,
    refreshToken,
    scopes,
    selectedCalendarId,
    selectedCalendarSummary
  }) {
    return this.#withWriteLock(async (state) => {
      const now = new Date().toISOString();
      const existing = state.connections[connectionId] || { connectionId, connectedAt: now };
      const existingSecrets = existing.secrets
        ? decryptJson(existing.secrets, this.encryptionKey)
        : null;
      const effectiveRefreshToken =
        (typeof refreshToken === 'string' && refreshToken.trim()) ||
        existingSecrets?.refreshToken ||
        '';
      if (!effectiveRefreshToken) {
        throw new Error('Google OAuth did not return a refresh token');
      }

      state.connections[connectionId] = {
        ...existing,
        connectionId,
        status: 'connected',
        googleAccountEmail: profile?.email || existing.googleAccountEmail || null,
        googleUserId: profile?.googleUserId || existing.googleUserId || null,
        googleVerifiedEmail: profile?.verifiedEmail === true,
        scopes: Array.isArray(scopes) ? scopes : existing.scopes || [],
        selectedCalendarId:
          selectedCalendarId || existing.selectedCalendarId || null,
        selectedCalendarSummary:
          selectedCalendarSummary || existing.selectedCalendarSummary || null,
        connectedAt: existing.connectedAt || now,
        updatedAt: now,
        lastVerifiedAt: now,
        lastError: null,
        secrets: encryptJson({ refreshToken: effectiveRefreshToken }, this.encryptionKey)
      };

      return sanitizeConnection(state.connections[connectionId]);
    });
  }

  async updateSelectedCalendar(connectionId, calendar) {
    return this.#withWriteLock(async (state) => {
      const record = state.connections[connectionId];
      if (!record) return null;
      record.selectedCalendarId = calendar?.id || null;
      record.selectedCalendarSummary = calendar?.summary || calendar?.id || null;
      record.updatedAt = new Date().toISOString();
      state.connections[connectionId] = record;
      return sanitizeConnection(record);
    });
  }

  async markHealthy(connectionId) {
    return this.#withWriteLock(async (state) => {
      const record = state.connections[connectionId];
      if (!record) return null;
      record.status = 'connected';
      record.lastVerifiedAt = new Date().toISOString();
      record.updatedAt = record.lastVerifiedAt;
      record.lastError = null;
      state.connections[connectionId] = record;
      return sanitizeConnection(record);
    });
  }

  async recordError(connectionId, error) {
    return this.#withWriteLock(async (state) => {
      const record = state.connections[connectionId];
      if (!record) return null;
      record.status = error?.reauthRequired ? 'reauthorization_required' : record.status || 'connected';
      record.lastError = {
        code: error?.code || 'UNKNOWN_ERROR',
        message: error?.message || 'Unknown error',
        at: new Date().toISOString()
      };
      record.updatedAt = record.lastError.at;
      state.connections[connectionId] = record;
      return sanitizeConnection(record);
    });
  }
}

module.exports = {
  ConnectionStore
};
