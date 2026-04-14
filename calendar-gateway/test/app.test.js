const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { deriveKeyFromSecret, sha256Hex, signPayload } = require('../src/crypto');
const { ConnectionStore } = require('../src/store');

async function createFixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'calendar-gateway-test-'));
  const config = {
    clinicName: 'Demo Dental Clinic',
    publicBaseUrl: 'http://127.0.0.1:0',
    publicCalendarBaseUrl: 'http://127.0.0.1:0/calendar',
    oauthCallbackUrl: 'http://127.0.0.1:0/calendar/oauth/callback',
    dataDir,
    dataFilePath: path.join(dataDir, 'connections.json'),
    defaultConnectionId: 'clinic-default',
    defaultCalendarId: 'primary',
    connectToken: 'connect-secret',
    connectTokenHash: sha256Hex('connect-secret'),
    internalApiKey: 'internal-secret',
    encryptionKey: deriveKeyFromSecret('encryption-secret'),
    googleClientId: 'client-id',
    googleClientSecret: 'client-secret',
    googleScopes: ['https://www.googleapis.com/auth/calendar'],
    stateTtlMs: 15 * 60 * 1000,
    selectionTtlMs: 30 * 60 * 1000,
    readyChecks: {
      publicConnect: true,
      internalApi: true,
      googleOAuth: true
    },
    startupWarnings: []
  };

  const store = new ConnectionStore({
    filePath: config.dataFilePath,
    encryptionKey: config.encryptionKey
  });
  await store.init();

  const providerCalls = [];
  const calendarProvider = {
    buildAuthUrl({ state }) {
      providerCalls.push({ type: 'buildAuthUrl', state });
      return `https://accounts.example.test/oauth?state=${encodeURIComponent(state)}`;
    },
    async exchangeCode({ code }) {
      providerCalls.push({ type: 'exchangeCode', code });
      return {
        refreshToken: 'refresh-token-001',
        scopes: ['https://www.googleapis.com/auth/calendar'],
        profile: {
          googleUserId: 'user_123',
          email: 'owner@example.com',
          verifiedEmail: true
        }
      };
    },
    async listCalendars({ refreshToken }) {
      providerCalls.push({ type: 'listCalendars', refreshToken });
      return [
        { id: 'primary', summary: 'Primary Calendar', primary: true, accessRole: 'owner' },
        { id: 'team-calendar@example.com', summary: 'Team Calendar', primary: false, accessRole: 'writer' }
      ];
    },
    async listBusyEvents({ refreshToken }, payload) {
      providerCalls.push({ type: 'listBusyEvents', refreshToken, payload });
      return [
        {
          start: '2030-03-18T10:00:00+01:00',
          end: '2030-03-18T10:45:00+01:00'
        }
      ];
    },
    async createEvent() {
      providerCalls.push({ type: 'createEvent' });
      return {
        eventId: 'evt_123',
        calendarId: 'primary',
        htmlLink: 'https://calendar.google.com/event?eid=evt_123'
      };
    }
  };

  const app = createApp({ config, store, calendarProvider });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    baseUrl,
    config,
    store,
    providerCalls,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  };
}

test('connect page accepts a valid connect token', async () => {
  const fixture = await createFixture();
  try {
    const response = await fetch(
      `${fixture.baseUrl}/calendar/connect?connectionId=clinic-default&token=connect-secret`
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Połącz Kalendarz Google/);
    assert.match(html, /AI Receptionist używa tej bezpiecznej strony/);
    assert.doesNotMatch(html, /Demo Dental Clinic/);
    assert.match(html, /Kontynuuj z Google/);
  } finally {
    await fixture.close();
  }
});

test('oauth callback stores the refresh token and renders calendar selection', async () => {
  const fixture = await createFixture();
  try {
    const state = signPayload(
      {
        type: 'oauth',
        issuedAt: Date.now(),
        connectionId: 'clinic-default',
        connectTokenHash: fixture.config.connectTokenHash,
        preferredCalendarId: null
      },
      fixture.config.encryptionKey
    );
    const response = await fetch(
      `${fixture.baseUrl}/calendar/oauth/callback?code=code-123&state=${encodeURIComponent(state)}`
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Wybierz kalendarz do rezerwacji/);
    assert.match(html, /Primary Calendar/);
    const connection = await fixture.store.getConnection('clinic-default');
    assert.equal(connection.status, 'connected');
    assert.equal(connection.googleAccountEmail, 'owner@example.com');
    assert.equal(connection.selectedCalendarId, 'primary');
  } finally {
    await fixture.close();
  }
});

test('internal availability API uses the stored connected account', async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.saveConnectedAccount({
      connectionId: 'clinic-default',
      profile: {
        googleUserId: 'user_123',
        email: 'owner@example.com',
        verifiedEmail: true
      },
      refreshToken: 'refresh-token-001',
      scopes: ['https://www.googleapis.com/auth/calendar'],
      selectedCalendarId: 'primary',
      selectedCalendarSummary: 'Primary Calendar'
    });
    await fixture.store.updateSelectedCalendar('clinic-default', {
      id: 'primary',
      summary: 'Primary Calendar'
    });

    const response = await fetch(`${fixture.baseUrl}/api/v1/availability`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer internal-secret'
      },
      body: JSON.stringify({
        connectionId: 'clinic-default',
        timeMin: '2030-03-18T09:00:00+01:00',
        timeMax: '2030-03-18T12:00:00+01:00'
      })
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.calendarId, 'primary');
    assert.equal(Array.isArray(payload.busy), true);
    assert.equal(payload.busy.length, 1);
    const listBusyCall = fixture.providerCalls.find((call) => call.type === 'listBusyEvents');
    assert.equal(listBusyCall.payload.calendarId, 'primary');
  } finally {
    await fixture.close();
  }
});

test('internal event creation API uses the stored connected account', async () => {
  const fixture = await createFixture();
  try {
    await fixture.store.saveConnectedAccount({
      connectionId: 'clinic-default',
      profile: {
        googleUserId: 'user_123',
        email: 'owner@example.com',
        verifiedEmail: true
      },
      refreshToken: 'refresh-token-001',
      scopes: ['https://www.googleapis.com/auth/calendar'],
      selectedCalendarId: 'primary',
      selectedCalendarSummary: 'Primary Calendar'
    });
    await fixture.store.updateSelectedCalendar('clinic-default', {
      id: 'primary',
      summary: 'Primary Calendar'
    });

    const response = await fetch(`${fixture.baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer internal-secret'
      },
      body: JSON.stringify({
        connectionId: 'clinic-default',
        start: '2030-03-18T10:00:00+01:00',
        end: '2030-03-18T10:45:00+01:00',
        summary: 'Consultation - Jan Testowy',
        description: 'Patient: Jan Testowy'
      })
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.calendarId, 'primary');
    assert.equal(payload.eventId, 'evt_123');
    const createEventCall = fixture.providerCalls.find((call) => call.type === 'createEvent');
    assert.ok(createEventCall);
  } finally {
    await fixture.close();
  }
});
