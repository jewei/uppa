# 06 — Complete the cached public status experience

**What to build:** Visitors get a polished, accessible, auto-refreshing status page with one lazily loaded selected-monitor chart and short-lived edge caching.

**Blocked by:** 04 — Track and display incidents.

**Status:** ready-for-agent

- [ ] Overall status, monitor state/uptime/latency, empty/loading/error states, and incidents are responsive and accessible.
- [ ] One selected monitor supports 24h/7d/30d SVG history without a UI/chart dependency.
- [ ] Status refreshes every minute; history fetches only on selection/range changes.
- [ ] Canonical successful API responses use required Cache API TTLs; errors/unknown parameters are not cached.
- [ ] Static/API security headers are present and built assets contain no private URL/secret.
- [ ] UI/API tests and `bun run check` pass.
