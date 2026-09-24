# PR Bunny

Local PR review app that drives the user's own coding agent (headless `claude -p` or `codex exec`). Bun workspace monorepo: `apps/app` (the app, CLI, installer, release build), `apps/web` (prbunny.dev landing, Next.js 16 on Bun; read its `AGENTS.md` before touching Next code), `packages/brand` (bunny art, favicons, DailyStandup mark). Bun only: `bun install` at the root, no npm/pnpm/yarn. See [apps/app/PLAN.md](apps/app/PLAN.md) for decisions, flow, schema and milestones. Paths below are relative to `apps/app` unless they say otherwise.

Invariants:
- Never use the Anthropic API / Agent SDK. Always strip `ANTHROPIC_API_KEY` from the env of spawned `claude` processes (subscription billing).
- The agent is pluggable (`src/server/agents.ts`): Claude Code (`claude -p`) or Codex (`codex exec`, `src/server/codex.ts`). Same rules for Codex: ChatGPT sign-in only (strip `OPENAI_API_KEY`/`CODEX_API_KEY`), `-s read-only` sandbox, the checkout's `AGENTS.md` ignored (`project_doc_max_bytes=0`), no MCP servers. The Codex runner is written from Codex's documented `exec --json` interface and hasn't been run against a real Codex install yet.
- The agent runs with read-only tools only. All GitHub writes (post review, approve) are done by the server via `gh`, and only from an explicit user click.
- Server binds to 127.0.0.1 and rejects foreign Host/Origin headers. Default address is http://127.0.0.1:4477; Caddy (`Caddyfile`, embedded in the binary and written to the data folder) optionally fronts it at https://prbunny.localhost (`service.json` in the data folder, set by `bunny setup --https`). launchd agents (`dev.prbunny.app`, `dev.prbunny.caddy`) come from `src/cli/service.ts`.
- Distribution: one command, `bunny` (`src/cli/main.ts`; `bin/bunny.ts` from source). `scripts/build.ts` compiles it (server + UI + migrations + brand art) per target into `dist/`, with `latest` and `latest.json`; `scripts/install.sh` is the `curl -fsSL https://prbunny.dev/install | sh` installer (served by `apps/web/app/install/route.ts`) and must match the build (`bun scripts/build.ts --check`). Installed builds live at `~/.pr-bunny/bin/bunny`. `COMPILED`/`VERSION`/`CODENAME` (`src/build-info.ts`) come from `package.json` `version`/`codename` at build time. Use the `release` skill to cut releases. The source stays private; only `dist/` is published (to https://prbunny.dev/releases).
- Updates (`src/server/update.ts`): release files are GitHub Releases on `DailyStandup-io/pr-bunny` (tag `v<version>`, `GITHUB_REPO` in `src/build-info.ts`); prbunny.dev/releases/* redirects there (`apps/web/next.config.ts`). The updater checks `RELEASE_SOURCES` (`src/server/config.ts`) in order: prbunny.dev, then GitHub. Background checks of `latest.json`; download, sha256 check, "does it run" check, atomic swap and `launchctl kickstart` only from clicks in Settings › About. Keep the release layout, `install.sh` and the updater in step.
- The dev server (`bun run dev`, 4477) and the launchd service use the same port — stop one before starting the other. `bunny setup` (`src/cli/setup.ts`, `bun run setup` from source) is the idempotent installer (`--check` = dry run); keep it and README in sync when setup steps change.
- Self-review never writes to the user's checkout: branches are copied with `git fetch <path>` into the app's own clone, uncommitted work is applied there as a snapshot commit. The only GitHub write it adds is "Open PR" (`gh pr create` / add reviewers), from an explicit click. It never pushes.
- One-time setup (`/setup`, `src/web/pages/Setup.tsx`, `src/server/onboarding.ts`) only reads, except "Create link" (links `~/.local/bin/bunny`, `src/server/cli.ts`) and "Finish setup", which saves settings, repos (`repos.added_at`, `skill_path`: NULL = auto, '' = none), the `onboarding` row and `config.json`. First launch redirects to it. Review instructions are ranked by `SKILL_LOCATIONS` (`src/server/skills.ts`) and read from the default branch only.
- Stacks (`src/server/stacks.ts`, `src/web/pages/Stack.tsx`): a stack is the tree of open PRs linked by base branches (`stackTree`). Each layer is an ordinary review (`stack_layers.review_id` follows the PR's latest review); Review all is a 3s runner (`startStackRunner`) that starts layers up to `stackConcurrency`, moves scans straight to deep review, then runs the "across the stack" pass (`prompts/stack.ts`) once. Cross findings live in `stack_findings` and are posted as ordinary findings (`findings.stack_finding_id`) on the PRs they're placed on; per-layer findings they cover get `superseded_by` and are hidden everywhere. `postStack` is the only stack GitHub write, from the confirmed Post click.
- UI branding: rose accent (hue 12), the bunny mascot (`src/web/components/Bunny.tsx`; pages report moods with `useBunnyMood`), faces from `@pr-bunny/brand`. The repo is public (MIT) but the bunny art is licensed (Envato Elements) and **never committed**: it lives in gitignored `packages/brand/private/` (fetched from the private repo `DailyStandup-io/pr-bunny-art` by `bun run art:fetch`, or automatically when `PR_BUNNY_ART_TOKEN` is set, e.g. on Vercel), and `packages/brand/scripts/generate.ts` inlines it into gitignored `generated/art.ts` (or exports nulls without it). Every bunny image must render nothing when its face is null. Release builds (`scripts/build.ts`, and the site with `PR_BUNNY_REQUIRE_ART=1`) require the art. Never add bunny-derived files (favicons, screenshots, OG images) anywhere tracked.
- Icons: `@pr-bunny/icons` (`<Icon name=… />`). The repo depends only on the free Hugeicons (MIT). Hugeicons Pro is optional and local (`bun run icons:pro` installs into gitignored `packages/icons/pro/`); the generated `packages/icons/generated/icons.ts` picks Pro when present. Never add Pro packages to a package.json or lockfile, and never commit Pro SVGs. Root `scripts/generate.ts` runs both generators (brand art and icons).
- Renamed from review.pr (and review-desk before that): existing installs keep `~/.review-pr` / `~/.review-desk` and their db files; env vars are `PR_BUNNY_*` with `REVIEW_PR_*` and `REVIEW_DESK_*` as fallbacks; old launchd labels `pr.review.*` / `com.review-desk.*` and old `rp`/`rb`/`rbot` links are removed on install.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Git attribution

Never author commits or PRs as an AI agent. Use the configured human Git author/committer only; never add Claude, Codex, Anthropic, OpenAI or any other assistant as author or co-author, and never append `Co-Authored-By`, "Generated with" or similar trailers to commits or PR bodies. Attribution is also turned off in `.claude/settings.json`.
