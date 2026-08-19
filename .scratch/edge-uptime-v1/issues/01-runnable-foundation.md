# 01 — Serve an empty public status page

**What to build:** A Bun-managed Cloudflare Worker project that migrates a fresh local D1 database and serves an accessible empty status page plus an explicit empty public status DTO through native routing.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] Bun lockfile, strict TypeScript, Vite/Workers configuration, and required quality scripts exist without npm/pnpm/Yarn artifacts.
- [x] Initial migration creates and seeds the complete v1 schema from empty local D1.
- [x] Native Worker routing returns a stable empty `/api/status` response and JSON API 404s.
- [x] Static SPA fallback, production security headers, and a restrained empty/loading/error page work locally.
- [x] Worker integration test, frontend build, migration smoke test, and `bun run check` pass.
