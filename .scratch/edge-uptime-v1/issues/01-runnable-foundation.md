# 01 — Serve an empty public status page

**What to build:** A Bun-managed Cloudflare Worker project that migrates a fresh local D1 database and serves an accessible empty status page plus an explicit empty public status DTO through native routing.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Bun lockfile, strict TypeScript, Vite/Workers configuration, and required quality scripts exist without npm/pnpm/Yarn artifacts.
- [ ] Initial migration creates and seeds the complete v1 schema from empty local D1.
- [ ] Native Worker routing returns a stable empty `/api/status` response and JSON API 404s.
- [ ] Static SPA fallback, production security headers, and a restrained empty/loading/error page work locally.
- [ ] Worker integration test, frontend build, migration smoke test, and `bun run check` pass.
