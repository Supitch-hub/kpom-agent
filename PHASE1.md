# Phase 1 — verified LINE echo webhook

For the current live echo-only rollout without D1, use [ECHO_DEPLOYMENT.md](ECHO_DEPLOYMENT.md), `src/echo.ts` and `wrangler.echo.jsonc`. The implementation details below describe the earlier D1-backed scaffold and its local regression tests; its database setup is not required for the standalone echo deployment.

Phase 1 is local implementation only; nothing has been deployed. The TypeScript/Workers scaffold already existed from the previous implementation. This milestone adds a dedicated default echo mode and its tests, preserving later-phase source without activating it.

## Files

- `src/index.ts`: `GET /health`, `POST /webhook/line`, exact raw-body HMAC-SHA256 verification before JSON parsing, user allowlist, group/room rejection, D1 event deduplication, prompt Reply API echo. Scheduled work is disabled in echo mode.
- `src/clients.ts`: actual LINE Reply API client, 7-second timeout, one-use reply tokens, mock client for local tests; never falls back to Push for an interactive message.
- `src/types.ts`: typed Worker bindings and LINE event shape.
- `wrangler.jsonc`, `tsconfig.json`, `package.json`, `package-lock.json`, `.gitignore`, `.dev.vars.example`: Worker/toolchain and safe local configuration.
- `migrations/0001_initial.sql`: existing schema includes the event ledger used for persistent duplicate protection. No remote database is required for local tests.
- `tests/phase1.test.ts`: echo, HMAC rejection, authorization, duplicates, nontext events, API failure and scheduler isolation. Existing later-phase tests remain regression checks.
- `vitest.config.ts`: real Workers runtime and local D1 tests. Legacy agent tests explicitly use agent mode; Phase 1 tests explicitly use echo mode.

## Run locally on Windows (PowerShell)

Install Node.js 24 LTS. Open PowerShell in the project folder:

```powershell
npm.cmd ci
# Only copy if .dev.vars does not already exist; preserve existing values.
if (!(Test-Path .dev.vars)) { Copy-Item .dev.vars.example .dev.vars }
npm.cmd run db:local
npm.cmd run typecheck
npm.cmd test
npm.cmd run dev
```

Ensure `.dev.vars` contains `RESPONSE_MODE=echo`, `MOCK_CLIENTS=true`, `AI_ENABLED=false` for safe local testing. Do not print or commit real secret values. In another PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
node scripts/local-smoke.mjs
npx.cmd wrangler d1 execute art-ai --local --command "SELECT status,COUNT(*) AS n FROM processed_line_events GROUP BY status;"
```

Expect health mode `echo`, HTTP 200 for signed local events and 401 for unsigned events. The smoke script writes an event ledger row, but echo mode creates no task. Old local tasks may remain from earlier testing. The automated echo tests inspect captured replies and assert that no agent data is written. Local mocks do not contact LINE.

## Configuration and your action

No action or credentials are needed to run the mocked automated tests. For later live integration you will need a LINE Messaging API channel, its channel secret, long-lived channel access token and your personal allowed LINE user ID. Keep those secure; never paste secrets into chat. Runtime variable names are `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_ALLOWED_USER_ID`. Real LINE calls require `MOCK_CLIENTS=false`.

Before future deployment you will also need Cloudflare authentication, a remote D1 database ID, remote migrations and Cloudflare secret configuration. The existing README contains those commands and the manual OA checklist for later use. **Do not run deployment commands during Phase 1.** LINE cannot reach a localhost development server; live OA validation remains pending until an explicitly authorized HTTPS deployment.

## Behavior and limitations

- Echo is the original text, capped at 4,900 characters for LINE's text-message limit. Thai/English and whitespace are preserved. Nontext events are acknowledged without a reply.
- Missing/invalid signatures return 401; unauthorized user/group/room events return 403; malformed signed bodies return 400. Empty LINE verification events return 200.
- Echo mode is fail-closed: only explicit `RESPONSE_MODE=agent` activates later-phase behavior. It makes no Gemini calls and schedules no pushes.
- D1 claims an event before replying. Duplicate events do not reuse the reply token. A network failure is recorded as uncertain without automatic retry or Push fallback; this avoids duplicates but can lose a reply. Exactly-once external delivery cannot be guaranteed.
- Old events (>50 seconds), excessive bodies (>64 KiB), and oversized batches (>5 events) are not processed. Errors/credentials are never echoed.
- Phase 1 completion does not establish working remote credentials or production deployment.

## Next phase

Review task/note tools and migrations, expand their acceptance tests as needed, then explicitly activate agent mode for Phase 2. Add and validate Gemini only after checking current model/free-tier eligibility. Reminders and daily briefing follow in later phases.
