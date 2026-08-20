# Monitor behavior

## Scheduled checks

All checks use fixed settings in v1:

- one GET request per enabled monitor per scheduled minute;
- an 8-second timeout;
- HTTP status 200 through 299 is success;
- redirects are not followed;
- response bodies are discarded;
- at most five probes run at the same time.

Two consecutive failures confirm `down`. One success confirms or restores `up`.
A confirmed incident starts at the first of the two failed checks. Missed or
overlapping scheduled events do not create checks.

Disabling a monitor removes it from scheduled checks and the public page.
Re-enabling it starts confirmation again from `pending`. Deletion is soft and
frees one position in the limit of 40 monitors.

## Public status page

The public page shows:

- overall service condition;
- enabled monitor names and monitoring status;
- uptime for 24 hours, 7 days, and 30 days;
- successful-check latency history;
- recent incidents.

It does not expose monitor URLs, webhook credentials, or private probe details.

## Notifications

Only confirmed `down` and recovered transitions create webhook notifications.
Initial success, first failure, disablement, and deletion do not notify.

One scheduled run can include multiple transitions in one versioned payload.
Delivery retries are bounded and at-least-once. Receivers that require
exactly-once processing must deduplicate payloads.
