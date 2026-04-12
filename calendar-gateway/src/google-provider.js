const { google } = require('googleapis');

class CalendarProviderError extends Error {
  constructor(message, { code = 'GOOGLE_API_ERROR', status = 502, reauthRequired = false } = {}) {
    super(message);
    this.name = 'CalendarProviderError';
    this.code = code;
    this.status = status;
    this.reauthRequired = reauthRequired;
  }
}

function normalizeGoogleError(error) {
  const status = Number(error?.response?.status) || Number(error?.code) || 502;
  const reason =
    error?.response?.data?.error?.message ||
    error?.response?.data?.error_description ||
    error?.response?.data?.error ||
    error?.message ||
    'Google Calendar request failed';
  const errorCode =
    error?.response?.data?.error?.status ||
    error?.response?.data?.error ||
    error?.code ||
    'GOOGLE_API_ERROR';
  const normalizedCode = String(errorCode).toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  const reauthRequired =
    String(error?.response?.data?.error || '').toLowerCase() === 'invalid_grant' ||
    String(error?.message || '').toLowerCase().includes('invalid_grant');
  return new CalendarProviderError(reason, {
    code: normalizedCode,
    status: Number.isFinite(status) ? status : 502,
    reauthRequired
  });
}

function sortCalendars(left, right) {
  if (left.primary && !right.primary) return -1;
  if (!left.primary && right.primary) return 1;
  return String(left.summary || left.id).localeCompare(String(right.summary || right.id), 'en');
}

function createGoogleCalendarProvider(config) {
  const ensureConfigured = () => {
    if (!config.googleClientId || !config.googleClientSecret || !config.oauthCallbackUrl) {
      throw new CalendarProviderError('Google OAuth is not configured', {
        code: 'GOOGLE_OAUTH_NOT_CONFIGURED',
        status: 503
      });
    }
  };

  const buildClient = () => {
    ensureConfigured();
    return new google.auth.OAuth2(
      config.googleClientId,
      config.googleClientSecret,
      config.oauthCallbackUrl
    );
  };

  const withAuthorizedClient = async (refreshToken, fn) => {
    ensureConfigured();
    if (!refreshToken) {
      throw new CalendarProviderError('No Google refresh token is stored for this connection', {
        code: 'MISSING_REFRESH_TOKEN',
        status: 409,
        reauthRequired: true
      });
    }
    const client = buildClient();
    client.setCredentials({ refresh_token: refreshToken });
    try {
      return await fn(client);
    } catch (error) {
      throw normalizeGoogleError(error);
    }
  };

  return {
    buildAuthUrl({ state }) {
      const client = buildClient();
      return client.generateAuthUrl({
        access_type: 'offline',
        include_granted_scopes: true,
        prompt: 'consent',
        scope: config.googleScopes,
        state
      });
    },

    async exchangeCode({ code }) {
      const client = buildClient();
      try {
        const { tokens } = await client.getToken(code);
        client.setCredentials(tokens);
        const oauth2 = google.oauth2({ version: 'v2', auth: client });
        const userInfo = await oauth2.userinfo.get();
        return {
          refreshToken: tokens.refresh_token || null,
          scopes:
            typeof tokens.scope === 'string'
              ? tokens.scope.split(/\s+/).map((item) => item.trim()).filter(Boolean)
              : config.googleScopes,
          profile: {
            googleUserId: userInfo.data.id || null,
            email: userInfo.data.email || null,
            verifiedEmail: userInfo.data.verified_email === true
          }
        };
      } catch (error) {
        throw normalizeGoogleError(error);
      }
    },

    async listCalendars({ refreshToken }) {
      return withAuthorizedClient(refreshToken, async (auth) => {
        const calendar = google.calendar({ version: 'v3', auth });
        const results = [];
        let pageToken = undefined;
        do {
          const response = await calendar.calendarList.list({
            minAccessRole: 'writer',
            showDeleted: false,
            showHidden: false,
            pageToken
          });
          const items = Array.isArray(response.data.items) ? response.data.items : [];
          for (const item of items) {
            const accessRole = item.accessRole || '';
            if (!['owner', 'writer'].includes(accessRole)) continue;
            results.push({
              id: item.id,
              summary: item.summary || item.id,
              primary: item.primary === true,
              accessRole
            });
          }
          pageToken = response.data.nextPageToken || undefined;
        } while (pageToken);
        return results.sort(sortCalendars);
      });
    },

    async listBusyEvents({ refreshToken }, { calendarId, timeMin, timeMax }) {
      return withAuthorizedClient(refreshToken, async (auth) => {
        const calendar = google.calendar({ version: 'v3', auth });
        const response = await calendar.events.list({
          calendarId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 2500
        });
        const items = Array.isArray(response.data.items) ? response.data.items : [];
        return items
          .filter((item) => item.status !== 'cancelled')
          .map((item) => ({
            id: item.id || null,
            start: item.start?.dateTime || item.start?.date || null,
            end: item.end?.dateTime || item.end?.date || null,
            summary: item.summary || null
          }))
          .filter((item) => item.start && item.end);
      });
    },

    async createEvent({ refreshToken }, { calendarId, start, end, summary, description }) {
      return withAuthorizedClient(refreshToken, async (auth) => {
        const calendar = google.calendar({ version: 'v3', auth });
        const response = await calendar.events.insert({
          calendarId,
          requestBody: {
            summary,
            description,
            start: { dateTime: start },
            end: { dateTime: end }
          }
        });
        return {
          calendarId,
          eventId: response.data.id || null,
          htmlLink: response.data.htmlLink || null
        };
      });
    }
  };
}

module.exports = {
  CalendarProviderError,
  createGoogleCalendarProvider
};
