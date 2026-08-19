# Start here

This repository contains the Edge Uptime Monitor contract, local ticket plan, and the first runnable application slice.

## Sources of truth

- `CONTEXT.md` — canonical product terms.
- `SPEC.md` — detailed v1 behavior and architecture contract.
- `.scratch/edge-uptime-v1/spec.md` — user-facing implementation specification.
- `.scratch/edge-uptime-v1/issues/` — one implementation ticket per file, with explicit blockers.
- `AGENTS.md` — persistent working and safety rules.
- `.pi/prompts/build-v1.md` — implements one unblocked ticket per fresh Pi session.

Bun is the only package manager and script runner.

## Implementation workflow

Start Pi from this trusted project and invoke:

```text
/build-v1
```

One invocation selects the lowest-numbered unblocked ticket, implements it test-first, reviews it, runs `bun run check`, marks it complete, and commits it. It intentionally stops after one ticket. Run `/clear` before invoking `/build-v1` for the next ticket so each slice gets a fresh context.

Alternative without prompt-template discovery:

```sh
pi @PI_PROMPT.md
```

If Pi was already running when prompt/context files changed, run `/reload` first.

## Current local commands

```sh
bun install
bun run dev
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
bun run db:migrate:local
```

## Safety boundary

Ticket implementation may install local Bun dependencies, edit code/migrations, apply local D1 migrations, and smoke-test local development. It must not create production Cloudflare resources, request credentials, run remote migrations, or deploy. Final operator/deployment documentation is delivered by the last ticket.

## Review checkpoints

For every ticket:

1. its acceptance criteria are actually verified,
2. `bun run check` passes,
3. required local migration/smoke checks pass,
4. tracked and untracked files contain no private URL, secret, generated junk, or non-Bun lockfile,
5. platform-driven deviations are recorded in `SPEC.md`, not silently implemented.

## Pi references

- Context and project trust: https://pi.dev/docs/latest/quickstart
- Prompt templates: https://pi.dev/docs/latest/prompt-templates
