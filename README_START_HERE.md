# Start here

This repository currently contains the reviewed implementation contract and Pi workflow for the Edge Uptime Monitor. It does not contain the application yet.

## Contract files

- `CONTEXT.md` — canonical product terms.
- `SPEC.md` — v1 product behavior, architecture, limits, schema, security, and completion contract.
- `AGENTS.md` — persistent working rules that Pi loads automatically.
- `.pi/prompts/build-v1.md` — trusted project prompt template invoked as `/build-v1`.
- `PI_PROMPT.md` — small pointer for invoking the same build request without template discovery.

Bun is the required package manager and script runner. The implementation must not introduce npm, pnpm, Yarn, or their lockfiles.

## Before `/build-v1`

Install current Bun and Pi, then put the contract under version control so the implementation diff is reviewable:

```sh
bun --version
pi --version
git init
git add AGENTS.md CONTEXT.md SPEC.md README_START_HERE.md PI_PROMPT.md .pi/prompts/build-v1.md
git commit -m "docs: define uptime monitor v1"
```

The commit is strongly recommended but optional. Review the files before committing them.

Start Pi from this directory. Project-local prompt templates load only after the project is trusted:

```sh
pi
```

If prompted, trust the project and restart Pi. If Pi was already running when these files changed, run `/reload`. Then invoke:

```text
/build-v1
```

Alternative without project prompt discovery:

```sh
pi @PI_PROMPT.md
```

## What the build may and may not do

The build prompt may install local dependencies with Bun, initialize local Git if absent, create source/config/migrations, apply local D1 migrations, run tests/builds, and start local development for a smoke test.

It must not create production Cloudflare resources, request your credentials, run remote migrations, or deploy. The finished `README.md` will give you reviewed commands to perform those steps yourself.

## Review checkpoints

Before accepting the build:

1. `bun run check` passes.
2. A fresh local D1 migration succeeds.
3. Local Worker + SPA routing is smoke-tested.
4. `git status`/diff contains no secret, private monitor URL, generated junk, or non-Bun lockfile.
5. The implementation report names any platform-driven spec correction rather than silently deviating.

## Pi references

- Context files and project trust: https://pi.dev/docs/latest/quickstart
- Prompt templates: https://pi.dev/docs/latest/prompt-templates
