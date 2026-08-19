# 05 — Deliver transition webhooks reliably

**What to build:** Confirmed DOWN and RECOVERED transitions commit one private-safe outbox payload per run and deliver with bounded retry independently of monitoring persistence.

**Blocked by:** 04 — Track and display incidents.

**Status:** complete

- [x] Same-run transitions form one versioned payload with no URL; initial UP and administrative closure do not notify.
- [x] Outbox creation shares the monitoring transaction and is omitted when no webhook is configured.
- [x] At most four due rows use concurrent manual-redirect delivery with timeout and expected backoff.
- [x] Success, retry, attempt-20 terminal failure/logging, and pruning are correct.
- [x] Delivery failure never rolls back state and combined external/D1 budgets remain within limits.
- [x] Outbox integration tests plus `bun run check` pass.
