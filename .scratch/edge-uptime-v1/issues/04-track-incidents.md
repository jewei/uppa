# 04 — Track and display incidents

**What to build:** Confirmed outages create one durable incident from the first observed failure, recovery/disable/delete close it correctly, and visitors can see bounded private-safe incident history.

**Blocked by:** 03 — Check monitors and publish uptime history.

**Status:** complete

- [x] DOWN opens exactly one incident with first-failure start and second-failure confirmation times.
- [x] Continued DOWN performs no duplicate incident or steady-state incident write.
- [x] Recovery, disablement, and deletion close with the correct reason and latest safe details.
- [x] Recent public incident DTO exposes only name/times/reason and remains useful after rename/delete.
- [x] Database invariant and transition/integration tests plus `bun run check` pass.
