const path = require('node:path');
const express = require('express');
const { signPayload, verifySignedPayload, sha256Hex } = require('./crypto');
const { CalendarProviderError } = require('./google-provider');

const publicProductName = 'AI Receptionist';

const googleCalendarAuthSteps = [
  {
    title: 'Kliknij „Zaawansowane”',
    description: 'Jeśli Google pokaże ostrzeżenie o niezweryfikowanej aplikacji, rozwiń szczegóły.',
    imagePath: '/calendar/assets/google-calendar-auth/1-ta-aplikacja.webp',
    alt: 'Ekran Google z ostrzeżeniem o niezweryfikowanej aplikacji i linkiem Zaawansowane.'
  },
  {
    title: 'Kliknij „Otwórz: ovh.net”',
    description: 'Po rozwinięciu szczegółów wybierz link na dole ekranu, aby kontynuować.',
    imagePath: '/calendar/assets/google-calendar-auth/2-zatwierdz.webp',
    alt: 'Rozwinięty ekran ostrzeżenia Google z linkiem Otwórz: ovh.net.'
  },
  {
    title: 'Potwierdź konto Google',
    description: 'Na ekranie logowania kliknij „Dalej” przy właściwym koncie Google.',
    imagePath: '/calendar/assets/google-calendar-auth/3-login.webp',
    alt: 'Ekran logowania przez Google z przyciskiem Dalej.'
  },
  {
    title: 'Zatwierdź dostęp',
    description: 'Na ekranie dostępu kliknij „Dalej”, żeby pozwolić na połączenie kalendarza.',
    imagePath: '/calendar/assets/google-calendar-auth/4-google-dostep.webp',
    alt: 'Ekran zgody Google z informacją o dostępie do konta i przyciskiem Dalej.'
  },
  {
    title: 'Wybierz kalendarz rezerwacji',
    description: 'Po powrocie na stronę wybierz właściwy kalendarz i kliknij „Zapisz wybrany kalendarz”.',
    imagePath: '/calendar/assets/google-calendar-auth/5-wybierz-kalendarz.webp',
    alt: 'Ekran wyboru kalendarza do rezerwacji z przyciskiem Zapisz wybrany kalendarz.'
  }
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateTime(value) {
  if (!value) return 'nigdy';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function renderGoogleCalendarAuthGuide() {
  const steps = googleCalendarAuthSteps
    .map((step, index) => `
      <details class="guide-step"${index === 0 ? ' open' : ''}>
        <summary>
          <span class="step-number">${index + 1}</span>
          <span>${escapeHtml(step.title)}</span>
        </summary>
        <p class="muted">${escapeHtml(step.description)}</p>
        <a class="screenshot-link" href="${escapeHtml(step.imagePath)}" target="_blank" rel="noreferrer">
          <img src="${escapeHtml(step.imagePath)}" alt="${escapeHtml(step.alt)}" loading="lazy">
        </a>
      </details>
    `)
    .join('');

  return `
    <section class="guide" aria-labelledby="google-auth-guide-title">
      <h2 id="google-auth-guide-title">Instrukcja autoryzacji</h2>
      <p class="muted">Jeśli Google pokaże dodatkowe ekrany, przejdź przez nie według poniższych kroków. Kliknij krok, żeby rozwinąć zrzut ekranu.</p>
      ${steps}
    </section>
  `;
}

function renderPage({ title, body, status = 200 }) {
  return {
    status,
    html: `<!doctype html>
<html lang="pl">
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
      .guide {
        margin-top: 28px;
      }
      .guide-step {
        margin-top: 10px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255,255,255,0.72);
        overflow: hidden;
      }
      .guide-step summary {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px;
        font-weight: 700;
        cursor: pointer;
      }
      .guide-step summary::-webkit-details-marker {
        display: none;
      }
      .step-number {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
        border-radius: 999px;
        background: rgba(15,118,110,0.12);
        color: var(--accent);
      }
      .guide-step p {
        margin: 0;
        padding: 0 14px 14px;
      }
      .screenshot-link {
        display: block;
        padding: 0 14px 14px;
      }
      .screenshot-link img {
        display: block;
        width: 100%;
        max-height: 72vh;
        object-fit: contain;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fff;
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
  app.use(
    '/calendar/assets',
    express.static(path.join(__dirname, 'assets'), {
      immutable: true,
      maxAge: '30d'
    })
  );

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
        title: 'Połączenie kalendarza niedostępne',
        status: 503,
        body: `
          <div class="status error">Wymagana konfiguracja</div>
          <h1>Połączenie z kalendarzem nie jest jeszcze skonfigurowane</h1>
          <p class="muted">Najpierw trzeba dokończyć konfigurację Google OAuth dla tego środowiska.</p>
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
        title: 'Połączenie kalendarza',
        body: `
          <div class="status">Połączenie kalendarza</div>
          <h1>Użyj pełnego linku autoryzacyjnego</h1>
          <p class="muted">Ta strona działa po otwarciu pełnego linku do połączenia Kalendarza Google.</p>
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
          title: 'Brak dostępu',
          status: 403,
          body: `
            <div class="status error">Brak dostępu</div>
            <h1>Ten link autoryzacyjny jest nieprawidłowy</h1>
            <p class="muted">Poproś o nowy link do połączenia Kalendarza Google.</p>
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
      ? '<div class="status success">Połączono</div>'
      : connection?.status === 'reauthorization_required'
        ? '<div class="status error">Wymagane ponowne połączenie</div>'
        : '<div class="status">Nie połączono</div>';

    const connectionDetails = connection
      ? `
        <div class="panel">
          <p><strong>Identyfikator połączenia:</strong> <code>${escapeHtml(connection.connectionId)}</code></p>
          <p><strong>Konto Google:</strong> ${escapeHtml(connection.googleAccountEmail || 'jeszcze nie połączono')}</p>
          <p><strong>Wybrany kalendarz:</strong> ${escapeHtml(connection.selectedCalendarSummary || connection.selectedCalendarId || 'jeszcze nie wybrano')}</p>
          <p><strong>Ostatnio sprawdzono:</strong> ${escapeHtml(formatDateTime(connection.lastVerifiedAt))}</p>
          ${
            connection.lastError
              ? `<p><strong>Ostatni błąd:</strong> ${escapeHtml(connection.lastError.message)}</p>`
              : ''
          }
        </div>
      `
      : '';

    sendPage(
      res,
      renderPage({
        title: 'Połącz Kalendarz Google',
        body: `
          ${statusPill}
          <h1>Połącz Kalendarz Google</h1>
          <p>${escapeHtml(publicProductName)} używa tej bezpiecznej strony, aby połączyć kalendarz wykorzystywany do umawiania wizyt.</p>
          <p class="muted">Google poprosi o zalogowanie i zatwierdzenie dostępu do kalendarza. Po autoryzacji będzie można wybrać kalendarz, do którego mają trafiać rezerwacje.</p>
          ${connectionDetails}
          <div class="actions">
            <a class="button" href="${escapeHtml(startUrl.toString())}">${connection?.status === 'connected' ? 'Połącz ponownie z Google' : 'Kontynuuj z Google'}</a>
          </div>
          ${renderGoogleCalendarAuthGuide()}
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
            title: 'Brak dostępu',
            status: 403,
            body: `
              <div class="status error">Brak dostępu</div>
              <h1>Ten link autoryzacyjny jest nieprawidłowy</h1>
              <p class="muted">Poproś o nowy link autoryzacyjny.</p>
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
            title: 'Połączenie przerwane',
            status: 400,
            body: `
              <div class="status error">Logowanie przez Google nie zostało ukończone</div>
              <h1>Połączenie z kalendarzem nie zostało zakończone</h1>
              <p class="muted">Google zwrócił: <code>${escapeHtml(req.query.error)}</code>.</p>
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
            title: 'Nieprawidłowa odpowiedź',
            status: 400,
            body: `
              <div class="status error">Nieprawidłowa odpowiedź</div>
              <h1>Google nie zwrócił pełnej odpowiedzi autoryzacyjnej</h1>
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
            title: 'Połączono z ostrzeżeniem',
            body: `
              <div class="status success">Połączono</div>
              <h1>Logowanie przez Google zakończone</h1>
              <p>Konto <strong>${escapeHtml(connection.googleAccountEmail || exchange.profile.email || 'nieznane')}</strong> zostało zapisane.</p>
              <p class="muted">Nie udało się od razu pobrać listy kalendarzy: ${escapeHtml(normalized.message)}.</p>
              <p class="muted">Możesz połączyć konto ponownie później, jeśli trzeba będzie zmienić wybrany kalendarz.</p>
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
            title: 'Kalendarz połączony',
            body: `
              <div class="status success">Połączono</div>
              <h1>Kalendarz Google jest gotowy</h1>
              <p>Konto <strong>${escapeHtml(connection.googleAccountEmail || exchange.profile.email || 'nieznane')}</strong> jest połączone.</p>
              <p>Kalendarz rezerwacji ustawiono na <strong>${escapeHtml(selectedCalendar?.summary || selectedCalendar?.id || config.defaultCalendarId)}</strong>.</p>
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
              <span class="muted"><code>${escapeHtml(calendar.id)}</code>${calendar.primary ? ' • główny' : ''}</span>
            </label>
          `
        )
        .join('');

      sendPage(
        res,
        renderPage({
          title: 'Wybierz kalendarz',
          body: `
            <div class="status success">Logowanie przez Google zakończone</div>
            <h1>Wybierz kalendarz do rezerwacji</h1>
            <p>Konto <strong>${escapeHtml(connection.googleAccountEmail || exchange.profile.email || 'nieznane')}</strong> jest połączone. Wybierz kalendarz, do którego mają trafiać wizyty.</p>
            <form method="post" action="/calendar/select">
              <input type="hidden" name="selectionToken" value="${escapeHtml(selectionToken)}">
              ${options}
              <div class="actions">
                <button type="submit">Zapisz wybrany kalendarz</button>
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
            title: 'Nie udało się wybrać kalendarza',
            status: 400,
            body: `
              <div class="status error">Nie udało się zapisać wyboru</div>
              <h1>Nie wybrano kalendarza</h1>
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
            title: 'Nie udało się wybrać kalendarza',
            status: 400,
            body: `
              <div class="status error">Nie udało się zapisać wyboru</div>
              <h1>Wybrany kalendarz nie jest już dostępny</h1>
            `
          })
        );
        return;
      }
      const connection = await store.updateSelectedCalendar(payload.connectionId, selectedCalendar);
      sendPage(
        res,
        renderPage({
          title: 'Kalendarz zapisany',
          body: `
            <div class="status success">Zapisano</div>
            <h1>Połączenie z Kalendarzem Google jest gotowe</h1>
            <p>Konto <strong>${escapeHtml(connection?.googleAccountEmail || 'nieznane')}</strong> będzie używać kalendarza <strong>${escapeHtml(selectedCalendar.summary || selectedCalendar.id)}</strong> do rezerwacji.</p>
            <p class="muted">Możesz zamknąć tę stronę.</p>
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
          title: 'Błąd Kalendarza Google',
          status: error.status || 502,
          body: `
            <div class="status error">Błąd Kalendarza Google</div>
            <h1>Nie udało się zakończyć połączenia z Google</h1>
            <p class="muted">${escapeHtml(error.message)}</p>
          `
        })
      );
      return;
    }
    sendPage(
      res,
      renderPage({
        title: 'Nieoczekiwany błąd',
        status: 500,
        body: `
          <div class="status error">Nieoczekiwany błąd</div>
          <h1>Coś poszło nie tak</h1>
          <p class="muted">${escapeHtml(error?.message || 'Nieoczekiwany błąd')}</p>
        `
      })
    );
  });

  return app;
}

module.exports = {
  createApp
};
