# Edge Uptime Monitor v1

**Status:** complete

## Problem Statement

A single operator needs a small uptime monitor that can run economically on Cloudflare Workers, expose useful availability information publicly, and send dependable outage notifications without leaking private monitor URLs or becoming a platform to maintain.

## Solution

Build one Worker deployment with a vanilla TypeScript status page, native public APIs, minute scheduled checks, D1 persistence, a transactional generic-webhook outbox, and an interactive Bun CLI that configures monitors through local or remote Wrangler D1 commands. Keep all scheduled work beneath explicit Free-plan budgets and validate the 40-monitor ceiling through production telemetry.

## User Stories

1. As a visitor, I want to see whether monitored services are operational, so that I know whether an outage is occurring.
2. As a visitor, I want explicit monitoring status values and not color-only signals, so that the page is accessible.
3. As a visitor, I want 24-hour, 7-day, and 30-day uptime, so that I can judge recent reliability.
4. As a visitor, I want one selected monitor's latency/history chart, so that the page stays useful without loading every history series.
5. As a visitor, I want recent incident times and closure reasons, so that I understand prior outages without seeing private diagnostics.
6. As an operator, I want to add, edit, order, enable, disable, and delete monitors with an interactive Bun CLI, so that no remote admin interface is exposed.
7. As an operator, I want local and remote CLI targets to be explicit, so that I cannot accidentally change production.
8. As an operator, I want URLs redacted by default, so that terminal transcripts do not routinely expose them.
9. As an operator, I want checks every minute when capacity permits, so that outages are detected quickly.
10. As an operator, I want two failures to confirm DOWN and one success to recover, so that alerts resist a lone transient failure.
11. As an operator, I want confirmed incidents dated from their first failed check, so that recorded outage duration reflects observation.
12. As an operator, I want all same-run transitions in one generic webhook, so that notifications are complete and bounded.
13. As an operator, I want webhook retries to survive transient failure without blocking monitoring truth, so that alerts are dependable.
14. As an operator, I want terminal webhook failure logged after bounded retries, so that broken delivery cannot create unbounded work.
15. As an operator, I want missed or overlapping scheduler events skipped rather than invented, so that uptime uses observed checks only.
16. As an operator, I want monitor URLs and webhook credentials excluded from public output, logs, and frontend assets, so that monitoring does not disclose private configuration.
17. As an operator, I want the system to fit the Free plan at a conservative initial load and expose hard budgets in tests, so that scaling toward 40 is deliberate.
18. As a maintainer, I want one traceable scheduled path and pure decision logic, so that I can understand and test the product end to end.

## Implementation Decisions

- Bun only; Cloudflare Worker runtime in production.
- One package/deployment/database/Cron Trigger.
- Vanilla TypeScript + Vite + Cloudflare Vite plugin; native Worker routing.
- D1 relational configuration, five-minute/hourly history, incidents, outbox, and lease.
- One validated versioned packed row for runtime state, active accumulators, and rolling 24h/7d/30d counts.
- Fixed GET probes, 8-second timeout, 200–299 success, manual redirects, concurrency five.
- Maximum 40 non-deleted monitors; recommend 10–20 initially.
- Lease ownership plus scheduled-time deduplication; slow overlap skips.
- Seven days of five-minute history and 30 days of hourly history.
- Disable/delete close incidents without recovery notification; re-enable starts pending.
- Generic un-signed webhook URL, one batched transition payload/run, four deliveries/run, 20 attempts.
- Public Cache API TTLs of about 60 seconds for status and five minutes for history.
- No browser admin/auth/manual probe, annual history, configurable probe behavior, framework UI, or provider-specific notification.

Primary test seams:

- pure monitor validation and CLI intent-to-SQL planning;
- pure state/incident/aggregation/outbox/statement planning;
- probe through an injected fetch/clock interface;
- native Worker `fetch()`/`scheduled()` exports with local D1/Cache integration.

## Testing Decisions

Tests assert observable results and budgets, not private helper structure. Pure domain modules run in ordinary Vitest; Worker, D1 transaction, migrations, Cache API, and routing run with the Workers integration. Network behavior uses fake fetch and no real website. Each ticket keeps `bun run check` green and adds the narrow behavior tests needed for its slice.

## Out of Scope

Browser administration/authentication, manual checks, configurable request method/status/timeout, redirects, body assertions, custom requests, daily/annual history, multi-region checks, provider-specific alerts, signing, terminal-failure UI, SSR/framework UI, additional Cloudflare persistence products, ORM, and infrastructure automation.

## Further Notes

The Free plan's 10 ms CPU ceiling requires production measurement. Public traffic is not hard-bound. Root `SPEC.md` remains the detailed implementation contract.
