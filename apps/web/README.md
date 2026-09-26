# @pr-bunny/web

The prbunny.dev landing page (Next.js 16). Bun installs and runs the scripts. `next dev` runs on Bun's
runtime, but `next build` runs on Node, because Bun 1.3.14 crashes at the end of `next build` on
Vercel's Linux builders. From the repo root:

```bash
bun run dev:web     # http://localhost:4478
bun run build:web
```

- `/install` serves `apps/app/scripts/install.sh`, read at build time (`/install.sh` rewrites to it).
- `/releases/*` (`app/releases/[...path]/route.ts`) redirects to GitHub Releases, or to
  `RELEASES_ORIGIN` when that's set, so the installer and the app's updater only talk to prbunny.dev.
  On the way it counts, anonymously (`lib/counts.ts`, only counters, no IPs or IDs): installs by
  version and Mac (`<version>/bunny-<os-arch>?arch=`, install.sh's download), update checks by running
  version (`latest.json?v=`) and updates (`<version>/bunny-<os-arch>?from=`). Counts are recorded after the redirect is sent, with a short timeout,
  so storage being down never breaks a download.
- `/stats` shows the counts. It needs `STATS_TOKEN`, as `Authorization: Bearer …` or, in a browser,
  by signing in at `/stats/login` (a POSTed form that sets an HttpOnly cookie holding a hash of the
  token, so it never appears in a URL). It's a 404 otherwise, `noindex` and disallowed in `robots.txt`. `bun run stats` (here or at the root)
  prints the same numbers, reading `UPSTASH_REDIS_REST_*` from the environment or `.env.local`
  (`vercel env pull .env.local`).
- Bunny art comes from `@pr-bunny/brand`. It's licensed and not in the repo: without it the page
  builds with no bunny images.

  **Vercel project settings:**
  - Root Directory: `apps/web`. Install and build use Bun, with the lockfile at the repo root.
  - Environment variables:
    - `PR_BUNNY_ART_TOKEN`: a fine-grained token with read-only Contents access to
      `DailyStandup-io/pr-bunny-art`. The art is fetched before the build.
    - `PR_BUNNY_REQUIRE_ART=1`: no art, no deploy.
    - `HUGEICONS_TOKEN` (optional): the Pro icons for the theme toggle.
    - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`: the counts' store (Upstash Redis from the
      Vercel Marketplace, free tier; its `KV_REST_API_URL` / `KV_REST_API_TOKEN` also work). Without
      them the redirects work and nothing is counted.
    - `STATS_TOKEN`: the secret for `/stats`. Unset, `/stats` is always a 404.
    - `VERCEL_ANALYTICS_EVENTS=1` (optional): also send each count to Vercel Web Analytics as a
      custom event (`Install`, `Update check`, `Update`). Custom events need the Pro plan; leave it
      unset on Hobby.
    - `RELEASES_ORIGIN` (optional): serve release files from another host laid out like `dist/`.

  `app/icon.png`, `apple-icon.png` and `favicon.ico` are written from the art by the brand generator
  (gitignored). Set `PR_BUNNY_REQUIRE_ART=1` on the production deploy so a build without the art
  fails.
