# PR Bunny

A local app for reviewing GitHub PRs with the coding agent you're already signed in to: **Claude
Code** (`claude -p`, on your Claude subscription) or **Codex** (`codex exec`, on your ChatGPT plan).
It scans a PR and gives you a visual overview (what it is, where it touches, estimated review time,
where it sits in a stack), then runs an in-depth review and walks you through each finding before
posting anything. It can also **self-review** your own branch before you open a PR. No API keys, no
per-token billing, and nothing reaches GitHub until you press Post.

Formerly review.pr (and review-desk before that). See [apps/app/PLAN.md](apps/app/PLAN.md) for the design.

## Repository

A Bun workspace (`bun install` at the root; no npm, pnpm or yarn):

| Path | What |
|---|---|
| [`apps/app`](apps/app) | The app: Bun server + React UI, the `bunny` CLI, setup, the login service, the updater, and the release build (`scripts/build.ts`, `scripts/install.sh`) |
| [`apps/web`](apps/web) | [prbunny.dev](https://prbunny.dev): the Next.js landing page. It also serves `/install` and proxies `/releases/*` |
| [`packages/brand`](packages/brand) | The bunny art, shared by both. The faces and favicons are licensed and **not in the repo** (see below) |
| [`packages/icons`](packages/icons) | The Hugeicons the UI uses: the free set by default; `bun run icons:pro` swaps in Hugeicons Pro locally |

```bash
bun install
bun run dev          # the app, http://127.0.0.1:4477 with hot reload
bun run dev:web      # the landing page, http://localhost:4478
bun run test         # app tests
bun run typecheck    # both apps
bun run build        # release binaries into apps/app/dist (see the release skill)
bun run build:web    # the landing page
bun run icons:pro    # optional: Hugeicons Pro instead of free (needs HUGEICONS_TOKEN)
```

**The bunny art isn't open source.** The faces are licensed from Envato Elements for PR Bunny only,
so they're gitignored (`packages/brand/private/`). Without them everything still builds and runs;
the bunny images are just left out. Release builds need them. See
[packages/brand/README.md](packages/brand/README.md). The code is [MIT](LICENSE); the name, the bunny
and the DailyStandup.io mark aren't covered by it (see [NOTICE](NOTICE)).

## Install

Requirements: macOS, `gh`, and a coding agent signed in on your subscription:
[Claude Code](https://claude.com/claude-code) (`claude`, then `/login`) or Codex (`codex login`).

```bash
curl -fsSL https://prbunny.dev/install | sh
```

That downloads the `bunny` binary (the whole app in one file) to `~/.pr-bunny/bin/bunny`, checks
its sha256, and runs `bunny setup`. From source instead: `bun install && bun run setup` (same steps).

`bunny setup` is interactive and safe to re-run. Each step checks first and only acts if something
is missing, asking before it installs anything or uses `sudo`:

| Step | What it does |
|---|---|
| Prerequisites | Checks for git, `gh` (offers `brew install gh` and `gh auth login`), and `claude` or `codex` |
| Address | PR Bunny runs at **http://127.0.0.1:4477**. Optionally it also serves **https://prbunny.localhost** through Caddy: say yes, or pass `--https` |
| HTTPS (optional) | Installs Caddy, adds `127.0.0.1 prbunny.localhost` to `/etc/hosts` (sudo), and stops Homebrew's own Caddy service if it's on |
| Login service | A launchd agent that starts the app at login and restarts it if it crashes (`dev.prbunny.app`), plus Caddy (`dev.prbunny.caddy`) if HTTPS is on. Removes older `pr.review.*` / `com.review-desk.*` agents |
| Terminal command | Offers to link `~/.local/bin/bunny` to the app, so `bunny review` works from any checkout |
| Certificate (optional) | With HTTPS: trusts Caddy's local certificate authority in the System keychain (sudo) |
| Health check | Confirms the app answers, then opens it |

The rest happens in the browser. The first launch opens **setup** (`/setup`):
1. Pick your agent.
2. Connect `gh`.
3. Link the `bunny` command.
4. Choose repositories: the checkouts found in `~/Developer` etc., or any folder you add.
5. Pick each repo's review instructions, with a preview.

Finish saves it all (also written to `~/.pr-bunny/config.json`). Settings › About › **Run setup
again** reopens it.

Options: `bunny setup --check` reports what's done and changes nothing; `--yes` skips the
questions (sudo still asks for your password); `--https` / `--no-https` turn the HTTPS address on or
off. Use another hostname with `PR_BUNNY_DOMAIN=review.local bunny setup --https`. Environment
variables are `PR_BUNNY_*`; the older `REVIEW_PR_*` and `REVIEW_DESK_*` names still work.

## Updates

Releases are [GitHub Releases](https://github.com/DailyStandup-io/pr-bunny/releases) (tag
`v<version>`), and `prbunny.dev/releases/*` redirects to them. PR Bunny checks
`https://prbunny.dev/releases/latest.json` a little after it starts, then every six hours. If the site
can't be reached, it checks GitHub directly (`PR_BUNNY_UPDATE_URL` points it elsewhere; `off`
disables it). When a newer version is out,
the bunny says so, and Settings › About offers **Update to x.y.z**:
1. It downloads the build for your Mac and verifies its sha256.
2. It checks the new binary runs, then swaps it in place.
3. **Restart now** restarts the login service onto the new version. Reviews in progress pick up
   where they left off.

Running from source, it tells you to pull instead.

## Using it

1. **Pick a PR.** The Inbox ("On you") lists reviews requested of you, reviews you left open, and
   your own work to check. **Review** has a search box: paste a URL, `owner/repo#123`, or a number
   (it resolves in the repo picked in the rail), plus live cards for everything in progress.
2. **Overview:** what the PR is, why, where it touches, estimated review time, risk flags and the stack.
   Read it, then click **I've read it** (⌘↵).
3. **Deep review:** Claude (Opus) checks out the PR and reviews it read-only, using the repo's
   review skill as criteria (chosen in setup, or found automatically), context from neighbouring stacked PRs, and your past dismissals.
4. **Walkthrough:** findings one at a time, most severe first. **A** accept (the comment is editable),
   **Q** ask Claude (it keeps the full review context), **D** dismiss (with a reason, which future
   reviews learn from), **U** undo, **J/K** next/previous.
5. **Submit:** preview exactly what will be posted: inline comments on diff lines, plus a summary
   that also collects accepted findings that can't sit on a diff line. Choose Comment, Approve or
   Request changes, then confirm.
6. **Status:** checks, review decision, mergeability, an **Approve** button, and **Re-review changes**
   when new commits land. A re-review only looks at the delta and reports which earlier findings
   were addressed.
7. **Analytics:** accept rates by severity and lens, recent dismissals, and the full review history.
8. **Settings:** the model and effort for each step (overview, deep review, questions), whether past
   dismissals feed into reviews, how much stack context to load, the review turn limit, when
   checkouts are cleaned up, and the theme (System / Light / Dark). Saved in the local database;
   environment variables only set the defaults. **About** shows the version and codename, checks
   for updates, and reopens setup.

The bunny at the bottom of the rail follows along: it works while a review runs, cries at open
self-review findings, cheers an approval, and tells you when an update is out. Click it to go
where it's pointing. (↑↑↓↓←→←→BA does something too.)

## Agents

| | Claude Code | Codex |
|---|---|---|
| Sign in | `claude`, then `/login` | `brew install codex`, then `codex login` (ChatGPT) |
| Runs as | `claude -p`, read-only tools scoped to the checkout | `codex exec --json -s read-only` in the checkout |
| Models | Opus / Sonnet / Haiku, or any model id | Codex default, GPT-5 Codex, GPT-5, GPT-5 mini, or any model id |

Switching agent resets the model and effort choices to that agent's defaults. Codex ignores the
checkout's `AGENTS.md` (a PR could otherwise steer the reviewer) and runs without MCP servers.
Turn limits only apply to Claude Code. **Codex support is new and hasn't been run against a real
Codex install yet**; if a Codex release changes `exec`'s flags or JSON events, fix
`apps/app/src/server/codex.ts`.

## Self-review

Check your own work before anyone else sees it: from **Review → Your branches**, or in a terminal:

```bash
bunny review                 # the checked-out branch, including uncommitted changes
bunny review my-branch       # another branch of this checkout
bunny review --base develop  # compare against another branch
bunny review --committed     # leave uncommitted files out
bunny review --pr 1490       # one of your open PRs
bunny review --rerun         # after fixing, check again
```

Findings are yours only: mark each **Fix** or **Won't fix**, copy the prompt for your coding agent
(or one combined prompt on **Ready check**), fix, then **Re-run**. Each finding is marked resolved
or still open. When it's clean, **Open PR** runs `gh pr create` with the suggested reviewers
(CODEOWNERS and recent committers). PR Bunny never pushes, and never touches your checkout: it
copies your branch into its own clone.

## Stacks

A stack is a chain of PRs, each based on the one below. PR Bunny spots them by following base
branches through the repo's open PRs, and badges stacked PRs in the inbox and search ("2 of 5").
Open one with **Review stack**, **Review whole stack** on a PR's Overview, or `bunny review --stack`
inside a checkout.

- **Layers:** every PR in the stack, top first, with its state and findings. **Review all** scans and
  deep-reviews each layer against its own parent (base first by default, up to 3 at a time), without
  waiting on "I've read it". Your own PRs are self-reviewed; everyone else's are peer reviews.
- **Across the stack:** once every layer is reviewed, the agent reads them together for problems a
  single-PR review can't see: code one PR adds and another relies on, a problem a later PR fixes, the
  same issue repeated in several layers (merged into one finding), and layers that clash.
- **Findings:** one queue for the whole stack, grouped by PR, with J/K moving across PRs. A finding
  fixed later in the stack can be posted as a heads-up instead of a request for changes.
- **Submit:** one GitHub review per PR, with a suggested Comment / Approve / Request changes for each,
  an optional summary comment on the top PR, and a ready check for your own layers (never posted).
- **When it changes:** new commits or rebases are spotted, and **Re-review** only re-runs those layers.
  Merged layers drop out.

Settings › Review › Stacks sets the order, how many at once, the largest stack Review all is offered
for, and whether to include PRs that are already approved or merged.

## Day to day

```bash
bunny open                  # open PR Bunny in the browser
bunny service status        # is the app (and Caddy, with HTTPS) running?
bunny service restart       # after pulling changes (from source)
bunny service uninstall     # remove the login agents
```

Data lives in `~/.pr-bunny` (set `PR_BUNNY_HOME` to move it); installs from before the rename keep
their existing `~/.review-pr` or `~/.review-desk`. PR checkouts live in its `worktrees/` folder.
Each one is removed right after you post, or after 72 hours with no activity (change it in
Settings). Folders nothing points at are removed too. Cleanup runs at startup and then every hour.
If you come back to an old review and ask a question, its checkout is recreated automatically.

Logs: `logs/app.log` (and `caddy.log`) in the data folder. Each agent run's full event stream is
saved alongside them as `review-<id>-<kind>-<run>.jsonl`. Database: `pr-bunny.db` (SQLite).

## Develop

The dev server and the login service both use port 4477. Stop the service's app first
(`launchctl bootout gui/$(id -u)/dev.prbunny.app`), then run `bun run --cwd apps/app service:install`
again when you're done. Bun's dev mode refuses HTML requests addressed to other hostnames, so
`https://prbunny.localhost` only works with the service.

Releases: `bun run build` compiles `bunny` for each target into `apps/app/dist/` and smoke-tests
it, including an update check. `bun apps/app/scripts/build.ts --check` verifies `install.sh`
matches the build. Use the `release` skill (`.claude/skills/release`) to cut one.

## Security model

- The server listens on `127.0.0.1` only and rejects requests whose `Host` or `Origin` isn't
  `127.0.0.1:4477`, `localhost:4477` or the configured domain. That stops other websites and
  DNS-rebinding tricks from driving it.
- Claude runs read-only inside the PR's checkout: `--permission-mode dontAsk` with path-scoped `Read`
  rules and read-only `git`/`gh` commands, no MCP servers, and **no settings files**
  (`--setting-sources ""`). That last one matters because a PR could add `.claude/settings.json`
  hooks, which would otherwise run on your machine when Claude starts in the checkout.
- The review criteria come from the repo's review instructions (picked per repo in setup; otherwise
  the best match in the order shown there: `.claude/skills/pr-bunny/SKILL.md`, `review-pr`,
  `code-review`, … an `AGENTS.md` review section, `CONTRIBUTING.md`), read from the **default
  branch**, so a PR can't rewrite the rules it's reviewed against.
- Anything written to GitHub (posting a review, approving, opening a PR from a self-review) goes
  through the server's own `gh` calls, only from a button click. Posting and approving also need a
  second confirmation click. Self-review findings are never posted.
- Self-review only reads your checkout. It never pushes, and never commits, stages or checks out
  anything there.
- `ANTHROPIC_API_KEY` and similar variables are removed before Claude starts, so runs always use
  your subscription.
- Updates are only installed from a click in Settings › About. The download is checked against its
  published sha256 and has to run (`bunny version` must print the new version) before it replaces
  the old binary.

## Troubleshooting

- **"Blocked: Host header does not match the dev server"**: a `bun run dev` server is holding
  port 4477 (so Caddy, with HTTPS on, is forwarding to it). Stop it; the service's app takes over within about 10 seconds.
- **Certificate warning**: run `bunny setup` again, or `sudo caddy trust --address localhost:2020`
  while Caddy is running.
- **`caddy trust` says it can't reach localhost:2019**: this repo's Caddyfile moves Caddy's control
  port to 2020. Pass `--address localhost:2020`.
- **Recon fails straight away**: check that `gh auth status` and `claude` work in a normal terminal.

---

Built by [DailyStandup.io](https://dailystandup.io) · [GitHub](https://github.com/DailyStandup-io/pr-bunny)
