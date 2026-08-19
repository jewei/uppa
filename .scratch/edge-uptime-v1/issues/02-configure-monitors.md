# 02 — Configure and publish monitors safely

**What to build:** An operator can manage monitor definitions through an interactive Bun CLI, and enabled monitors appear publicly as pending without exposing their URLs.

**Blocked by:** 01 — Serve an empty public status page.

**Status:** ready-for-agent

- [ ] CLI lists/adds/edits/orders/enables/disables/soft-deletes with explicit local/remote target and confirmations.
- [ ] URL input is interactive, output is redacted by default, validation is shared, and private temp SQL is always removed.
- [ ] The non-deleted 40-monitor cap is atomic and database constraints reject invalid state.
- [ ] Public status returns only enabled monitor DTO fields in deterministic order and never URL/config rows.
- [ ] CLI and Worker integration tests plus `bun run check` pass.
