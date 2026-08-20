# Contributing

Read [AGENTS.md](AGENTS.md) and [SPEC.md](SPEC.md) before you change product
behavior, architecture, persistence, security, budgets, or platform
configuration. Read [CONTEXT.md](CONTEXT.md) when you change domain concepts.

Use Bun for all package and script operations:

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
```

Tests must not contact real monitored websites. Add a new migration file for
each schema change. Do not edit a migration that was applied remotely.

Before completion, review tracked and untracked files for secrets, private URLs,
generated files, and lockfiles from unsupported package managers.
