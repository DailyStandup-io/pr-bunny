# @pr-bunny/brand

PR Bunny's art, shared by the app (`apps/app`) and the website (`apps/web`).

| What | Where | In git? |
|---|---|---|
| Bunny faces `bunny-1…10.png` (31×31 pixel art at 4×) and favicons (`favicon.ico`, `icon-32.png`, `apple-touch-icon.png`) | `private/` | **No.** Licensed from Envato Elements for PR Bunny only |
| DailyStandup.io mark | `dailystandup.svg` | Yes (not covered by the MIT license) |
| Theme icons | `icons/` | Yes |

`scripts/generate.ts` runs on `bun install` and before every dev, typecheck and build. It writes
`generated/art.ts`:
- **When `private/` has the art:** the images are inlined as data URIs, and the website's icon files
  are written to `apps/web/app/`.
- **When it doesn't:** everything is `null` and the bunny images are left out. Forks and
  contributors can build and run everything without the art.

Release builds need the art: `apps/app/scripts/build.ts` runs the generator with `--require`, and so
does the website build when `PR_BUNNY_REQUIRE_ART=1` is set (set that on the prbunny.dev deployment).

**Getting the art:** it lives in the private repo
[`DailyStandup-io/pr-bunny-art`](https://github.com/DailyStandup-io/pr-bunny-art):
- **Locally:** `bun run art:fetch`. It uses `PR_BUNNY_ART_TOKEN`, or else your `gh` login.
- **Vercel and CI:** set `PR_BUNNY_ART_TOKEN` to a fine-grained token with read-only *Contents*
  access to that one repo. If the art is missing, it's fetched automatically before every build.
  Also set `PR_BUNNY_REQUIRE_ART=1` so a failed fetch fails the build instead of shipping without
  the bunny.

To change the art, commit to the art repo, then delete `private/` and fetch again. To make the files
from the Envato originals (8334 px PNGs of a 31×31 grid), use ImageMagick:

```sh
magick "Cute Pixel Rabbit Expression Character (N).png" -filter point -resize 31x31! -filter point -resize 400% PNG32:private/bunny-N.png
```

Make the favicons from face 1: a 32×32 with 1 px of padding, and a 180×180 at 4× on `#f7f6f3`.
