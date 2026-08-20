# Uppa

A small, self-hosted uptime monitor and public status page for Cloudflare Workers.
Uppa checks up to 40 HTTP/HTTPS endpoints once per minute and stores uptime,
latency history, and incidents in D1.

[View the live demo](https://edge-uptime.jewei-mak.workers.dev/)

## Quick start

You need a Cloudflare account and [Bun](https://bun.sh/) 1.3 or later.

```sh
git clone https://github.com/jewei/uppa.git
cd uppa
bun install
bun run setup
```

The interactive setup command:

- authenticates Wrangler;
- creates or reuses the `edge-uptime` D1 database;
- asks for the public site name and description;
- applies the database migrations;
- deploys the Worker, static status page, and minute schedule;
- optionally configures a webhook and the first monitor.

Each remote change requires confirmation. You can run `bun run setup` again if
you stop before it finishes.

## Manage monitors

Add a monitor to the deployed database:

```sh
bun run monitor -- add --remote
```

List monitors with private URLs redacted:

```sh
bun run monitor -- list --remote
```

View all monitor commands:

```sh
bun run monitor -- --help
```

Uppa has no browser administration or authentication system. A trusted operator
uses this local CLI to manage monitors. Remote and destructive commands require
confirmation.

## How it works

- Each enabled monitor receives one fixed GET request per minute.
- Two consecutive failures confirm an outage.
- One successful check confirms recovery.
- The public page shows status, uptime, latency history, and recent incidents.
- An optional generic webhook reports confirmed status changes.
- Monitor URLs and webhook values never appear in public responses.

## Documentation

- [Monitor behavior](docs/behavior.md)
- [Operations and updates](docs/operations.md)
- [Security and recovery](docs/security.md)
- [Local development](docs/development.md)
- [Contributing](CONTRIBUTING.md)

See [SPEC.md](SPEC.md) for the complete product contract and [CONTEXT.md](CONTEXT.md)
for domain terminology.
