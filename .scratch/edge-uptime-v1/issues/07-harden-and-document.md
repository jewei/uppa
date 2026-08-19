# 07 — Prove limits and document operation

**What to build:** The finished monitor is locally reproducible, demonstrates its Free-plan budgets under worst-case behavior, and gives the operator exact safe setup/deployment instructions.

**Blocked by:** 05 — Deliver transition webhooks; 06 — Complete the cached public status experience.

**Status:** complete

- [x] Combined worst-case tests prove <=44 external fetches, <=40 D1 statements, bounded chunks, and concurrency five.
- [x] Fresh local migration and Worker/SPA smoke tests pass from a clean state.
- [x] Logs/artifacts/repository are audited for URLs, secrets, raw exceptions, generated junk, and non-Bun lockfiles.
- [x] README documents Bun, CLI local/remote operation, D1 creation/binding/migrations, variables/optional secret, checks, Free-plan telemetry guidance, and user-run deployment.
- [x] Every root specification completion criterion is checked and `bun run check` passes.
