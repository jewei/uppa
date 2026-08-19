---
description: Implement the next unblocked uptime-monitor ticket
---

Implement exactly one unblocked v1 ticket.

1. Read `AGENTS.md`, `CONTEXT.md`, `SPEC.md`, `.scratch/edge-uptime-v1/spec.md`, and `docs/agents/issue-tracker.md`.
2. Inspect `git status` and recent commits. Preserve user work.
3. Read every ticket under `.scratch/edge-uptime-v1/issues/`. Choose the lowest-numbered `ready-for-agent` ticket whose blockers are all `complete`. If none exists, report why and stop.
4. Treat that ticket as the implementation scope. Do not begin a second ticket.
5. Drive the ticket through the pre-agreed seams test-first: one failing behavior, minimal passing implementation, then the next behavior.
6. Verify current official Cloudflare documentation when platform-sensitive configuration is involved. If a fact invalidates the contract, make the smallest correction and update `SPEC.md`.
7. Run narrow tests throughout, then `bun run check`. Apply fresh local migrations and smoke-test local development when the ticket requires them.
8. Review the complete ticket diff against both `AGENTS.md` and the ticket/spec. Fix findings before completion.
9. Mark the ticket `complete`, check only criteria actually verified, and commit the ticket with a concise Conventional Commit message.
10. Report behavior delivered, checks run, commit, and the next unblocked ticket. Stop so the next ticket starts in a fresh context.

Use Bun exclusively. Never deploy, create remote resources, run remote migrations, request credentials, or place private URLs/secrets in source, logs, fixtures, commands, or frontend artifacts.
