# clausifai-agent

Slack-native operations agent for email triage, draft approvals, calendar context, and transcript summarization.

## Architecture

- Interface layer: Slack app (`@slack/bolt`)
- Orchestrator/services: TypeScript Node service
- Integrations: Gmail API, Google Calendar API, Google Drive API, Slack Web API
- Reasoning: Claude via Anthropic SDK
- Memory: Supabase (with in-memory fallback)

## Guardrail

Outbound email is only sent from the Slack `approve_draft` action path (`EmailService.approveAndSendDraft`).

## Local setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy environment file and fill secrets:
   ```bash
   cp .env.example .env
   ```
3. Start dev server:
   ```bash
   npm run dev
   ```

## Required Slack setup

- Create Slack app with bot token and signing secret.
- Enable Interactivity.
- Add slash commands:
  - `/ops-digest`
  - `/ops-next`
  - `/ops-sync-tactiq`
- Point request URL to your deployment root; Slack events and actions are handled by Bolt.

Use `docs/slack-app-manifest.yml` as a starting manifest.

## HTTP endpoints

- `GET /health` - health check
- `POST /webhooks/transcript` - transcript ingestion webhook
  - Optional header auth: `x-transcript-secret` must match `TRANSCRIPT_WEBHOOK_SECRET`
- `GET /integrations/tactiq/connect` - starts Tactiq MCP OAuth flow
- `GET /integrations/tactiq/callback` - Tactiq OAuth callback URL

## Tactiq MCP integration

This service supports pull-based transcript sync from Tactiq MCP, without requiring webhook secrets.

1. Set `APP_BASE_URL` to your public Render URL.
2. Configure optional `TACTIQ_*` env vars in `.env` (see `.env.example`).
3. Open `https://<your-service>/integrations/tactiq/connect` once to authorize.
4. Use `/ops-sync-tactiq` in Slack to import recent transcripts.

If `TACTIQ_SYNC_CRON` is set, periodic sync runs automatically.

## Cron

`EMAIL_DIGEST_CRON` controls automatic digest posting (default: weekday 8:00).

## Project layout

- `src/index.ts` - bootstrap and wiring
- `src/slack/` - Slack commands, buttons, modal handlers, blocks
- `src/services/` - orchestrator logic (email, calendar, transcripts, memory)
- `src/clients/` - API client wrappers
- `supabase/schema.sql` - baseline table schema

## Next build steps

- Replace Gmail mock read/send with full thread parsing and MIME-safe HTML replies.
- Add contact tone profile generation from sent-mail samples.
- Add robust auth/session handling for Google OAuth token refresh.
- Add unit/integration tests and deployment config (Docker + CI).
