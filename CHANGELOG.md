# Changelog

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
