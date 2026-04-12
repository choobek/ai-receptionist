# Google Calendar Operator Guide

This guide covers the repo-backed Google Calendar connection flow for local, staging, and production.

## What changed

- `n8n` no longer needs a manually attached Google Calendar credential for the connected-account booking path.
- The new `calendar-gateway` service owns:
  - Google OAuth login
  - refresh-token storage
  - calendar selection
  - Calendar API calls for `checkAvailability` and `createEvent`

## 1. Create Google OAuth clients

Create a Google Cloud OAuth web application client for each environment you want to expose:

- local
- staging
- production

Required Google APIs:

- Google Calendar API

Recommended redirect URIs:

- local: `http://localhost:3456/calendar/oauth/callback`
- staging: `https://STAGING_HOST/calendar/oauth/callback`
- production: `https://PRODUCTION_HOST/calendar/oauth/callback`

Use separate OAuth clients for staging and production. Do not reuse the production client in staging.

## 2. Fill the environment variables

Each deployed target needs these unprefixed runtime values in its own root `.env`:

- `CALENDAR_GATEWAY_PUBLIC_BASE_URL`
- `CALENDAR_GATEWAY_INTERNAL_API_KEY`
- `CALENDAR_GATEWAY_CONNECT_TOKEN`
- `CALENDAR_GATEWAY_ENCRYPTION_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_CALENDAR_CONNECTION_ID`
- optional `GOOGLE_CALENDAR_ID` as a fallback when no selected calendar is stored yet

Example production values:

```dotenv
CALENDAR_GATEWAY_PUBLIC_BASE_URL=https://n8n.example.com
CALENDAR_GATEWAY_INTERNAL_API_KEY=replace-with-a-long-random-secret
CALENDAR_GATEWAY_CONNECT_TOKEN=replace-with-a-long-random-secret
CALENDAR_GATEWAY_ENCRYPTION_KEY=replace-with-a-long-random-secret
GOOGLE_OAUTH_CLIENT_ID=replace-with-google-client-id
GOOGLE_OAUTH_CLIENT_SECRET=replace-with-google-client-secret
GOOGLE_CALENDAR_CONNECTION_ID=clinic-default
GOOGLE_CALENDAR_ID=primary
```

For local automation, keep these optional prefixed values in the root local `.env` if you want to generate environment URLs locally:

- `STAGING_CALENDAR_GATEWAY_CONNECT_TOKEN`
- `PRODUCTION_CALENDAR_GATEWAY_CONNECT_TOKEN`

## 3. Deploy

Local:

```bash
docker-compose -f n8n/docker-compose.yml up -d
# or, if your machine uses Docker Compose v2:
docker compose --env-file .env -f n8n/docker-compose.yml up -d
```

VPS:

```bash
./scripts/deploy-vps.sh staging
./scripts/deploy-vps.sh production
```

The stack now includes:

- `n8n`
- `calendar-gateway`
- `caddy` on the full VPS compose

## 4. Generate the calendar-owner connect URL

Local runtime values:

```bash
./scripts/print-calendar-connect-url.sh clinic-default
```

Local automation env for staging or production:

```bash
./scripts/print-calendar-connect-url.sh staging clinic-default
./scripts/print-calendar-connect-url.sh production clinic-default
```

Optional explicit calendar hint:

```bash
./scripts/print-calendar-connect-url.sh production clinic-default primary
```

The generated URL format is:

```text
<public base>/calendar/connect?connectionId=<connection-id>&token=<connect-token>
```

## 5. Complete the connection flow

Send the generated URL to the calendar owner.

They should:

1. Open the link.
2. Click the Google button.
3. Sign in with the Google account that owns or manages the clinic calendar.
4. Approve calendar access.
5. Choose the writable calendar that should receive bookings.

## 6. Verify the connected account

Browser check:

- open the same `/calendar/connect` or `/calendar/status` URL
- confirm it shows:
  - connected Google account email
  - selected calendar
  - last verified time

API check from the app host or Docker network:

```bash
curl -sS "https://YOUR_HOST/calendar/status?connectionId=clinic-default&token=YOUR_CONNECT_TOKEN"
docker compose --env-file .env -f deploy/vps/docker-compose.yml exec calendar-gateway \
  wget -qO- --header="Authorization: Bearer $CALENDAR_GATEWAY_INTERNAL_API_KEY" \
  http://localhost:3000/api/v1/connections/clinic-default
```

Expected fields:

- `connection.status: "connected"`
- `connection.googleAccountEmail`
- `connection.selectedCalendarId`

## 7. Sanity-check booking through the new path

Availability:

```bash
curl -sS -X POST "https://YOUR_HOST/webhook/ai-receptionist/check-availability" \
  -H "Content-Type: application/json" \
  -H "X-AI-Receptionist-Secret: YOUR_WEBHOOK_SECRET" \
  --data '{
    "requestId": "calendar_gateway_smoke_001",
    "service": { "id": "consultation" },
    "timePreference": "first_available",
    "timezone": "Europe/Warsaw",
    "searchDays": 5
  }' | jq .
```

Create event:

- use one returned slot in `create-event`
- if live writes are risky, use staging or delete the test event immediately after verification

## 8. Troubleshooting

### `invalid_grant`

This usually means:

- the user revoked access in Google
- the refresh token is no longer valid
- the OAuth client/secret changed and the stored token no longer matches the app

Fix:

1. Generate a fresh connect URL.
2. Have the calendar owner reconnect.
3. Re-run the direct availability probe.

### Connect page opens but Google rejects the callback

Check:

- `CALENDAR_GATEWAY_PUBLIC_BASE_URL`
- the exact Google redirect URI
- that the Google OAuth client belongs to the correct environment

### The wrong calendar is being used

Fix:

1. Open the same connect/status page again.
2. Reconnect the account.
3. Choose the intended writable calendar explicitly.

### Container restarts lose the connection

Check:

- `CALENDAR_GATEWAY_DATA_VOLUME_NAME`
- the calendar-gateway volume is mounted
- `CALENDAR_GATEWAY_ENCRYPTION_KEY` did not change between restarts

If the encryption key changes, previously stored tokens cannot be decrypted. Reconnect the account with the correct key in place.
