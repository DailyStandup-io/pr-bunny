# Changelog

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
