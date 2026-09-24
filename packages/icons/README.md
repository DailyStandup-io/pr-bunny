# @pr-bunny/icons

The icons PR Bunny draws with, from [Hugeicons](https://hugeicons.com). Use `<Icon name="inbox" />`.

- **Free (default):** `@hugeicons/core-free-icons` (MIT), all Stroke Rounded. This is what the
  public repo installs and builds with.
- **Pro (optional, local):** `bun run icons:pro` installs `@hugeicons-pro/core-solid-rounded` into
  the gitignored `pro/` folder, which has its own `package.json` and `.npmrc`. The token is read
  from `HUGEICONS_TOKEN` and never written to a tracked file, and the root `package.json` and
  `bun.lock` don't change. The icons the design draws solid (analytics, moon, sun) then come from
  Pro; the rest are identical in both sets.

```bash
bun run icons:pro            # install Pro and switch to it
bun run icons:pro remove     # back to free
bun run icons:pro status
PR_BUNNY_ICONS=free bun run dev   # force the free set for one run
```

`scripts/generate.ts` writes the gitignored `generated/icons.ts` with the chosen set. It runs on
`bun install` and before every dev, typecheck and build (via the root `scripts/generate.ts`). To add
an icon, add it to `ICONS` there with its free name and, if the design draws it solid, its Pro name.
Never commit Pro icon files or SVGs copied from Pro.
