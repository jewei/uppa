# Edge Uptime Monitor — v1 Specification

Status: implementation contract  
Target: Cloudflare Workers Free plan  
Last reviewed: 2026-08-19

`CONTEXT.md` defines product language. This file defines required behavior and architecture.

## 1. Product

A small, self-hosted uptime monitor with:

- a public, read-only status page,
- up to 40 HTTP/HTTPS monitors,
- scheduled GET checks once per minute,
- 24-hour, 7-day, and 30-day uptime/latency history,
- incident history,
- reliable generic webhook notifications,
- an operator-only Bun CLI for monitor configuration.

There is no browser admin interface, login, session, or manual probe in v1. This is one Cloudflare vantage point, not multi-region proof of availability.

## 2. Architecture

One repository, package, Worker, D1 database, and minute Cron Trigger:

```text
Browser ──▶ static vanilla TypeScript SPA ──▶ native Worker /api/*
                                                  │
Cron */1 ──▶ lease ──▶ probe pool ──▶ reduce ──▶ D1 transaction
                                                  │
                                                  └──▶ outbox delivery
Operator ──▶ interactive Bun CLI ──▶ Wrangler ──▶ D1 configuration
```

Locked choices:

- Bun is the only package manager and script runner.
- Production runs in Cloudflare Workers/workerd, not Bun.
- Vite plus the Cloudflare Vite plugin builds static vanilla TypeScript and Worker code.
- Native Worker request routing; no Hono or frontend framework.
- D1 is authoritative persistence. Workers Cache API is short-lived public-response caching only.
- Monitor configuration is relational. Current monitoring truth, active aggregation, and rolling uptime counters are one versioned packed D1 row.
- Five-minute and hourly history, incidents, and notification outbox are relational.
- Cron is the only writer of monitoring truth. The CLI writes configuration only.

## 3. Hard limits

```text
MAX_MONITORS = 40                 # non-deleted definitions
RECOMMENDED_INITIAL_MONITORS = 20
PROBE_CONCURRENCY = 5
PROBE_TIMEOUT_MS = 8000
FAILURE_THRESHOLD = 2
MAX_OUTBOX_DELIVERIES_PER_RUN = 4
MAX_OUTBOX_ATTEMPTS = 20
WEBHOOK_TIMEOUT_MS = 8000
SCHEDULER_LEASE_MS = 120000
SCHEDULED_D1_QUERY_BUDGET = 40
FIVE_MINUTES_MS = 300000
ONE_HOUR_MS = 3600000
PUBLIC_STATUS_CACHE_SECONDS = 60
PUBLIC_HISTORY_CACHE_SECONDS = 300
```

### External requests

Each enabled monitor performs one `fetch()` with `redirect: "manual"`. At most four webhook rows are attempted, also with manual redirects.

```text
40 probes + 4 deliveries = 44 external fetches
```

No other scheduled-path external request is allowed. The current Workers Free ceiling is 50. Probe concurrency five also remains below the six simultaneous-open-connection limit.

### D1 statements

The current D1 Free ceiling is 50 queries per Worker invocation; every statement in `batch()` counts. A scheduled run may use at most 40, including lease claim/renew/release, reads, persistence, maintenance, and outbox updates.

Use multi-row statements in chunks of at most 10 so history/incident writes remain beneath the current 100-bound-parameter limit. Test the combined worst case.

### Free-plan qualification

The design targets Free, but cannot guarantee it under arbitrary public traffic. Workers Free currently permits 10 ms CPU/invocation. Start with 10–20 monitors, observe production CPU/D1/request metrics, then raise toward 40. If a full timeout run crosses the next minute, the lease makes that invocation skip; no check is fabricated and no second truth writer overlaps.

## 4. Data model

Application timestamps are Unix milliseconds. Use parameterized prepared statements and explicit columns.

### `monitors`

```sql
CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
```

Rules:

- name is trimmed, 1–100 characters, and public;
- URL is canonical HTTP/HTTPS, at most 2,048 characters, with no credentials or fragment;
- reject `localhost` and private/reserved IP literals;
- all checks use GET, fixed 8-second timeout, accepted status 200–299, and no redirect following;
- at most 40 non-deleted rows, enforced atomically;
- delete is soft deletion and frees capacity;
- public APIs/logs never reveal URLs.

### `app_state`

```sql
CREATE TABLE app_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Seed one valid empty v1 row. The decoder validates every field and rejects malformed/unsupported state rather than resetting it.

```ts
interface Aggregate {
  checks: number;
  successes: number;
  failures: number;
  latencySum: number;
  latencyMin: number | null;
  latencyMax: number | null;
}

interface RuntimeState {
  status: "pending" | "up" | "down";
  lastCheckedAt: number | null;
  lastLatencyMs: number | null;
  lastStatusCode: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  tentativeFailureAt: number | null;
  tentativeFailureError: string | null;
  tentativeFailureStatusCode: number | null;
  openIncidentId: string | null;
  activeFiveMinute: ({ bucketStart: number } & Aggregate) | null;
  activeHour: ({ bucketStart: number } & Aggregate) | null;
  rolling: {
    throughBucketStart: number | null;
    "24h": { checks: number; successes: number };
    "7d": { checks: number; successes: number };
    "30d": { checks: number; successes: number };
  };
}

interface AppStateV1 {
  version: 1;
  lastScheduledAt: number | null;
  lastCleanupDay: number | null;
  updatedAt: number | null;
  monitors: Record<string, RuntimeState>;
}
```

`lastScheduledAt` makes duplicate/out-of-order scheduled events no-ops. A random run ID exists only in logs.

### `history_5m`

```sql
CREATE TABLE history_5m (
  monitor_id TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  checks INTEGER NOT NULL,
  successes INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  latency_sum INTEGER NOT NULL,
  latency_min INTEGER,
  latency_max INTEGER,
  PRIMARY KEY (monitor_id, bucket_start)
) WITHOUT ROWID;
```

Retain seven days.

### `history_1h`

Same aggregate columns with `hour_start` and primary key `(monitor_id, hour_start) WITHOUT ROWID`. Retain 30 days.

The scheduler feeds each finalized five-minute accumulator into the packed active-hour accumulator. It writes the previous complete hour in chunks on rollover, avoiding an hourly history scan.

### `incidents`

```sql
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  monitor_id TEXT NOT NULL,
  monitor_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  confirmed_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_reason TEXT CHECK(ended_reason IN ('recovered', 'disabled', 'deleted')),
  first_error TEXT,
  last_error TEXT,
  first_status_code INTEGER,
  last_status_code INTEGER,
  CHECK((ended_at IS NULL AND ended_reason IS NULL)
     OR (ended_at IS NOT NULL AND ended_reason IS NOT NULL))
);

CREATE UNIQUE INDEX incidents_one_open_per_monitor
  ON incidents(monitor_id) WHERE ended_at IS NULL;
CREATE INDEX incidents_recent ON incidents(started_at DESC);
```

Incidents are retained indefinitely. Name is snapshotted. Public responses expose name, times, and closure reason—not error/status details.

### `notification_outbox`

```sql
CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  sent_at INTEGER,
  failed_at INTEGER,
  CHECK(sent_at IS NULL OR failed_at IS NULL)
);

CREATE INDEX notification_outbox_due
  ON notification_outbox(next_attempt_at, created_at)
  WHERE sent_at IS NULL AND failed_at IS NULL;
```

Sent rows are pruned after seven days; terminally failed rows after 30 days. Terminal failure is visible through structured Worker logs only.

### `scheduler_lock`

```sql
CREATE TABLE scheduler_lock (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
```

Seed `id = 1`.

## 5. Configuration CLI

Provide interactive Bun commands to list, add, edit, enable, disable, and soft-delete monitors. Every mutating command requires exactly one explicit target: `--local` or `--remote`.

- No checked-in monitor configuration or URL.
- Prompt for private URLs rather than accepting them as positional command arguments.
- Redact URLs in list output unless `--show-urls` is explicit.
- Validate using the same pure monitor validator as application code.
- Execute parameter-safe SQL through Wrangler. If Wrangler requires a SQL file, create a mode-`0600` temporary file and remove it in `finally`.
- Confirm destructive and remote operations interactively.
- Enforce the 40-row cap atomically in SQL.
- The CLI never changes app state, history, incidents, or outbox.

## 6. Scheduled checks

### Lease

1. Claim atomically when `lease_until <= wallNow` with a random owner token.
2. Set expiry to wall time + 120 seconds.
3. Exit successfully if held.
4. Load state/config and skip when `scheduledTime <= lastScheduledAt`.
5. After probes, renew with the owner token before persistence; abort persistence if ownership is lost.
6. Release in `finally` only with the owner token.

Scheduled event time identifies the check and aligns buckets. Wall time is only for lease/network delivery.

### Probe

- One GET fetch, `redirect: "manual"`, 8-second AbortController timeout.
- 200–299 succeeds; every other status fails.
- Measure monotonic time to response headers.
- Never read/store bodies; promptly cancel/discard them.
- Persist only bounded allow-listed errors: timeout, network failure, or `Expected status 200-299, received N`.
- Never persist/log raw thrown messages, stacks, bodies, or URLs.

Probe enabled monitors through a fixed pool of five with stable monitor/result association.

### State transitions

- New/re-enabled monitor starts pending with zero failures.
- Pending or up + first failure: retain current status, count one, and remember tentative failure details/time.
- Pending or up + second consecutive failure: transition down, open one incident beginning at the first failure and confirmed at the second, emit DOWN.
- Down + failure: remain down; update latest failure only in packed state.
- Pending/up + success: up, reset failure/tentative details; initial success emits no webhook.
- Down + success: up, close incident as recovered, emit RECOVERED.
- Disable: no checks/public display; close open incident as disabled, no webhook, reset to pending.
- Delete: close open incident as deleted, no webhook; retain state only long enough to finalize accumulators, then remove it.

Only DOWN and RECOVERED notify. One run creates at most one payload containing every transition.

## 7. Aggregation

Five-minute and hourly starts are UTC floor-aligned from scheduled time. Each recorded result increments checks; success adds latency; failure adds no latency.

```text
checks = successes + failures
uptime = successes / checks * 100
checks = 0 => null
latency statistics use successful checks only
```

Missed Cron invocations create no checks.

At five-minute rollover:

1. finalize prior five-minute accumulators in chunks of at most 10;
2. feed them into active-hour accumulators;
3. advance packed 24h/7d/30d rolling counters, subtracting the entire expired range across missed intervals;
4. start current accumulators from current results.

At hour rollover, write finalized active hours in chunks and start the new hour. Finalize stale disabled/deleted accumulators without fabricating a result.

Once per UTC day, use `lastCleanupDay` to delete five-minute rows older than seven days, hourly rows older than 30 days, sent outbox rows older than seven days, and failed rows older than 30 days. Update cleanup checkpoint in the same transaction.

## 8. Transaction and outbox

After probes, reduce all effects into one deterministic statement plan. One D1 `batch()` transaction contains applicable history rows, incident opens/closes, at most one outbox row, cleanup, and one app-state update. `batch()` rollback prevents partial monitoring truth.

After commit, if `WEBHOOK_URL` exists:

1. select at most four due pending rows;
2. POST JSON concurrently with 8-second timeout and manual redirects;
3. 2xx marks sent; timeout/network/non-2xx increments attempts;
4. retry after 1m, 5m, 15m, 1h, then 6h maximum;
5. attempt 20 sets `failed_at` and logs terminal failure;
6. batch the at-most-four D1 result statements.

If no webhook is configured, transitions create no outbox row. The HTTPS webhook URL is the only webhook credential; no signature in v1. Delivery failure never rolls back monitoring truth.

Payload is versioned, contains no URL, and batches all run transitions:

```json
{
  "version": 1,
  "type": "uptime.state_changes",
  "createdAt": "2026-08-19T03:15:00.000Z",
  "changes": []
}
```

## 9. Public APIs

Native Worker routing handles only:

```text
GET /api/status
GET /api/monitors/:id/history?range=24h|7d|30d
```

Unknown API routes return JSON 404. Every response is an explicit allow-listed DTO; rows, state documents, config, environment, URLs, and errors are never serialized directly.

`GET /api/status` returns:

- generated time;
- site name/description from non-secret Worker variables;
- overall status;
- enabled monitors ordered by position then creation time;
- each monitor's public name/status/last check/last successful latency and rolling 24h/7d/30d uptime;
- at most 20 recent incidents with closure reason.

Overall status:

- operational: at least one enabled monitor and all are up;
- degraded: any enabled monitor is down;
- unknown: no enabled monitor, or pending exists and none is down.

A first failure does not create a public fourth state.

History:

- 24h: five-minute points (at most 288 plus current);
- 7d: five-minute points aggregated server-side to 30-minute display points;
- 30d: hourly points (at most 720 plus current hour);
- only enabled monitor IDs are public;
- each point includes time, checks/successes/failures, and success latency min/max/average.

Cache canonical successful status responses for 60 seconds and history responses for 300 seconds using Cache API. Do not cache API errors or unknown parameters.

Worker-generated responses set `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and framing protection.

## 10. Public page

A restrained, polished vanilla TypeScript SPA:

- site identity and operational/degraded/unknown banner;
- accessible monitor list with explicit text, not color alone;
- uptime for 24h/7d/30d;
- one selected-monitor chart below the list with range controls;
- recent incidents;
- responsive loading/empty/error states;
- status refresh every 60 seconds;
- history loads only when monitor/range selection changes;
- simple SVG/CSS chart, no UI/chart dependency.

Static assets use a public `_headers` file for CSP, clickjacking, MIME-sniffing, referrer, and permissions policy. API responses attach equivalent relevant headers in Worker code.

## 11. Security and observability

Secrets:

```text
WEBHOOK_URL  # optional Worker secret
```

Variables:

```text
SITE_NAME
SITE_DESCRIPTION
```

No application auth secrets exist because there is no remote administration endpoint.

Structured logs may contain run ID/time, lease outcome, monitor/result/transition counts, durations, D1 statement count, outbox ID/outcome, and safe error classification. Never log full monitor/webhook URLs, raw exceptions, response bodies, credentials, environment dumps, or SQL containing URLs.

## 12. Tests

Test behavior at the highest practical seam.

- Monitor validation and atomic 40-row cap.
- CLI target requirement, URL redaction, confirmation, temp-file cleanup, and no truth-table mutation.
- Probe success, invalid status, redirect not followed, timeout, network error, body cancellation, sanitized errors.
- Pending/up/down transitions, tentative first-failure incident start, recovery, disable/delete, no duplicates.
- Five-minute/hourly aggregation, mixed buckets, success-only latency, rollover, missed intervals, rolling expiry, stale accumulators.
- Pool concurrency <=5 and stable association.
- Lease claim/renew/release ownership, overlap, lost renewal, duplicate scheduled time.
- Combined worst-case <=44 external fetches and <=40 D1 statements; bounded chunks.
- Transaction atomicity.
- Outbox batching, no-webhook behavior, retry schedule, redirect, cap four, attempt 20, successful send.
- Public DTO/cache excludes URLs/private state; history ranges/resolutions; status semantics.
- Public page accessibility-critical states and no secret in built assets.
- Fresh local migration and local Worker/SPA smoke test.

Pure modules use ordinary Vitest; Worker/D1/Cache behavior uses Cloudflare Workers Vitest integration. No test calls real websites.

## 13. Commands and completion

```sh
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
```

V1 is done only when all pass, migrations apply to fresh local D1, local Worker+SPA starts, scheduled tests need no Internet, public artifacts contain no URL/secret, the query/subrequest budgets are proven, and `README.md` documents Bun, CLI configuration, D1, secrets, local development, Free-plan caveats, and user-run deployment without performing remote actions.

## 14. Out of scope

- browser admin, login/session/CSRF, manual probes
- configurable method/status/timeout or redirect following
- annual history/daily rollups
- TCP, DNS, ICMP, geographic checks, certificates, body assertions, authenticated/custom requests
- maintenance windows, SLOs, billing, teams, multi-user auth
- provider-specific alerts, webhook signing, terminal-failure UI/CLI
- SSR, UI frameworks, chart libraries, themes, localization, plugins
- KV, R2, Durable Objects, Queues, Workflows, Hyperdrive
- ORM, infrastructure-as-code, Docker/Kubernetes, remote probe agents

## 15. Official references

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cron: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Static Assets: https://developers.cloudflare.com/workers/static-assets/
- Static headers: https://developers.cloudflare.com/workers/static-assets/headers/
- Vite plugin: https://developers.cloudflare.com/workers/vite-plugin/
- Workers Vitest: https://developers.cloudflare.com/workers/testing/vitest-integration/
- D1 pricing/limits/API: https://developers.cloudflare.com/d1/platform/pricing/ and https://developers.cloudflare.com/d1/platform/limits/ and https://developers.cloudflare.com/d1/worker-api/d1-database/
