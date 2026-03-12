# VPS Deployment

This guide deploys n8n on a VPS with:

- Docker Compose
- Caddy as the public HTTPS reverse proxy
- stable webhook URLs for Vapi

It is intended for a server such as your OVH VPS.

## Recommended hostname

Set one public hostname for n8n:

- preferred: a subdomain you control, for example `n8n.example.com`
- acceptable to test first: the OVH hostname, for example `vps-2c8bbf65.vps.ovh.net`

The hostname must resolve to the VPS public IP and ports `80` and `443` must be reachable from the internet so Caddy can obtain a TLS certificate.

If certificate issuance fails on the OVH-provided hostname, switch to a domain you control.

## Files used

- [`deploy/vps/docker-compose.yml`](../deploy/vps/docker-compose.yml)
- [`deploy/vps/Caddyfile`](../deploy/vps/Caddyfile)
- [`deploy/vps/.env.example`](../deploy/vps/.env.example)

## 1. Prepare the VPS

Example for Ubuntu or Debian:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git ufw
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker
```

Then reconnect your shell so the `docker` group is applied.

If `docker compose` is still unavailable after installation, install the Docker Compose plugin or use `docker-compose` for the same commands in this guide.

Open only the required ports:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 2. Copy the project to the VPS

```bash
git clone YOUR_REPO_URL ai-receptionist
cd ai-receptionist
```

If the repo is already on the server, just `git pull`.

## 3. Create the production env file

```bash
cp deploy/vps/.env.example deploy/vps/.env
```

Edit [`deploy/vps/.env`](../deploy/vps/.env) and set at minimum:

- `N8N_DOMAIN`
- `LETSENCRYPT_EMAIL`
- `N8N_ENCRYPTION_KEY`
- `N8N_BASIC_AUTH_PASSWORD`
- `GOOGLE_CALENDAR_ID` if not `primary`

Generate strong secrets like this:

```bash
openssl rand -hex 32
```

Required production values:

```dotenv
N8N_DOMAIN=n8n.example.com
LETSENCRYPT_EMAIL=ops@example.com
N8N_ENCRYPTION_KEY=replace-with-openssl-output
N8N_BASIC_AUTH_PASSWORD=replace-with-a-strong-password
N8N_SECURE_COOKIE=true
N8N_PROXY_HOPS=1
```

For your current OVH hostname, the first pass would be:

```dotenv
N8N_DOMAIN=vps-2c8bbf65.vps.ovh.net
```

## 4. Start the stack

```bash
cd deploy/vps
docker compose up -d
docker compose logs -f caddy
```

When Caddy has issued the certificate, open:

- `https://YOUR_HOSTNAME`

You should see the n8n login or owner setup flow.

## 5. Finish n8n setup

After first login:

1. Create the n8n owner account.
2. Import the workflows from [`n8n/workflows/`](../n8n/workflows).
3. Create Google Calendar credentials inside n8n.
4. Attach those credentials to the Google Calendar nodes.

## 6. Point Vapi to the VPS URLs

Use the stable HTTPS base:

- `https://YOUR_HOSTNAME/webhook/ai-receptionist/check-availability`
- `https://YOUR_HOSTNAME/webhook/ai-receptionist/create-event`
- `https://YOUR_HOSTNAME/webhook/ai-receptionist/vapi-call-ended`

Update:

- Vapi custom tool `checkAvailability`
- Vapi custom tool `createEvent`
- any Vapi webhook target for `call.ended`

## 7. Verify from the server

Quick checks:

```bash
curl -I https://YOUR_HOSTNAME
curl -sS -X POST https://YOUR_HOSTNAME/webhook/ai-receptionist/check-availability \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "vps_smoke_test_001",
    "service": {
      "id": "consultation",
      "name": "Konsultacja",
      "durationMinutes": 30
    },
    "requestedDate": "2026-03-16",
    "timePreference": "morning",
    "timezone": "Europe/Warsaw",
    "limit": 3,
    "patient": {
      "isExistingPatient": false
    }
  }'
```

Expected:

- HTTPS responds successfully
- the availability webhook returns JSON, not HTML

## Operations

Restart after changes:

```bash
cd deploy/vps
docker compose up -d
```

Inspect logs:

```bash
cd deploy/vps
docker compose logs -f n8n
docker compose logs -f caddy
```

Update the app:

```bash
cd ~/ai-receptionist
git pull
cd deploy/vps
docker compose up -d
```
