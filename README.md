# Heptapod Sentinel

Heptapod Sentinel is a ready-made watchdog for one [Heptapod](https://heptapod.watch) instance. Heptapod cannot tell you when Heptapod itself is down; a watchdog outside your server can. The [watchdog page](https://heptapod.watch/docs/running-it/watchdog/) describes the signals and the other options.

It runs on Cloudflare Workers Free with one SQLite-backed Durable Object and one cron trigger. Heptapod needs no code changes; you only set its `INSTANCE_HEARTBEAT_URL`.

This is a reference implementation, maintained on a best-effort basis. It is licensed under the MIT license.

It watches three signals: the scheduler heartbeat, the check age it carries, and the `/up` health URL.

- The scheduler calls `GET /ping/<token>` every minute. Heptapod Sentinel alerts after five minutes without a ping and sends one recovery alert on the next ping. POST also works.
- A scheduler ping can include `?check_age_seconds=123`. Two consecutive reports above 900 seconds mark the independent `checks` signal DOWN with reason `checks not running`. A value at or below 900, or the literal `null` (no completion expected), recovers it. The application's scheduler supplies this parameter; no heartbeat URL configuration change is needed.
- Missing parameters preserve legacy heartbeat behavior. They reset a first stale-check candidate but do not clear an established checks outage. Invalid values (including repeated parameters) still record liveness, return 422, and count toward a two-ping checks outage with reason `invalid check age report`. The application logs rejected HTTP status without the secret URL.
- A cron checks the instance's `/up` endpoint every five minutes. Two consecutive non-2xx responses, network errors or ten-second timeouts trigger DOWN. One success recovers. Redirects count as failures.
- Heartbeat and reachability are independent. Each sends one alert per transition, not repeated reminders. Messages are short, plain English and include the instance URL and outage start time.

## Five-minute setup

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/heptapodwatch/sentinel)

The button requires a public repository and a Cloudflare account. Its secret prompts cover only the webhook path (`PING_TOKEN` and `WEBHOOK_URL`); Brevo, ntfy and Cloudflare email users must use the CLI setup below. The button flow is unverified without a live account. If it deploys before the required secrets exist, startup validation fails; it does not start an unconfigured watchdog. Use the CLI path to upload code and secrets together if the button cannot supply them before deployment.

> WARNING: Anonymous https://ntfy.sh publishing does not work from Workers. Cloudflare's shared egress IPs hit ntfy's daily quota (HTTP 429, code 42908). If you choose ntfy, supply an ntfy account access token as `NTFY_TOKEN` or use a self-hosted ntfy server. Startup rejects https://ntfy.sh without a token.

1. Generate a token with `openssl rand -hex 32`. Keep it private.
2. Click the button. Set `INSTANCE_URL` to your Heptapod HTTPS origin, for example `https://heptapod.example.com`. Enter `PING_TOKEN` and `WEBHOOK_URL` as secrets when prompted. Do not leave example values in place. The `.dev.vars.example` file defines only these two button prompts. Use the CLI path for other notifiers.
3. Use the resulting `https://<worker>.<account-subdomain>.workers.dev` URL. In Heptapod's environment, set:
   ```dotenv
   INSTANCE_HEARTBEAT_URL=https://<worker>.<account-subdomain>.workers.dev/ping/<token>
   ```
   Apply that environment change using your instance's usual deployment/configuration process. Heptapod's `instance:heartbeat` scheduler sends a GET every minute.
4. Open `https://<worker>.<account-subdomain>.workers.dev/status/<token>`. Check that `lastPingAt` advances and `heartbeat.state` is `UP`. The heartbeat alarm is armed by the first ping, not by deployment. Until that ping, heartbeat state is `UNKNOWN` and no missing-heartbeat alert is sent.
5. Verify notifications using a controlled outage. Pause the scheduler longer than `GRACE_SECONDS`, then resume it. Expect a heartbeat DOWN followed by UP. For reachability, make `/up` fail for two checks, then restore it.

CLI setup (Node.js 24):

```sh
git clone https://github.com/heptapodwatch/sentinel.git
cd sentinel
npm ci
# Edit INSTANCE_URL and timing vars in wrangler.jsonc.
# Copy the example, then fill in real secrets locally. Never commit this file.
cp .dev.vars.example .env.production
# Deploy code and initial secrets together so startup validation can pass.
npx wrangler deploy --secrets-file .env.production
```

For a later single-secret change, use interactive input, not secret values in command arguments:

```sh
npx wrangler secret put PING_TOKEN
# Or change one existing webhook secret:
npx wrangler secret put WEBHOOK_URL
```

`wrangler secret put` creates and immediately deploys a version. For any change touching more than one notifier secret, put the complete new notifier configuration in an ignored `.env.production` or JSON file and update it together:

```sh
npx wrangler secret bulk .env.production
# Or upload code and secrets together:
npx wrangler deploy --secrets-file .env.production
```

Do not add or remove multi-secret notifier settings one at a time: startup validation rejects incomplete intermediate configurations, even when another notifier is configured. JSON bulk files can set obsolete keys to `null` to delete them in the same update; dotenv bulk files cannot delete keys. Changing the token requires updating Heptapod's `INSTANCE_HEARTBEAT_URL`. Secrets omitted from bulk or `--secrets-file` updates are preserved; remove obsolete secrets without creating a partial notifier configuration. Dashboard variables can be overwritten by Wrangler, so keep non-secret settings in `wrangler.jsonc`.

## Notifiers

Configure one or more. Every configured notifier is attempted. Missing all notifiers, incomplete notifier settings, invalid tokens, URLs or timings cause a clear error at Worker startup, before serving traffic. This is also checked for every request and cron event, because bindings can change on a live Worker.

- Webhook: secret `WEBHOOK_URL`. Heptapod Sentinel sends POST JSON with `check` (`heartbeat`, `up` or `checks`), an optional checks `reason`, `state` (`DOWN` or `UP`), `since` and `at` (Unix milliseconds), `instanceUrl` and `message`. The receiving service must accept this generic shape; Slack/Discord-specific webhook formats are not implemented. Treat authenticated webhook URLs as secrets.
- ntfy: WARNING: anonymous https://ntfy.sh does not work from Workers: shared Cloudflare egress IPs exhaust its daily quota (HTTP 429, code 42908). Set secret `NTFY_URL` to the full topic URL, such as `https://ntfy.sh/<private-topic>`, and supply an ntfy account access token as `NTFY_TOKEN`. Alternatively, use a self-hosted ntfy server; a token is optional there. `NTFY_TOKEN` supplies Bearer authentication. Heptapod Sentinel posts the plain message. Use a private authenticated topic if instance availability is sensitive. Provider limits and privacy policies still apply.
- Brevo: secrets `BREVO_API_KEY`, `BREVO_FROM`, `BREVO_TO`. Use a transactional API key, a sender verified in Brevo and one plain recipient address. Heptapod Sentinel calls `https://api.brevo.com/v3/smtp/email`. Brevo quotas are separate from Cloudflare's free tier.
- Cloudflare email: add `"send_email": [{ "name": "EMAIL" }]` to `wrangler.jsonc`, then run `npm run types`. Set secrets `CF_EMAIL_FROM` and `CF_EMAIL_TO`. Set up Email Routing on the sender's domain and verify the destination address in your Cloudflare account. Use a sender address on that routing domain. The binding without a destination restriction sends only to verified destinations. These sends are free on all plans, including an account with only Email Routing configured; sending to arbitrary recipients requires Workers Paid and is outside this setup. Heptapod Sentinel uses the current structured `send()` API with a plain-text message, without a MIME dependency. You can restrict sender/destination addresses in the binding, but those addresses then appear in your configuration file. See https://developers.cloudflare.com/email-service/configuration/send-bindings/, https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ and https://developers.cloudflare.com/email-service/platform/limits/#verified-destination-addresses.

HTTP notifiers require HTTPS. HTTP loopback URLs are allowed only to test with a local listener; they cannot deliver from a deployed Worker. HTTP calls time out after `NOTIFIER_TIMEOUT_SECONDS` (default 10, maximum 10). Email binding calls use the platform's timeout; they have no application-level cancellation API. HTTP redirects are not followed, so credentials cannot be forwarded to a different host.

Every transition is persisted with a pending alert and an alarm before delivery. Failed channels retry after 1, 2, 5 and 10 minutes, then every 30 minutes until delivered. Delays run from the start of each attempt; there is no immediate retry. Successful channels are not re-sent for that transition. Failure logs contain only channel, check, state, attempt, category and HTTP status when available, never provider bodies or raw error messages. Provider failures leave a visible pending obligation rather than failing a ping/cron; storage and configuration errors still propagate. `/status/<token>` lists undelivered alerts and returns `ok: false` while any remain. Delivery is at least once: a crash after provider acceptance but before its durable acknowledgement, or an ambiguous provider outcome, can duplicate a message.

There is at most one pending alert per check. A newer transition replaces the older one. If a channel missed DOWN, recovery sends one combined “was down from X to Y; now UP” message instead of separate DOWN and UP messages. Channels that received DOWN get the ordinary UP message. If another DOWN replaces an undelivered recovery, the message includes the current outage and warns that earlier outages since the earliest unreported start were not reported. Each channel retains only that one timestamp, not an outage history; it does not imply that separate outages were continuous. A completion for a superseded alert cannot clear its replacement.

Pending alerts target the currently configured channels at each attempt. Added channels receive the pending alert, including any unreported-outage wording. Removed channels are dropped with a secret-free channel/check log; they do not keep status stuck. Changing a destination within the same channel uses the current configuration for failed deliveries. A delivered flag identifies the channel, not a destination, so changing an already successful channel's destination does not resend that pending transition. Heartbeat expiry and notification retries share the alarm; the earliest deadline wins, and fresh pings cannot postpone a retry.

## State and security

`GET /status/<token>` returns current state and delivery health (`ok` describes notification delivery, not check availability):

```json
{
  "ok": true,
  "instanceUrl": "https://heptapod.example.com",
  "undelivered": [],
  "lastPingAt": 1791715681890,
  "heartbeat": { "state": "UP", "since": 1791715681890 },
  "up": { "state": "UNKNOWN" },
  "lastAlertAt": { "heartbeat": null, "up": null }
}
```

An undelivered entry contains `check`, `state`, `since`, `at`, `attempts`, `nextAttemptAt` and `failingNotifiers` (for example `["ntfy"]`). Timestamps are Unix milliseconds. `attempts` is the highest attempt count among failing channels; `nextAttemptAt` is their earliest due time. Status lists only currently configured channels and does not write the active object's storage. `instanceUrl` identifies the watched instance.

`checks` appears once a check age is reported; it has `UNKNOWN`, `UP`, `SUSPECT` or `DOWN` state and a `reason` while suspect/down. Its debounce and pending notifications survive object restarts. A checks outage does not change `heartbeat` or `/up` state.

`up.state` can be `UNKNOWN`, `UP`, `SUSPECT` (one failure) or `DOWN`. Healthy reachability observations and unchanged DOWN observations do not write check state. The first failure's timestamp and state are persisted, so the threshold survives object restarts. `lastAlertAt` records the latest transition queued for each check, not proof of delivery. A recovery message's `since` is the outage start; an UP state's `since` is the recovery time.

The token accepts 32–256 URL-safe characters. Generate at least 32 random bytes, rather than choosing a password. Both supplied and expected tokens are SHA-256 hashed to fixed-size buffers, then compared with the Workers runtime's `crypto.subtle.timingSafeEqual`. Unauthorized and unknown paths return 404. Unsupported methods on authenticated routes return 405. Status and ping JSON are not cached.

Tokens in paths can leak through browser history, reverse-proxy logs or tracing. Do not share these URLs. The default configuration enables console error logs but disables invocation logs and traces because those retain request URLs. Do not enable URL logging without redaction. No token, provider key, notifier address or response body is stored in Durable Object storage. Storage holds current check state and up to three pending alerts with transition IDs, timestamps, per-channel delivered flags, attempt counts, due times and earliest unreported outage starts; there is no history. One Worker watches one instance using the fixed object name `instance`. Changing `INSTANCE_URL` changes the `/up` probe target and alert text while keeping check state, pending deliveries and alarms. The first deployment of this stable-identity version starts one fresh state; it does not migrate state from URL-named objects. Those superseded objects delete their storage and alarm on their next invocation or alarm, log `sentinel_object_retired`, and send no notifications. A superseded object with neither an alarm nor callers stays dormant and never sends. The fresh object's heartbeat alarm is armed by its first ping.

## Free-tier budget

For one instance, a healthy day has 1,440 pings and 288 cron checks:

- Worker invocations: at most 1,728/day excluding status requests, or 1.728% of the 100,000/day HTTP-request allowance when conservatively counting cron invocations too.
- Durable Object requests: 1,728/day, or 1.728% of 100,000/day. An expired alarm adds a request; replacing an alarm on a ping does not invoke it.
- SQLite rows written: 1,440 state puts + 1,440 `setAlarm` calls = 2,880/day, or 2.88% of 100,000/day. The first `/up` observation adds one write. Outage transitions and first-failure/reset states add occasional writes. The SQLite-backed KV API stores the state in one hidden-table row; each alarm update counts as another row write.
- Rows read: conservatively 6,336 state/pending lookups/day before cache effects (four per ping including its response, two per cron), or 0.12672% of 5,000,000/day. Status requests add two lookups, not writes. Missing pending records and cache hits can reduce billed reads.
- Stored data: one small state record, one bounded pending record (at most three alerts × four channels), an alarm and SQLite metadata. An empty SQLite database starts around 12 KB. Even allowing 1 MB for overhead is 0.02% of the 5 GB allowance; storage does not grow with uptime or retry count.
- Duration: at an illustrative 50 ms per object request, 1,728 × 0.05 s × 0.128 GB = 11.06 GB-s/day, versus 13,000 GB-s/day. Even one object active for the entire day is 86,400 × 0.128 = 11,059.2 GB-s/day. Network calls count toward active duration; idle, hibernation-eligible time does not.
- One cron trigger, below the free account's five-trigger limit. CPU limit is 10 ms per Worker invocation; waiting for network I/O is not CPU time. Each invocation attempts at most four channels per check: up to twelve notification calls in an alarm handling all three checks, or one probe plus four notifications in a cron, below the free 50-subrequest limit. Each channel is attempted once per batch, not retried in a CPU loop.
- A continuously failing alert reaches 30-minute backoff after the 1/2/5/10-minute ramp: at most 48 retry batches/day per check in steady state. Three independent pending checks add at most 144 alarm invocations/day (fewer when due together), 576 notifier calls/day with all four channels failing, and fewer than 1,500 extra row writes/day in steady state. Transitions and successful acknowledgements add occasional writes. Pending attempt counts and next wakeups are committed before I/O, and each successful channel is acknowledged independently. Superseding an in-flight alert can add temporary one-second alarm wakeups until its provider call finishes; HTTP calls remain bounded by the notifier timeout.

These are account-wide allowances, not a reservation. Other Workers, abuse of the public endpoint or many status requests consume the same budget. Free-tier exhaustion fails closed; it can prevent alerts. Pricing references, checked 2026-10-11: https://developers.cloudflare.com/durable-objects/platform/pricing/ and https://developers.cloudflare.com/workers/platform/limits/.

## Local checks

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run smoke
```

Tests use the maintained `@cloudflare/vitest-plugin`, the successor to the deprecated `@cloudflare/vitest-pool-workers`. They run in workerd with the real SQLite-backed object binding. They cover stable identity across instance URL changes, silent retirement of superseded objects, heartbeat expiry/recovery, alarm redelivery, restart persistence, the two-failure threshold, network/timeout observations, cron wiring, durable retry backoff, partial delivery, superseding transitions and in-flight completions, shared alarm scheduling, pending status, channel additions/removals, all notifier formats, ntfy authentication validation, configuration refusal, constant-time comparison and routing. The suite runs in less than one minute.

`npm run smoke` starts a local Wrangler server and a local webhook listener with a disposable test token and storage. It verifies startup refusal without a notifier, ping/status JSON, unknown-path 404, a real alarm's DOWN delivery and recovery UP delivery. It never triggers `/up` probes or sends external notifications. It stops both servers and removes temporary files when done.

For interactive local development, copy `.dev.vars.example` to `.dev.vars`, fill in a test token and your local listener's webhook URL, then run `npm run dev`. Never use real notifier credentials for local smoke tests. `.dev.vars*`, `.env*`, `.wrangler/` and local agent rules are ignored; only the example file is tracked.

Lint uses the existing TypeScript dev dependency rather than adding another package. It rejects explicit `any`, type casts, non-null assertions, debugger statements, empty catch blocks and suppression comments, and checks tool-script syntax. Typecheck is separate. CI runs lint, typecheck, the Workers-runtime tests and the local smoke test on Node.js 24; it does not deploy or send notifications.

Pinned tools are Wrangler 4.148.0, `@cloudflare/vitest-plugin` 1.3.7, TypeScript 6.0.3 and Vitest 4.1.11. The shared compatibility date is 2026-10-11: both pinned tools use workerd 1.20261006.1, which supports dates through 2026-10-13. The chosen date is supported and not in the future. Regenerate binding/runtime declarations with `npm run types` after changing bindings or compatibility settings.

`npm audit` reports advisories only in development tooling (Wrangler, Miniflare and the test pool); `npm audit --omit=dev` finds none. The Worker has no production npm dependencies; its only imports are application files and native Workers modules. Do not expose local dev servers to untrusted traffic. Review upstream fixes before updating the lockfile; do not use a breaking `npm audit fix --force` downgrade.

## Limits / known gaps

- Recovery pings wait for notifier delivery before returning; slow or failed delivery can delay the response even though UP is already persisted.
- The placeholder `INSTANCE_URL` is a valid HTTPS origin and passes validation; replace it before deployment to avoid probing the example host.
- One Cloudflare vantage point. It cannot prove availability from every network, detect regional outages or alert reliably during a Cloudflare outage.
- A running scheduler can ping while other jobs fail. `/up` only checks what Heptapod exposes there; it is not a full business-function test.
- Heartbeat DOWN occurs after grace from the last ping, plus any alarm delay. Cloudflare documents alarm delays up to a minute during maintenance/failover. Pull DOWN takes roughly five to ten minutes from an outage, plus probe time. Recovery waits for the next ping/check.
- Consecutive failures count delivered cron checks, not exact elapsed intervals. Overlapping checks are coalesced while in flight; sequential duplicate cron delivery can count twice.
- No dashboard, public status page, notification history, multi-instance configuration or multi-region checking. Pending alerts retain bounded unreported-outage information, not every outage interval. Alerts are English only.
- Deployment, provider verification and real email delivery need the owner's account and a controlled production check. Local tests do not establish those external prerequisites.
