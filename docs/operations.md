# Operations

## Update Uppa

Review upstream changes before you update a deployed installation. Then run:

```sh
git pull --ff-only
bun install
bunx wrangler d1 migrations apply edge-uptime --remote
bunx wrangler deploy
```

Wrangler shows and confirms pending migrations before it applies them.

## Configure a webhook

The setup command can configure the optional HTTPS webhook. You can also set it
later:

```sh
bunx wrangler secret put WEBHOOK_URL
```

Wrangler prompts for the value. Do not put it in source, `wrangler.jsonc`,
`.dev.vars`, or shell arguments. Without this secret, Uppa records status
transitions but does not create notification work.

## Free-plan budgets

The scheduled path has these tested maximums:

| Resource | Maximum per scheduled run |
| --- | ---: |
| Enabled monitor probes | 40 |
| Webhook delivery attempts | 4 |
| External fetches | 44 |
| Concurrent probes | 5 |
| D1 statements | 40 |
| Rows per history or incident statement | 10 |

Start with 10 through 20 monitors. In the Cloudflare dashboard, monitor Worker
CPU time, invocations, errors, and D1 activity. Reduce the number of enabled
monitors if CPU approaches the Free-plan allowance, errors increase, or runs
regularly overlap the next minute.

Cloudflare can change plan limits. Check the current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) before
you operate near the maximum capacity.

Run the combined worst-case proof locally with:

```sh
bunx vitest run tests/scheduler.test.ts -t "handles the combined 40-monitor rollover"
```

Inspect structured Worker logs for `webhook_terminal_failure`. This record
contains only an outbox ID and attempt count.
