# @pr-bunny/web

The prbunny.dev landing page (Next.js 16, run with Bun). From the repo root:

```bash
bun run dev:web     # http://localhost:4478
bun run build:web
```

- `/install` serves `apps/app/scripts/install.sh`, read at build time (`/install.sh` rewrites to it).
- `/releases/*` proxies to `RELEASES_ORIGIN` when that's set (where release binaries are uploaded),
  so the installer and the app's updater only talk to prbunny.dev.
- Bunny art comes from `@pr-bunny/brand`. It's licensed and not in the repo: without it the page
  builds with no bunny images. `app/icon.png`, `apple-icon.png` and `favicon.ico` are written from
  it by the brand generator (gitignored). Set `PR_BUNNY_REQUIRE_ART=1` on the production deploy so
  a build without the art fails.
