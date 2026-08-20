# Security and recovery

## Private values

- Monitor URLs stay in D1 and are redacted in normal CLI output.
- `WEBHOOK_URL` is an optional Worker secret.
- Public APIs and frontend assets contain allow-listed fields only.
- Worker logs omit URLs, credentials, response bodies, raw exceptions, stacks,
  environment dumps, and SQL that contains monitor URLs.

Use `--show-urls` only when the terminal and transcript are private:

```sh
bun run monitor -- list --remote --show-urls
```

Do not put monitor URLs or webhook values in Git, screenshots, build output, or
support transcripts.

## Protection

Worker responses and static assets set content security, framing,
MIME-sniffing, referrer, and permissions protections. D1 is authoritative.
Cache API entries are short-lived copies of successful public GET responses.

The application has no public administration endpoint, login, session, or
application authentication secret.

## Recovery

D1 migrations are forward-only. Add a new file under `migrations/`; do not edit
a migration that was applied to a remote database. Cloudflare captures a backup
when Wrangler applies migrations.

Notification delivery retries failed requests. Attempt 20 becomes terminal and
is visible in structured Worker logs. A delivery failure does not roll back
monitoring state.

If a deployment fails, correct the configuration or code and deploy again. The
setup command is safe to run again after a partial first-time setup. It reuses
the configured D1 database and applies only pending migrations.
