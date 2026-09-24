# @pr-bunny/web

The prbunny.dev landing page (Next.js 16). Bun installs and runs the scripts. `next dev` runs on Bun's
runtime, but `next build` runs on Node, because Bun 1.3.14 crashes at the end of `next build` on
Vercel's Linux builders. From the repo root:

```bash
bun run dev:web     # http://localhost:4478
bun run build:web
```

- `/install` serves `apps/app/scripts/install.sh`, read at build time (`/install.sh` rewrites to it).
- `/releases/*` proxies to `RELEASES_ORIGIN` when that's set (where release binaries are uploaded),
  so the installer and the app's updater only talk to prbunny.dev.
- Bunny art comes from `@pr-bunny/brand`. It's licensed and not in the repo: without it the page
  builds with no bunny images.

  **Vercel project settings:**
  - Root Directory: `apps/web`. Install and build use Bun, with the lockfile at the repo root.
  - Environment variables:
    - `PR_BUNNY_ART_TOKEN`: a fine-grained token with read-only Contents access to
      `DailyStandup-io/pr-bunny-art`. The art is fetched before the build.
    - `PR_BUNNY_REQUIRE_ART=1`: no art, no deploy.
    - `HUGEICONS_TOKEN` (optional): the Pro icons for the theme toggle. `app/icon.png`, `apple-icon.png` and `favicon.ico` are written from
  it by the brand generator (gitignored). Set `PR_BUNNY_REQUIRE_ART=1` on the production deploy so
  a build without the art fails.
