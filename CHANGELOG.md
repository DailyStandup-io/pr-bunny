# Changelog

## 0.3.0 “Endive” — 2026-09-26

### Added
- **Notifications.** Get a desktop alert when a PR needs you or a review finishes. Pick them in
  setup's new Notifications step or in Settings › Notifications:
  - GitHub: review requested, assigned to you, a PR in one of your stacks updated, your PR reviewed.
  - Reviews: overview ready, deep review finished, failed or out of turns, PR changed since you
    reviewed it.
  - Stacks: Review all finished, the across-the-stack pass ready. And new PR Bunny versions.
  - Choose which repos, set quiet hours, stay quiet while PR Bunny is in front, and bundle bursts
    ("3 reviews finished"). Clicking an alert opens the review, stack or inbox.
  - An Activity bell in the sidebar keeps the recent events, so nothing is missed with alerts off.
  - Alerts show while a PR Bunny tab is open (it can be in the background).
- **Stop, resume and start again.** Stop a running overview, deep review or stack layer from the
  review page, the In progress cards or the stack. "Stop Review all" can keep finished layers or
  throw them away. A stopped review keeps its overview and can resume where the agent left off.
- **Tidy the inbox.** Hide PRs until they change or for good (one at a time or several at once),
  with Undo. Remove reviews from the lists, "Clear all finished", and restore anything hidden from
  the Hidden tab or Settings › Housekeeping, which can also clear finished reviews automatically.
  Keyboard: J/K to move, X to select, E to hide, ⌫ to remove, Z to undo.

### Fixed
- A PR only ever has one review running. Starting a review, a re-review and a stack's Review all at
  the same moment no longer creates two. A PR whose stack is running Review all shows "Reviewing in
  stack" and links to the stack.
- Stopping a review now ends the agent process too.

## 0.2.0 “Dandelion” — 2026-09-24

### Added
- **Stack review.** Review a whole stack of PRs together: open it from a stacked PR's Overview, the
  inbox and search ("Review stack · 2 of 5"), Review home, or `bunny review --stack`.
  - **Review all** scans and deep-reviews every layer against its own parent, base first (or top
    first), up to 3 at a time. Pause and resume any time.
  - **Across the stack:** once every layer is reviewed, it looks for what only shows up when they're
    read together: one PR relying on another, problems fixed later in the stack, the same issue in
    several layers (merged into one), and layers that clash.
  - One findings queue for the whole stack, and one GitHub review per PR, with suggested outcomes
    and an optional summary comment on the top PR. Your own layers are self-reviewed and never
    posted.
  - Spots new commits and rebases, and re-reviews just the layers that changed.
- Settings › Review › Stacks: review order, PRs at once, the Review all limit, and whether to include
  approved or merged PRs.

### Fixed
- Finishing setup and pressing "Open Inbox" no longer bounces back to setup the first time.
- The review page's tab spinner animates again.
- GitHub links go to the pr-bunny repo.

## 0.1.2 “Clover” — 2026-09-24

### Changed
- Opening one of your own PRs (pasting its URL, or from the inbox or search) now starts a
  self-review instead of reviewing it as someone else's: findings stay private, with the Fix /
  Won't fix and re-run flow.
- The Analytics icon and the theme toggle use the same light outline style as the rest of the rail.

## 0.1.1 “Basil” — 2026-09-24

### Changed
- `bunny setup` looks much better: spinners with elapsed time and live output for anything slow,
  colours, clearer prompts, and sudo asks for your password on its own line.
- The installer (`curl -fsSL https://prbunny.dev/install | sh`) is tidier too, and says so plainly
  when it has to download from GitHub instead of prbunny.dev.

### Fixed
- Installing Caddy (or gh) during setup could appear frozen for minutes while Homebrew updated
  itself. Setup now installs without that update step.
- The installer falls back to GitHub when prbunny.dev can't be reached even with a pinned
  version (`PR_BUNNY_VERSION=…`).

## 0.1.0 “Alfalfa” — 2026-09-24

The first release of PR Bunny.

### Added
- Review GitHub PRs with the coding agent you're already signed in to: Claude Code or Codex. No
  API keys, and nothing is posted to GitHub until you press Post.
- Overview of each PR (what it is, where it touches, review time, stack), then a deep review you
  walk through finding by finding: accept, edit, ask, or dismiss.
- Self-review your own branch before opening a PR: `bunny review`, including uncommitted changes.
  Re-run after fixing, then open the PR with suggested reviewers.
- Per-repo review instructions: `.claude/skills/*/SKILL.md`, an `AGENTS.md` review section,
  `CONTRIBUTING.md` and more, always read from the default branch.
- Guided setup, in the terminal (`bunny setup`) and in the browser on first launch.
- Runs as a login service at http://127.0.0.1:4477, with optional https://prbunny.localhost.
- Automatic update checks, with one-click update and restart from Settings › About.

Install: `curl -fsSL https://prbunny.dev/install | sh` (macOS; needs `gh`).
