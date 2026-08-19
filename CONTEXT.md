# Domain language

Use these terms consistently in product documentation, code, and tests.

- **Public status page** — The visitor-facing view of enabled monitors, uptime, and incidents. It identifies monitors by public name but never reveals their target addresses.
- **Operator** — The single trusted person who configures monitors through local tooling.
- **Monitor** — A saved name and HTTP/HTTPS endpoint. A monitor can be enabled, disabled, or deleted.
- **Scheduled check** — A GET request initiated by the minute schedule. Only scheduled checks contribute to monitoring state and history.
- **Check result** — The success or failure observed for one monitor at one scheduled time.
- **Success** — A response with a status from 200 through 299.
- **Failure** — A timeout, network failure, or response status outside 200 through 299.
- **Monitoring status** — The confirmed condition of a monitor: `pending`, `up`, or `down`.
- **Pending** — No condition has yet been confirmed for the current enabled period.
- **Up** — The monitor is currently considered available.
- **Down** — The monitor is currently considered unavailable.
- **Transition** — A change of monitoring status caused by a scheduled check.
- **Incident** — A confirmed outage whose recorded period begins at its first consecutive failed check and ends on recovery, disablement, or deletion. A lone failure followed by success never becomes an incident.
- **Uptime** — Successful scheduled checks divided by all recorded scheduled checks in a time window. Missed schedule executions and disabled periods contribute no checks.
- **History bucket** — Aggregate check counts and successful-check latency samples for a UTC-aligned period.
- **Enabled** — Eligible for scheduled checks and public display.
- **Disabled** — Retained but excluded from scheduled checks and public display. Re-enabling starts status confirmation from `pending`.
- **Deleted** — Soft-deleted and unavailable to normal product views. Historical incidents and history remain intact.
