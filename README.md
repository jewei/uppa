# Edge Uptime Monitor

A self-hosted public status page and uptime monitor for Cloudflare Workers. It checks up to 40 HTTP/HTTPS monitors once per minute, stores rolling history and incidents in D1, and can deliver generic webhook notifications.

The application has no browser administration or authentication. A trusted operator manages monitor configuration with the interactive Bun CLI.

## Demo

[View the public demo](https://edge-uptime.jewei-mak.workers.dev/) to see the status page.

## Requirements

- [Bun](https://bun.sh/) 1.3 or later
- A Cloudflare account for deployment
- Wrangler authentication when using remote commands

Bun is the only supported package manager and script runner. Do not use npm, pnpm, or Yarn.

## Install and verify

```sh
bun install
bun run check
```

`bun run check` runs linting, all TypeScript checks, Worker and Node tests, both production builds, a public-artifact privacy scan, a fresh isolated migration, and local Worker/SPA smoke requests. Tests use local fakes or workerd and never contact monitored websites.

To prove migrations against an isolated fresh local D1 state:

```sh
fresh_state="$(mktemp -d)"
bunx wrangler d1 migrations apply edge-uptime --local --persist-to "$fresh_state"
rm -rf "$fresh_state"
```

## Local development

Apply migrations to Wrangler's normal local state and start the Worker and SPA:

```sh
bun run db:migrate:local
bun run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`. In another terminal, smoke-test the public API:

```sh
curl --fail --show-error http://localhost:5173/api/status
```

Local D1 data is under ignored `.wrangler/` state. Do not commit it.

## Configure monitors

Every command requires exactly one explicit D1 target. Add and edit prompt for the private monitor URL so it does not appear in command-line arguments.

```sh
# Inspect configuration; URLs are redacted by default
bun run monitor -- list --local
bun run monitor -- list --remote

# Reveal URLs only when the terminal and transcript are private
bun run monitor -- list --local --show-urls

# Add a monitor interactively
bun run monitor -- add --local

# Replace a monitor's name, URL, position, and enabled value
bun run monitor -- edit MONITOR_ID --local

# Enable, disable, or change display order
bun run monitor -- enable MONITOR_ID --local
bun run monitor -- disable MONITOR_ID --local
bun run monitor -- order MONITOR_ID --local

# Soft deletion requires confirmation
bun run monitor -- delete MONITOR_ID --local
```

Replace `--local` with `--remote` only when intentionally changing the deployed database. Every remote command asks for confirmation; deletion asks for an additional confirmation. The CLI can change relational monitor configuration only. Scheduled Cron runs remain the sole writer of status, history, incidents, and notifications.

A maximum of 40 non-deleted monitors is enforced atomically by D1. Deleting a monitor frees capacity.

## Check behavior

All checks are fixed and cannot be customized in v1:

- one GET per enabled monitor per scheduled minute;
- 8-second timeout;
- HTTP 200 through 299 is success;
- redirects are not followed;
- response bodies are discarded;
- at most five probes run concurrently.

Two consecutive failures confirm `down`; one success confirms or restores `up`. A confirmed incident starts at the first of those two failures. Missed or overlapping scheduled events create no checks.

The public page exposes monitor names, monitoring status, uptime, successful-check latency, and incidents. It never exposes monitor URLs or private probe diagnostics.

## Create Cloudflare resources

The repository contains a placeholder D1 database ID. Resource creation and all remote changes are operator-run; this project does not create or deploy remote resources automatically.

1. Authenticate Wrangler using your preferred Cloudflare workflow:

   ```sh
   bunx wrangler login
   ```

2. Create the D1 database:

   ```sh
   bunx wrangler d1 create edge-uptime
   ```

3. Copy the returned `database_id` into the `DB` entry in `wrangler.jsonc`, replacing `00000000-0000-0000-0000-000000000000`. Keep the binding name and database name unchanged.

4. Set the public site identity in the non-secret `vars` section of `wrangler.jsonc`:

   ```jsonc
   "vars": {
     "SITE_NAME": "System Status",
     "SITE_DESCRIPTION": "Current service availability"
   }
   ```

5. Apply all migrations explicitly to remote D1 and review Wrangler's confirmation:

   ```sh
   bunx wrangler d1 migrations apply edge-uptime --remote
   ```

## Deploy

Review the target account, D1 binding, public variables, migrations, and Git diff first. Then run the deployment yourself:

```sh
bun run check
bunx wrangler deploy
```

`wrangler.jsonc` deploys the static SPA and Worker together and registers the `* * * * *` Cron Trigger.

After the initial deployment, optionally configure the HTTPS generic webhook URL as a Worker secret. This is an explicit remote change. The command prompts for the value; do not put it in source, `wrangler.jsonc`, `.dev.vars`, or shell arguments:

```sh
bunx wrangler secret put WEBHOOK_URL
```

Without this secret, status transitions are persisted but no notification outbox row is created. The URL is the webhook credential; v1 does not sign payloads.

Then:

1. open the deployed status page and `/api/status`;
2. configure 10–20 monitors with the remote CLI;
3. confirm scheduled checks begin populating status and history;
4. test any webhook receiver in a controlled environment before relying on it.

No monitor URL or webhook value belongs in Git, build output, screenshots, support transcripts, or public responses.

## Free-plan budgets and telemetry

The scheduled path has tested hard bounds:

| Resource | Maximum per scheduled run |
| --- | ---: |
| Enabled monitor probes | 40 |
| Webhook delivery attempts | 4 |
| External fetches | 44 |
| Concurrent probes | 5 |
| D1 statements | 40 |
| Rows per history/incident statement | 10 |

These remain below the contracted Free-plan ceilings of 50 external subrequests, six simultaneous open connections, 50 D1 queries per invocation, and 100 bound parameters per statement. Public traffic and Worker CPU are not hard-bounded by these scheduler tests.

Start with 10–20 monitors. In the Cloudflare dashboard, watch Worker CPU time, invocations, errors, and D1 query/row activity after deployment and after each capacity increase. Also inspect structured Worker logs for `webhook_terminal_failure`; it contains only an outbox ID and attempt count. If CPU approaches the Free-plan allowance, errors rise, or runs routinely overlap the next minute, reduce enabled monitors rather than raising built-in limits. The lease deliberately skips overlap and never fabricates missed checks.

Re-run the combined worst-case proof locally with:

```sh
bunx vitest run tests/scheduler.test.ts -t "handles the combined 40-monitor rollover"
```

Cloudflare can change plan limits. Recheck the official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) before operating near maximum capacity.

## Security and recovery notes

- Public APIs and frontend artifacts use allow-listed DTOs and omit monitor URLs, webhook credentials, packed state, and probe errors.
- Worker logs never include raw exceptions, response bodies, environment dumps, SQL containing URLs, or full monitor URLs.
- API responses and static assets set CSP, clickjacking, MIME-sniffing, and referrer protections; static assets also set a permissions policy.
- Notification delivery retries are bounded. Attempt 20 becomes terminal and is visible only in structured Worker logs.
- D1 is authoritative. Cache API entries are short-lived copies of successful public GET responses.
- Schema changes must be new migration files. Never edit a migration already applied remotely.

## Useful commands

```sh
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
bun run verify
bun run db:migrate:local
bun run dev
bun run monitor -- list --local
```

See `SPEC.md` for the complete behavior and security contract and `CONTEXT.md` for domain terminology.
