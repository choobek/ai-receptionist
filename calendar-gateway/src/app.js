const express = require('express');
const { signPayload, verifySignedPayload, sha256Hex } = require('./crypto');
const { CalendarProviderError } = require('./google-provider');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
  if (!value) return 'never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function renderPage({ title, body, status = 200 }) {
  return {
    status,
    html: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f0e8;
        --paper: #fffaf3;
        --ink: #1f1b18;
        --muted: #5d554f;
        --line: #d9cec2;
        --accent: #0f766e;
        --accent-ink: #f8fffd;
        --danger: #b42318;
        --success: #0f6b3c;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(15,118,110,0.12), transparent 28rem),
          radial-gradient(circle at bottom right, rgba(191,115,75,0.12), transparent 32rem),
          var(--bg);
      }
      main {
        max-width: 720px;
        margin: 0 auto;
        padding: 32px 20px 56px;
      }
      .card {
        background: var(--paper);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 28px;
        box-shadow: 0 18px 50px rgba(31, 27, 24, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 2rem;
        line-height: 1.1;
      }
      h2 {
        margin: 24px 0 10px;
        font-size: 1rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      p, li {
        line-height: 1.55;
      }
      .muted { color: var(--muted); }
      .status {
        display: inline-block;
        margin: 0 0 16px;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 0.85rem;
        font-weight: 600;
        background: rgba(15,118,110,0.12);
        color: var(--accent);
      }
      .status.error {
        background: rgba(180,35,24,0.12);
        color: var(--danger);
      }
      .status.success {
        background: rgba(15,107,60,0.12);
        color: var(--success);
      }
      .panel {
        margin-top: 16px;
        padding: 16px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.72);
      }
      .button, button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 46px;
        padding: 0 18px;
        border: 0;
        border-radius: 999px;
        background: var(--accent);
        color: var(--accent-ink);
        font: inherit;
        font-weight: 700;
        text-decoration: none;
        cursor: pointer;
      }
      .button.secondary, button.secondary {
        background: transparent;
        color: var(--ink);
        border: 1px solid var(--line);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 24px;
      }
      code {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        background: rgba(31,27,24,0.06);
        padding: 2px 6px;
        border-radius: 6px;
      }
      form {
        margin-top: 18px;
      }
      label.option {
        display: block;
        margin: 0 0 10px;
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,255,255,0.8);
      }
      label.option input {
        margin-right: 10px;
      }
      ul {
        padding-left: 20px;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        ${body}
      </div>
    </main>
  </body>
</html>`
  };
}

function sendPage(res, page) {
  res.status(page.status).type('html').send(page.html);
}

function jsonError(res, status, code, message, details = []) {
  res.status(status).json({
    error: {
      code,
      message,
      details
    }
  });
}

function validateIsoDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

function summarizeProviderError(error) {
  if (!error) return { status: 502, code: 'GOOGLE_API_ERROR', message: 'Google Calendar request failed' };
  return {
    status: Number(error.status) || 502,
    code: error.code || 'GOOGLE_API_ERROR',
    message: error.message || 'Google Calendar request failed',
    reauthRequired: error.reauthRequired === true
  };
}

function createApp({ config, store, calendarProvider }) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  const buildSignedToken = (payload) => signPayload(payload, config.encryptionKey);

  const verifySignedToken = (token, expectedType, ttlMs) => {
    const payload = verifySignedPayload(token, config.encryptionKey);
    if (!payload || payload.type !== expectedType || !payload.issuedAt) {
      throw new Error('Invalid token payload');
    }
    if (Date.now() - Number(payload.issuedAt) > ttlMs) {
      throw new Error('Token expired');
    }
    return payload;
  };

  const requireConnectPageReady = (res) => {
    if (config.readyChecks.publicConnect) return true;
    sendPage(
      res,
      renderPage({
        title: 'Calendar Connection Unavailable',
        status: 503,
        body: `
          <div class="status error">Setup required</div>
          <h1>Calendar connection is not configured yet</h1>
          <p class="muted">The clinic still needs to finish the Google OAuth setup for this environment.</p>
        `
      })
    );
    return false;
  };

  const requireApiReady = (res) => {
    if (config.readyChecks.internalApi && config.readyChecks.googleOAuth) return true;
    jsonError(res, 503, 'CALENDAR_GATEWAY_NOT_CONFIGURED', 'Calendar gateway is not fully configured');
    return false;
  };

  const verifyConnectToken = (providedToken) => {
    if (!config.connectTokenHash) return false;
    return sha256Hex(providedToken || '') === config.connectTokenHash;
  };

  const requireInternalApiKey = (req, res, next) => {
    if (!requireApiReady(res)) return;
    const headerValue = req.get('authorization') || req.get('x-calendar-gateway-key') || '';
    const bearerMatch = headerValue.match(/^Bearer\s+(.+)$/i);
    const providedKey = bearerMatch ? bearerMatch[1].trim() : headerValue.trim();
    if (!providedKey || providedKey !== config.internalApiKey) {
      jsonError(res, 401, 'UNAUTHORIZED', 'Calendar gateway request is unauthorized');
      return;
    }
    next();
  };

  const resolveConnectionContext = async (connectionId) => {
    const effectiveConnectionId = connectionId || config.defaultConnectionId;
    const connectionWithSecrets = await store.getConnectionWithSecrets(effectiveConnectionId);
    if (!connectionWithSecrets) {
      throw {
        status: 404,
        code: 'CALENDAR_CONNECTION_NOT_FOUND',
        message: `No stored calendar connection exists for ${effectiveConnectionId}`
      };
    }
    if (!connectionWithSecrets.refreshToken) {
      throw {
        status: 409,
        code: 'CALENDAR_CONNECTION_NOT_READY',
        message: `The calendar connection ${effectiveConnectionId} does not have a refresh token`,
        reauthRequired: true
      };
    }
    return {
      connectionId: effectiveConnectionId,
      connection: connectionWithSecrets.connection,
      refreshToken: connectionWithSecrets.refreshToken
    };
  };

  const loadWritableCalendars = async (connectionContext) => {
    const calendars = await calendarProvider.listCalendars({
      refreshToken: connectionContext.refreshToken
    });
    await store.markHealthy(connectionContext.connectionId);
    return calendars;
  };

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      service: 'calendar-gateway',
      warnings: config.startupWarnings
    });
  });

  app.get('/calendar/healthz', (_req, res) => {
    res.json({
      ok: true,
      service: 'calendar-gateway'
    });
  });

  app.get('/calendar', (_req, res) => {
    sendPage(
      res,
      renderPage({
        title: 'Calendar Gateway',
        body: `
          <div class="status">Calendar gateway</div>
          <h1>Use the full connection link</h1>
          <p class="muted">This page is intended to be opened through a clinic-issued Google Calendar connection URL.</p>
        `
      })
    );
  });

  const renderConnectPage = async (req, res) => {
    if (!requireConnectPageReady(res)) return;
    const connectionId = String(req.query.connectionId || '').trim();
    const providedToken = String(req.query.token || '').trim();
    const preferredCalendarId = String(req.query.calendarId || '').trim();
    if (!connectionId || !providedToken || !verifyConnectToken(providedToken)) {
      sendPage(
        res,
        renderPage({
          title: 'Access Denied',
          status: 403,
          body: `
            <div class="status error">Access denied</div>
            <h1>This connection link is invalid</h1>
            <p class="muted">Please return to the clinic and ask for a fresh Google Calendar connection link.</p>
          `
        })
      );
      return;
    }

    const connection = await store.getConnection(connectionId);
    const startUrl = new URL('/calendar/oauth/start', config.publicBaseUrl);
    startUrl.searchParams.set('connectionId', connectionId);
    startUrl.searchParams.set('token', providedToken);
    if (preferredCalendarId) startUrl.searchParams.set('calendarId', preferredCalendarId);

    const statusPill = connection?.status === 'connected'
      ? '<div class="status success">Connected</div>'
      : connection?.status === 'reauthorization_required'
        ? '<div class="status error">Reconnect required</div>'
        : '<div class="status">Not connected</div>';

    const connectionDetails = connection
      ? `
        <div class="panel">
          <p><strong>Connection ID:</strong> <code>${escapeHtml(connection.connectionId)}</code></p>
          <p><strong>Google account:</strong> ${escapeHtml(connection.googleAccountEmail || 'not connected yet')}</p>
          <p><strong>Selected calendar:</strong> ${escapeHtml(connection.selectedCalendarSummary || connection.selectedCalendarId || 'not selected yet')}</p>
          <p><strong>Last verified:</strong> ${escapeHtml(formatDateTime(connection.lastVerifiedAt))}</p>
          ${
            connection.lastError
              ? `<p><strong>Last error:</strong> ${escapeHtml(connection.lastError.message)}</p>`
              : ''
          }
        </div>
      `
      : '';

    sendPage(
      res,
      renderPage({
        title: 'Connect Google Calendar',
        body: `
          ${statusPill}
          <h1>Connect your Google Calendar</h1>
          <p>${escapeHtml(config.clinicName)} uses this secure page to connect the calendar that should be used for appointment scheduling.</p>
          <p class="muted">Google will ask you to sign in and approve calendar access. After approval, you can confirm which writable calendar should receive bookings.</p>
          ${connectionDetails}
          <div class="actions">
            <a class="button" href="${escapeHtml(startUrl.toString())}">${connection?.status === 'connected' ? 'Reconnect with Google' : 'Continue with Google'}</a>
          </div>
        `
      })
    );
  };

  app.get('/calendar/connect', (req, res, next) => {
    Promise.resolve(renderConnectPage(req, res)).catch(next);
  });

  app.get('/calendar/status', (req, res, next) => {
    Promise.resolve(renderConnectPage(req, res)).catch(next);
  });

  app.get('/calendar/oauth/start', async (req, res, next) => {
    try {
      if (!requireConnectPageReady(res)) return;
      const connectionId = String(req.query.connectionId || '').trim();
      const providedToken = String(req.query.token || '').trim();
      const preferredCalendarId = String(req.query.calendarId || '').trim();
      if (!connectionId || !providedToken || !verifyConnectToken(providedToken)) {
        sendPage(
          res,
          renderPage({
            title: 'Access Denied',
            status: 403,
            body: `
              <div class="status error">Access denied</div>
              <h1>This connection link is invalid</h1>
              <p class="muted">Please return to the clinic and ask for a fresh connection link.</p>
            `
          })
        );
        return;
      }
      const state = buildSignedToken({
        type: 'oauth',
        issuedAt: Date.now(),
        connectionId,
        connectTokenHash: config.connectTokenHash,
        preferredCalendarId: preferredCalendarId || null
      });
      res.redirect(calendarProvider.buildAuthUrl({ state }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/calendar/oauth/callback', async (req, res, next) => {
    try {
      if (!requireConnectPageReady(res)) return;
      if (req.query.error) {
        sendPage(
          res,
          renderPage({
            title: 'Connection Cancelled',
            status: 400,
            body: `
              <div class="status error">Google sign-in did not finish</div>
              <h1>Calendar connection was not completed</h1>
              <p class="muted">Google returned: <code>${escapeHtml(req.query.error)}</code>.</p>
            `
          })
        );
        return;
      }

      const code = String(req.query.code || '').trim();
      const stateToken = String(req.query.state || '').trim();
      if (!code || !stateToken) {
        sendPage(
          res,
          renderPage({
            title: 'Invalid Callback',
            status: 400,
            body: `
              <div class="status error">Invalid callback</div>
              <h1>Google did not return a complete authorization response</h1>
            `
          })
        );
        return;
      }

      const state = verifySignedToken(stateToken, 'oauth', config.stateTtlMs);
      if (state.connectTokenHash !== config.connectTokenHash) {
        throw new Error('Connection state does not match the active connect token');
      }

      const exchange = await calendarProvider.exchangeCode({ code });
      const existingConnection = await store.getConnection(state.connectionId);
      const calendarsAfterConnect = [];
      const connection = await store.saveConnectedAccount({
        connectionId: state.connectionId,
        profile: exchange.profile,
        refreshToken: exchange.refreshToken,
        scopes: exchange.scopes,
        selectedCalendarId: existingConnection?.selectedCalendarId || null,
        selectedCalendarSummary: existingConnection?.selectedCalendarSummary || null
      });

      const connectionContext = await resolveConnectionContext(state.connectionId);
      let calendars;
      try {
        calendars = await loadWritableCalendars(connectionContext);
      } catch (error) {
        const normalized = summarizeProviderError(error);
        await store.recordError(state.connectionId, normalized);
        sendPage(
          res,
          renderPage({
            title: 'Connected With Warning',
            body: `
              <div class="status success">Connected</div>
              <h1>Google login succeeded</h1>
              <p>The account <strong>${escapeHtml(connection.googleAccountEmail || exchange.profile.email || 'unknown')}</strong> is now stored.</p>
              <p class="muted">The calendar list could not be loaded right away: ${escapeHtml(normalized.message)}.</p>
              <p class="muted">The clinic can reconnect later if calendar selection needs to be changed.</p>
            `
          })
        );
        return;
      }

      calendarsAfterConnect.push(...calendars);
      const selectedCalendar =
        calendars.find((calendar) => calendar.id === state.preferredCalendarId) ||
        calendars.find((calendar) => calendar.id === existingConnection?.selectedCalendarId) ||
        calendars.find((calendar) => calendar.primary) ||
        calendars[0] ||
        null;

      if (selectedCalendar) {
        await store.updateSelectedCalendar(state.connectionId, selectedCalendar);
      }

      if (calendarsAfterConnect.length <= 1) {
        sendPage(
          res,
          renderPage({
            title: 'Calendar Connected',
            body: `
              <div class="status success">Connected</div>
              <h1>Google Calendar is ready</h1>
              <p>The account <strong>${escapeHtml(connection.googleAccountEmail || exchange.profile.email || 'unknown')}</strong> is connected.</p>
              <p>The booking calendar is set to <strong>${escapeHtml(selectedCalendar?.summary || selectedCalendar?.id || config.defaultCalendarId)}</strong>.</p>
            `
          })
        );
        return;
      }

      const selectionToken = buildSignedToken({
        type: 'calendar-selection',
        issuedAt: Date.now(),
        connectionId: state.connectionId
      });
      const options = calendarsAfterConnect
        .map(
          (calendar) => `
            <label class="option">
              <input type="radio" name="calendarId" value="${escapeHtml(calendar.id)}" ${
                selectedCalendar && selectedCalendar.id === calendar.id ? 'checked' : ''
              }>
              <strong>${escapeHtml(calendar.summary || calendar.id)}</strong><br>
              <span class="muted"><code>${escapeHtml(calendar.id)}</code>${calendar.primary ? ' • primary' : ''}</span>
            </label>
          `
        )
        .join('');

      sendPage(
        res,
        renderPage({
          title: 'Choose Calendar',
          body: `
            <div class="status success">Google login succeeded</div>
            <h1>Choose the calendar to use for bookings</h1>
            <p>The account <strong>${escapeHtml(connection.googleAccountEmail || exchange.profile.email || 'unknown')}</strong> is now connected. Pick the writable calendar that should receive appointments.</p>
            <form method="post" action="/calendar/select">
              <input type="hidden" name="selectionToken" value="${escapeHtml(selectionToken)}">
              ${options}
              <div class="actions">
                <button type="submit">Save selected calendar</button>
              </div>
            </form>
          `
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.post('/calendar/select', async (req, res, next) => {
    try {
      const selectionToken = String(req.body.selectionToken || '').trim();
      const calendarId = String(req.body.calendarId || '').trim();
      if (!selectionToken || !calendarId) {
        sendPage(
          res,
          renderPage({
            title: 'Calendar Selection Failed',
            status: 400,
            body: `
              <div class="status error">Selection failed</div>
              <h1>Missing calendar selection</h1>
            `
          })
        );
        return;
      }
      const payload = verifySignedToken(selectionToken, 'calendar-selection', config.selectionTtlMs);
      const connectionContext = await resolveConnectionContext(payload.connectionId);
      const calendars = await loadWritableCalendars(connectionContext);
      const selectedCalendar = calendars.find((calendar) => calendar.id === calendarId);
      if (!selectedCalendar) {
        sendPage(
          res,
          renderPage({
            title: 'Calendar Selection Failed',
            status: 400,
            body: `
              <div class="status error">Selection failed</div>
              <h1>The selected calendar is no longer available</h1>
            `
          })
        );
        return;
      }
      const connection = await store.updateSelectedCalendar(payload.connectionId, selectedCalendar);
      sendPage(
        res,
        renderPage({
          title: 'Calendar Saved',
          body: `
            <div class="status success">Saved</div>
            <h1>Google Calendar connection is ready</h1>
            <p>The account <strong>${escapeHtml(connection?.googleAccountEmail || 'unknown')}</strong> will now use <strong>${escapeHtml(selectedCalendar.summary || selectedCalendar.id)}</strong> for bookings.</p>
            <p class="muted">You can close this page and let the clinic know the connection succeeded.</p>
          `
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/v1/connections/:connectionId', requireInternalApiKey, async (req, res) => {
    const connection = await store.getConnection(req.params.connectionId);
    if (!connection) {
      jsonError(res, 404, 'CALENDAR_CONNECTION_NOT_FOUND', 'Calendar connection was not found');
      return;
    }
    res.json({ connection });
  });

  app.post('/api/v1/availability', requireInternalApiKey, async (req, res) => {
    const { connectionId, calendarId, defaultCalendarId, timeMin, timeMax } = req.body || {};
    if (!validateIsoDateTime(timeMin) || !validateIsoDateTime(timeMax)) {
      jsonError(
        res,
        400,
        'VALIDATION_ERROR',
        'timeMin and timeMax must be valid ISO datetimes',
        ['timeMin and timeMax are required']
      );
      return;
    }
    try {
      const context = await resolveConnectionContext(connectionId);
      const resolvedCalendarId =
        String(calendarId || '').trim() ||
        context.connection.selectedCalendarId ||
        String(defaultCalendarId || '').trim() ||
        config.defaultCalendarId ||
        'primary';
      const busy = await calendarProvider.listBusyEvents(
        { refreshToken: context.refreshToken },
        {
          calendarId: resolvedCalendarId,
          timeMin,
          timeMax
        }
      );
      await store.markHealthy(context.connectionId);
      res.json({
        connectionId: context.connectionId,
        calendarId: resolvedCalendarId,
        busy
      });
    } catch (error) {
      const normalized = summarizeProviderError(error);
      if (connectionId) await store.recordError(connectionId, normalized);
      jsonError(res, normalized.status, normalized.code, normalized.message);
    }
  });

  app.post('/api/v1/events', requireInternalApiKey, async (req, res) => {
    const { connectionId, calendarId, defaultCalendarId, start, end, summary, description } = req.body || {};
    if (!validateIsoDateTime(start) || !validateIsoDateTime(end) || !summary) {
      jsonError(
        res,
        400,
        'VALIDATION_ERROR',
        'start, end, and summary are required',
        ['start and end must be valid ISO datetimes', 'summary is required']
      );
      return;
    }
    try {
      const context = await resolveConnectionContext(connectionId);
      const resolvedCalendarId =
        String(calendarId || '').trim() ||
        context.connection.selectedCalendarId ||
        String(defaultCalendarId || '').trim() ||
        config.defaultCalendarId ||
        'primary';
      const event = await calendarProvider.createEvent(
        { refreshToken: context.refreshToken },
        {
          calendarId: resolvedCalendarId,
          start,
          end,
          summary: String(summary),
          description: String(description || '')
        }
      );
      await store.markHealthy(context.connectionId);
      res.status(201).json({
        connectionId: context.connectionId,
        calendarId: resolvedCalendarId,
        eventId: event.eventId,
        htmlLink: event.htmlLink
      });
    } catch (error) {
      const normalized = summarizeProviderError(error);
      if (connectionId) await store.recordError(connectionId, normalized);
      jsonError(res, normalized.status, normalized.code, normalized.message);
    }
  });

  app.use((error, _req, res, _next) => {
    if (error instanceof CalendarProviderError) {
      sendPage(
        res,
        renderPage({
          title: 'Google Calendar Error',
          status: error.status || 502,
          body: `
            <div class="status error">Google Calendar error</div>
            <h1>The Google connection could not be completed</h1>
            <p class="muted">${escapeHtml(error.message)}</p>
          `
        })
      );
      return;
    }
    sendPage(
      res,
      renderPage({
        title: 'Unexpected Error',
        status: 500,
        body: `
          <div class="status error">Unexpected error</div>
          <h1>Something went wrong</h1>
          <p class="muted">${escapeHtml(error?.message || 'Unexpected error')}</p>
        `
      })
    );
  });

  return app;
}

module.exports = {
  createApp
};
