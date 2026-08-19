# Start here

For operator installation, local development, monitor configuration, Cloudflare setup, deployment, and Free-plan guidance, read [`README.md`](README.md).

Project sources of truth:

- `CONTEXT.md` — canonical product terms.
- `SPEC.md` — detailed v1 behavior and architecture contract.
- `.scratch/edge-uptime-v1/spec.md` — user-facing implementation specification.
- `.scratch/edge-uptime-v1/issues/` — completed implementation tickets.
- `AGENTS.md` — persistent working and safety rules.

Bun is the only package manager and script runner. No agent may create remote resources, run remote migrations, request credentials, or deploy unless the operator explicitly asks.
