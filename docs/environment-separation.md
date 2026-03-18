# Staging And Production

This repo now separates shared application logic from environment bindings:

- Shared Vapi assistant behavior lives in [`../configs/vapi/assistant.v1.json`](../configs/vapi/assistant.v1.json).
- Environment-specific Vapi resource IDs live in [`../configs/vapi/environments/staging.json`](../configs/vapi/environments/staging.json) and [`../configs/vapi/environments/production.json`](../configs/vapi/environments/production.json).
- Local automation reads one root [`.env.example`](../.env.example) template with `STAGING_*` and `PRODUCTION_*` values.
- Each deployed n8n target still keeps its own unprefixed root `.env` on that host.

## Commands

Deploy code only:

```bash
./scripts/deploy-vps.sh staging
./scripts/deploy-vps.sh production
```

Sync workflows plus Vapi for a target:

```bash
./scripts/sync-environment.sh staging
./scripts/sync-environment.sh production
```

Sync only Vapi for a target:

```bash
./scripts/sync-vapi-environment.sh staging
./scripts/sync-vapi-environment.sh production
```

Promote an approved release that is already checked out locally:

```bash
git checkout <approved-commit-or-tag>
./scripts/promote-to-production.sh HEAD
```

## Promotion Model

1. Commit the change.
2. Deploy and sync `staging`.
3. Validate behavior against staging Vapi and staging n8n.
4. Check out the approved ref locally.
5. Run [`../scripts/promote-to-production.sh`](../scripts/promote-to-production.sh) for that exact ref.

The promotion script deploys the exact git ref to the production VPS and then syncs the production n8n workflows and production Vapi assistant/tool bindings from the same checked-out repo state.

## Manual Setup Still Required

1. Fill root `.env` with `STAGING_*` and `PRODUCTION_*` SSH targets plus `*_N8N_PUBLIC_BASE_URL`. Use `*_AI_RECEPTIONIST_WEBHOOK_SECRET` when the corresponding public n8n webhooks require a secret.
2. Create a separate staging Vapi assistant and five separate staging Vapi tool resources. Put their IDs into [`../configs/vapi/environments/staging.json`](../configs/vapi/environments/staging.json).
3. Keep the existing production Vapi assistant IDs in [`../configs/vapi/environments/production.json`](../configs/vapi/environments/production.json). Do not point staging at those production tool IDs.
4. Stand up a separate staging n8n deployment with its own root `.env`, encryption key, webhook secret, data volume, credentials, and preferably a separate Google Calendar ID.
5. After the first workflow import into each n8n environment, reattach that environment's credentials before publishing the imported workflows.

## Production Phone Number

The production phone number must stay bound to the production assistant only.

- Do not attach the live number to the staging assistant.
- Do not reuse the production assistant as the staging test assistant.
- If you ever replace the production assistant resource itself, rebind the production number only after the new production assistant has been verified.

## Isolation Notes

For the cleanest separation, staging and production should use:

- different public base URLs
- different n8n root `.env` files on the target hosts
- different webhook secrets
- different n8n data volumes
- different Google credentials and preferably different calendar IDs

The compose files now allow different container names, volume names, and Caddy ports if both environments must coexist on the same machine, but separate hosts or clearly separated app directories are still the safer default.
