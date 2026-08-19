# 03 — Check monitors and publish uptime history

**What to build:** Minute scheduled checks establish pending/up/down status and produce bounded five-minute, hourly, and rolling uptime/latency history visible through public APIs.

**Blocked by:** 02 — Configure and publish monitors safely.

**Status:** ready-for-agent

- [ ] Single-fetch fixed GET probe classifies success/status/network/timeout safely and does not consume bodies.
- [ ] Pool concurrency never exceeds five and monitor/result association survives out-of-order completion.
- [ ] Token lease, renewal, release, and scheduled-time deduplication prevent overlapping truth writers.
- [ ] Two failures confirm DOWN, one success recovers, and first-failure tentative details are retained.
- [ ] Five-minute/hourly aggregation, rolling 24h/7d/30d counts, missed intervals, disabled/deleted reconciliation, and retention are correct.
- [ ] Status/history APIs return bounded explicit DTOs; scheduled statement/fetch budgets are measured.
- [ ] Pure and Workers integration tests plus `bun run check` pass without real websites.
