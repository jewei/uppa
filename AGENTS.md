# AGENTS.md — Edge Uptime Monitor

## Contract

Read `SPEC.md` before changing product behavior, architecture, persistence, security, budgets, or platform configuration. Read `CONTEXT.md` when changing domain concepts. `SPEC.md` governs behavior; this file governs working practice.

If current official Cloudflare behavior conflicts with the contract, cite the source, make the smallest safe adjustment, and update `SPEC.md` in the same change.

## Working approach

- Prefer the smallest correct implementation; build no speculative seam, feature, or dependency.
- Keep the truth path traceable: schedule -> lease -> snapshot -> probe -> pure reduction -> transaction -> outbox delivery.
- Put Worker/D1/Wrangler details at the edges. Keep validation, transitions, aggregation, retries, and statement planning pure.
- Use strict TypeScript, named exports, focused modules, explicit boundary validation, and stable allow-listed DTOs/errors.
- Never serialize rows, packed state, configuration, or environment objects directly.
- No production dependency without a present `SPEC.md` requirement.

## Toolchain

Bun is the sole package manager and script runner:

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
```

Commit `bun.lock`; never use npm, pnpm, Yarn, or Bun-only server APIs in Worker code.

## Hard guardrails

- One native Worker plus vanilla TypeScript/Vite static SPA; no Hono, Preact, or browser admin.
- D1 is authoritative. Cache API is only short-lived public GET caching.
- At most 40 non-deleted monitors, five concurrent probes, 44 scheduled external fetches, and 40 scheduled D1 statements.
- Checks are fixed GET, 8 seconds, 200–299, manual redirect.
- Cron alone changes monitoring truth. The Bun CLI changes relational monitor configuration only.
- Two failures confirm DOWN; one success confirms/reconfirms UP. An incident starts at the first failure once confirmed by the second.
- Persist state/history/incidents/outbox atomically before webhook delivery.
- Public responses and logs never reveal monitor URLs or webhook URL. Persist only allow-listed probe errors.
- Chunk history/incident statements at at most 10 rows and test the combined worst case.

## Database and scheduler

- Schema changes are new files in `migrations/`; never edit a shipped migration.
- Worker D1 code uses parameterized prepared SQL, explicit columns, Unix-millisecond timestamps, and validated versioned packed state. Wrangler-only CLI SQL uses validated integer literals and hex-encoded text literals because `wrangler d1 execute` has no parameter-binding option.
- Preserve composite `WITHOUT ROWID` history tables and justified partial indexes unless current D1 behavior requires a documented change.
- Enforce the monitor cap and one-open-incident invariant in SQL.
- Use scheduled event time for check identity/buckets and wall time for leases/network delivery.
- Claim, renew, and release the lease by owner token. Skip duplicate/out-of-order events and never fabricate missed checks.
- Avoid steady-state incident writes while continuously down; copy latest packed failure details on closure.

## Security

- Commit Cloudflare resource identifiers required by `wrangler.jsonc`, including the D1 `database_id`. These identifiers are not credentials. Never commit API tokens, Worker secrets, webhook URLs, or monitor URLs.
- Worker secrets never enter source, Wrangler config, fixtures, screenshots, logs, public DTOs, cache entries, or frontend builds.
- CLI URLs are interactive/redacted; remote/destructive operations require explicit target and confirmation; private temporary SQL files are removed in `finally`.
- Logs omit full URLs, raw exceptions, stacks, bodies, credentials, environment dumps, and SQL containing URLs.
- Do not create remote resources, run remote migrations, or deploy unless explicitly requested.

## Tests and completion

Tests are part of each slice. Use ordinary Vitest for pure logic and Workers integration only for runtime/D1/Cache behavior. Never call real websites.

After meaningful changes, run the narrow test first and then `bun run check`. Do not weaken assertions, skip failures, suppress errors, or add broad catches to get green.

V1 completion requires every criterion in `SPEC.md`, a fresh local migration, local Worker/SPA smoke test, and review of tracked/untracked files plus built assets for secrets, private URLs, generated junk, and non-Bun lockfiles.

## Git

Inspect `git status` before edits. Preserve user work. Never reset unrelated changes, rewrite history, force-push, or delete work to simplify a task. Implementation tickets are committed independently after review.

## Agent skills

### Issue tracker

Issues/specs use local Markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Local status values use the canonical triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
