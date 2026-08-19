---
description: Build and verify the Cloudflare uptime monitor v1
---

Implement the complete v1 in this repository.

## Preflight

Before editing:

1. Read `AGENTS.md`, `CONTEXT.md`, and `SPEC.md` completely.
2. Inspect all existing tracked and untracked files. Preserve user work.
3. If this is not a Git repository, run `git init` locally so changes are inspectable; do not create a remote or commit unless asked.
4. Verify current official Cloudflare documentation for Workers Free limits, Static Assets/Vite routing, D1 bindings/migrations/transactional `batch()`, Cron Triggers, Cache API, and Workers Vitest integration.
5. Surface a blocker only when it cannot be resolved from the contracts or official docs. Do not ask the user to re-choose fixed architecture or libraries.

`SPEC.md` is the product/architecture contract. `AGENTS.md` is the working/safety contract. Use Bun exclusively for dependency management and scripts; never run npm, pnpm, or Yarn.

Build and verify locally. Do not create remote Cloudflare resources, request credentials, run production migrations, or deploy. If a verified platform change invalidates the contract, make the smallest safe correction, update `SPEC.md`, and explain it in the final report.

## Phase 0 — executable scaffold

- Create the minimal Bun + strict TypeScript + Hono + Preact + Vite + Cloudflare Workers project.
- Configure one Worker for `/api/*`, SPA/static assets, one-minute Cron, Cache API access, and a local/placeholder D1 binding.
- Add minimal linting and the required `lint`, `typecheck`, `test`, `build`, and `check` scripts.
- Add a trivial API/runtime test and prove the frontend builds.

Completion: the scaffold uses current Cloudflare configuration and its narrow checks pass.

## Phase 1 — schema and pure domain

- Add `migrations/0001_init.sql` exactly matching the current contract, including seeds, `WITHOUT ROWID` tables, and justified partial indexes.
- Add parameterized D1 modules with explicit columns and versioned app-state validation.
- Implement pure transition, incident-effect, five-minute aggregation, rolling-window, daily-rollup planning, retry/backoff, and statement-budget functions.
- Write exhaustive unit tests before wiring infrastructure.

Completion: migrations apply to an empty local D1 database; domain tests and `bun run check` pass.

## Phase 2 — probe and scheduler

- Implement the single-fetch GET/HEAD probe with timeout classification, manual redirects, header latency, prompt body cancellation, and allow-listed errors.
- Implement the five-worker probe pool with stable result association.
- Implement token lease, scheduled-time deduplication, config reconciliation, UTC buckets, stale accumulator finalization, rolling summaries, chunked history/incidents, and one transactional persistence plan.
- Enforce 40-monitor, 44-external-fetch, and 40-D1-query budgets in code/tests. Exercise the combined worst case, not isolated optimistic cases.
- Use mocked fetch/local bindings only.

Completion: scheduler/runtime tests and `bun run check` pass without external websites.

## Phase 3 — incidents and outbox delivery

- Complete open/close lifecycle for recovery, disablement, and deletion without steady-state incident writes while continuously down.
- Create at most one transition payload per run when a webhook is configured.
- Deliver at most four due rows after commit with timeout, manual redirects, bounded backoff, terminal attempt cap, and batched D1 result updates.
- Test batching, deduplication, retry, terminal failure, delivery cap, and rollback separation.

Completion: incident/outbox tests and `bun run check` pass.

## Phase 4 — auth and HTTP APIs

- Implement admin-key login and versioned HMAC session cookies with Web Crypto.
- Validate exact Origin on every mutation; implement expiry/logout and safe errors.
- Implement race-safe admin CRUD and non-mutating manual probe.
- Implement explicit public status/history DTOs, rolling uptime, bounded history resolutions, recent incidents, and canonical short-lived public cache entries.
- Prove public/cache output excludes URLs, secrets, raw state, and admin config.

Completion: API/security/runtime tests and `bun run check` pass.

## Phase 5 — restrained frontend

- Build the accessible public status page and admin interface described in `SPEC.md` using small Preact modules and local CSS.
- Include responsive loading, empty, validation, and request-error states.
- Use simple CSS/SVG history presentation; add no UI or chart framework.
- Clearly label manual testing as diagnostic and keep private monitor data out of public code paths.

Completion: frontend tests where valuable and `bun run check` pass.

## Phase 6 — maintenance, hardening, and operator docs

- Implement one-day-at-a-time idempotent rollup catch-up and retention in the bounded scheduled plan.
- Audit query plans/statement counts, logging, public caching, built assets, and all dependency/infrastructure choices.
- Replace the starter README with exact Bun local setup, fresh local D1 migration, development, checks, user-executed production D1 binding/migration/secrets/deployment, Free-plan limits, and operating caveats.
- Remove stale TODOs and generated junk; retain intentional placeholders only.

Completion: all spec criteria are demonstrably satisfied.

## Final verification

1. Recreate and migrate a fresh local D1 database.
2. Run `bun run check`.
3. Start local Worker + SPA development and smoke-test public/admin routing; stop the process afterward.
4. Review `git status`, diffs, and every untracked file for secrets, private URLs, generated junk, accidental lockfiles, and scope creep.
5. Check every item in `SPEC.md` section 18. Do not claim completion if any item is unverified.

## Final response

Concise report:

- implemented modules and behavior,
- exact checks run and results,
- platform facts verified and any spec corrections,
- exact user-run commands for production D1 creation/binding, secrets, migrations, and deploy,
- known v1 limitations and Free-plan caveats.

Do not claim anything was deployed.
