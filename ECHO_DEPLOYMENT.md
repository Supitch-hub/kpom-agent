# Deploy only the LINE Echo Bot — Windows PowerShell

Use **`wrangler.echo.jsonc`** throughout this guide. It deploys `src/echo.ts` as `art-ai-line-echo`, without any D1 binding, Gemini integration, scheduled handler or Cron trigger. The main `wrangler.jsonc` belongs to the later-phase scaffold; do not deploy it during this milestone.

The standalone echo entry point, shared HMAC verification and LINE Reply client have been locally tested. No Cloudflare account login, real deployment, LINE webhook verification or real message exchange has been performed here.

## 1. Prepare the project and authenticate

Clone `https://github.com/Supitch-hub/kpom-agent.git`, or download/extract the latest source ZIP. Open PowerShell **inside the project folder** (`kpom-agent` after cloning, or `art-ai` after extracting the ZIP). If you use the existing workspace checkout, the files are in `/workspace/kpom-agent`.

```powershell
node --version
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npx.cmd wrangler login
npx.cmd wrangler whoami
```

Use Node.js 24 LTS. Manually complete login in the browser opened by Wrangler and authorize your Cloudflare account. `whoami` must show the intended account. If multiple accounts are available, choose the intended account when Wrangler asks. If no browser opens, open the authorization URL Wrangler prints on this same Windows machine. Do not copy OAuth tokens or authorization codes into chat.

In Cloudflare dashboard, confirm your **Workers subscription is Free**. A custom domain, D1 database, Gemini key, paid plan and continuously running computer are unnecessary. Do not accept an upgrade prompt. If first-time setup asks for a `workers.dev` subdomain, choose an available subdomain; it becomes part of your public URL.

## 2. Collect LINE settings manually, then add secrets

In LINE Official Account Manager, select the correct OA and enable **Messaging API** under Settings if not enabled. Open its associated **Messaging API channel** in [LINE Developers Console](https://developers.line.biz/console/). Do not use a LINE Login channel.

Find these privately:

| Secret name | Where to obtain its value |
|---|---|
| `LINE_CHANNEL_SECRET` | Messaging API channel → Basic settings → Channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | Same channel → Messaging API → Channel access token (long-lived) → Issue, if needed |
| `LINE_ALLOWED_USER_ID` | Basic settings → Your user ID, the personal `U...` identifier for the LINE account you will use to test |

If your personal user ID is unavailable, link/sign in with the intended LINE account in LINE Developers and check the channel's Basic settings again. A channel ID, OA basic ID (`@...`), display name and group ID are not your personal user ID. Do not disable authorization or log raw events to discover it.

Run these separately. Wrangler prompts for each value; paste it **only into that prompt**, never as a command argument or into chat. Values must be stored as Cloudflare Worker secrets, not in `wrangler.echo.jsonc` or a committed file.

```powershell
npx.cmd wrangler secret put LINE_CHANNEL_SECRET --config wrangler.echo.jsonc
npx.cmd wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --config wrangler.echo.jsonc
npx.cmd wrangler secret put LINE_ALLOWED_USER_ID --config wrangler.echo.jsonc
npx.cmd wrangler secret list --config wrangler.echo.jsonc
```

The installed Wrangler may ask, “There doesn't seem to be a Worker called art-ai-line-echo. Do you want to create a new Worker with that name and add secrets to it?” Answer **yes** if this is the intended Worker/account. This creates its initial shell so secrets can be stored. The full echo code is deployed in step 3. If that Worker name already belongs to another application in your account, stop and choose a different `name` in `wrangler.echo.jsonc` before adding secrets.

`secret list` displays secret **names/types only**, not values. Confirm all three names exist. Local `.dev.vars` is not a substitute for remote secrets and is not uploaded by these deployment instructions. Do not enable verbose/debug logging or share console output containing credentials.

## 3. Deploy the echo-only Worker

```powershell
npm.cmd run deploy:echo
```

This script runs exactly:

```powershell
npx.cmd wrangler deploy --config wrangler.echo.jsonc
```

Use one of the two equivalent commands, not both. Keep `MOCK_CLIENTS` equal to `"false"` in the echo config. Do not run the generic `npm.cmd run deploy` command: it targets the other configuration. Do not run D1 creation/migration commands or configure Gemini. Secrets already stored on this Worker are retained when its code is deployed.

## 4. Get and test the public URL

Wrangler prints the actual HTTPS URL, generally:

```text
https://art-ai-line-echo.YOUR_SUBDOMAIN.workers.dev
```

Use the actual printed URL. The text above is a template, not an existing deployment. If no public URL is printed, open Cloudflare → Workers & Pages → `art-ai-line-echo` → Settings → Domains & Routes and enable/copy its `workers.dev` route. Do not configure Cloudflare Access/browser challenges on the webhook route; LINE needs direct HTTPS access.

In PowerShell, replace the template with your actual nonsecret URL:

```powershell
$echoBaseUrl = 'https://art-ai-line-echo.YOUR_SUBDOMAIN.workers.dev'
Invoke-RestMethod "$echoBaseUrl/health"
"$echoBaseUrl/webhook/line"
```

Health should show `ok=True`, `configured=True`, `mode=echo`, `mockClients=False`. This checks secret presence, not validity with LINE. Health returns 503 if any required secret is missing. No secret values are returned. The second command prints the public webhook URL to paste into LINE.

## 5. Configure and verify LINE manually

In the **same channel** in LINE Developers → Messaging API:

1. Set Webhook URL to the public URL ending in **`/webhook/line`**.
2. Click **Verify**. Expect Success. Signed empty verification events are accepted; no reply is attempted for them.
3. Enable **Use webhook**.
4. Leave **Webhook redelivery disabled** for this standalone echo milestone.
5. In OA Manager response settings, disable automatic response messages and greeting messages during testing so only the Worker replies.
6. Add the OA as a friend using its Messaging API tab QR code. Use the personal LINE account whose user ID you stored. Keep the OA on its Free plan.

Verify checks reachability and channel-secret matching. It does **not** prove the access token works; step 6 does that. A browser opening `/webhook/line` sends GET and receives 405, which is expected. Never remove signature verification to make a browser test pass.

## 6. Confirm a real echo

From your allowed personal LINE account, send the OA a fresh text message:

```text
สวัสดี ART AI
```

Expect one matching `สวัสดี ART AI` reply within a few seconds. Send `Hello ART AI` and expect the same English text back. `/task example` should also be echoed literally, with no task creation. Images and stickers are ignored in this milestone.

Close Wrangler/local development and repeat the test. The deployed Worker runs in Cloudflare; your computer does not need to remain on. Test only direct personal chat, because group/room events and other users are rejected.

If no reply arrives, open a second PowerShell in the project folder:

```powershell
npx.cmd wrangler tail --config wrangler.echo.jsonc --format pretty
```

Then send a new message. Stop tail with Ctrl+C. Logs contain only fixed error codes and request status, never application-logged message bodies, headers, user IDs or secret values. Do not paste credentials into logs or chat.

| Observation | Action |
|---|---|
| Verify/health 503 | Set the three secrets on the same account/Worker named in echo config |
| Verify 401 | Re-enter Channel secret from the same Messaging API channel; check full URL and that no proxy rewrites the body |
| 403 on a real message | Re-enter your correct personal `LINE_ALLOWED_USER_ID`; use a direct chat |
| Health OK, Verify OK, no reply | Check Use webhook, friendship, `mockClients=False`, allowed user and token; send fresh text |
| `line_http_401` or `line_http_403` | Issue/check the Messaging API access token and re-run its `secret put` command |
| `line_http_400` | Fresh message/reply token, correct channel/token; stale or already-used tokens cannot be reused |
| `line_http_429` | Respect LINE rate limits; do not retry automatically or enable paid fallback |
| `line_network_or_timeout` / `line_http_5xx` | Delivery outcome may be uncertain; wait, then send a new test message rather than replaying a reply token |
| Two replies | Disable OA auto-replies and other bot integrations; keep redelivery disabled |

**Completion:** Cloudflare deployment succeeds, health reports echo with mocks off, LINE Verify succeeds, and both Thai/English texts get matching replies from the allowed account without a local server. Until these have been observed, live deployment/integration success remains unverified.

Standalone deduplication is bounded in-memory per Worker isolate, not durable across regions/restarts. Marked redeliveries are deliberately skipped and failures are never retried or converted to Push. This can lose a reply and does not guarantee global exactly-once handling. Persistent event state belongs to a later, separately authorized phase; no database is introduced here.
