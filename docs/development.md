# Local development

## Install and verify

Bun is the only supported package manager and script runner.

```sh
bun install
bun run check
```

`bun run check` runs linting, TypeScript checks, Worker and Node tests, production
builds, a public-artifact privacy scan, a fresh isolated migration, and local
Worker and SPA smoke requests. Tests use local fakes or workerd. They do not
contact monitored websites.

## Start the application

Apply migrations to the normal local D1 state and start the Worker and SPA:

```sh
bun run db:migrate:local
bun run dev
```

Open the URL printed by Vite. It is normally `http://localhost:5173`. Test the
public API in another terminal:

```sh
curl --fail --show-error http://localhost:5173/api/status
```

Local D1 data is in the ignored `.wrangler/` directory.

## Test a fresh migration

```sh
fresh_state="$(mktemp -d)"
bunx wrangler d1 migrations apply edge-uptime --local --persist-to "$fresh_state"
rm -rf "$fresh_state"
```

Do not commit local D1 state, `.dev.vars`, `.env` files, or generated build
output.
