# PR Bunny — plan

A local web app (Bun) for reviewing GitHub PRs with Claude Code. It uses the Claude
subscription through headless `claude -p`, not the API.

## Decisions

| Area | Decision |
|---|---|
| Claude | Spawn `claude -p --output-format stream-json --verbose`. Structured output via `--json-schema`, follow-up questions via `--resume <session_id>`. The server **strips `ANTHROPIC_API_KEY`** from the child's environment so billing stays on the subscription. The Agent SDK is not used because the docs require an API key for it. |
| Tool access | `--permission-mode dontAsk` + `--setting-sources ""` (a PR's `.claude/settings.json` hooks never load) + `Read(//<worktree>/**)` and read-only git/gh Bash rules. Verified: reads outside the checkout are denied. All GitHub writes (posting, approving) go through the server's own `gh` calls, and only when the user clicks. |
| Scope | Any GitHub repo. Repo-specific review criteria come from that repo's own skill, never from this tool. |
| Criteria | The app owns the flow, JSON schemas and posting. The repo's review skill supplies the lenses (what to look for): the file picked in setup (`repos.skill_path`: NULL = auto, '' = none), else the best match on the default branch (`SKILL_LOCATIONS` in skills.ts: `.claude/skills/pr-bunny|review-pr|code-review|review/SKILL.md`, review commands, AGENTS.md/CLAUDE.md review sections, copilot instructions, CONTRIBUTING/REVIEWING, docs/code-review.md). If there's none, a generic prompt is used. The skill's own output/posting instructions are ignored. |
| Checkout | App-managed `git worktree add --detach <headSha>` under `<data>/worktrees/<repo>/<pr>` (data = `~/.pr-bunny`, or an existing `~/.review-pr` / `~/.review-desk` on pre-rename installs), removed after posting or 72h idle (cleanup.ts, hourly), recreated on demand for Q&A. Never touches the user's working copy. |
| Stacks | Found by following base-branch chains: parent PRs are those whose `headRefName` equals this PR's `baseRefName`; child PRs are those whose `baseRefName` equals this PR's `headRefName`. |
| Stack | `Bun.serve` fullstack (HTML imports), React, Tailwind, `bun:sqlite`, and a WebSocket for streaming. Binds to `127.0.0.1` only. |
| Data | SQLite at `<data>/pr-bunny.db` (or an existing `review-pr.db` / `review-desk.db`). |
| Settings | In-app Settings page (`settings` table): model + effort per step, dismissal memory, stack depth, turn limit, checkout TTL. Env vars are only defaults. |
| Tracking | Untracked (personal tooling). |

## Flow

1. **Inbox.** PRs waiting on my review (`gh search prs --review-requested=@me --state=open`), plus every open PR in the repo picked in the rail's repo switcher (repos I've reviewed in or been asked to review in). Search or paste a URL/number; bare numbers resolve in the selected repo.
2. **Recon** (fast model, no checkout). Uses `gh pr view --json …` plus `gh pr diff` and the diff stats. Output (schema):
   `summary`, `intent`, `areas[] {path, label, additions, deletions, note}`, `riskFlags[]`,
   `estReviewMinutes`, `stack {parents[], children[]}`. The estimate is a line/file heuristic
   that Claude adjusts. The UI shows an overview card, area bars, a stack diagram and a file
   list, then an **"I've read it"** button.
3. **Deep review** (Opus, worktree checkout, stack PRs as context, skill lenses, and any
   *dismissal memory* for the repo). The UI shows tool-use progress as it streams. Output:
   `findings[] {severity, lens, title, path, line, startLine?, side, why, fix, comment, confidence}`, `verdict`.
   The server checks every anchor against the diff hunks; findings that can't be anchored go
   in the review's main comment.
4. **Walkthrough.** One finding at a time, ordered by severity then confidence.
   ✓ accept (comment is editable) · ? ask (chat that resumes the review session; it can revise
   the finding) · ✗ dismiss (optional reason). Keys: `a` `q` `d` `j` `k`.
5. **Submit.** Preview first, then post a single `POST repos/{o}/{r}/pulls/{n}/reviews` with
   the inline comments plus the main comment. Event is COMMENT, APPROVE or REQUEST_CHANGES,
   chosen by me.
6. **Status panel.** `gh pr checks`, review decision, whether it can merge, and an Approve button.
7. **History.** Reviews, findings, decisions, Q&A, what was posted, and estimated cost and
   duration per run. Stats: acceptance rate by severity and lens.

## v1 extras

- **Learn from dismissals.** A repo's past dismissal reasons (grouped by lens) go into the
  review prompt as known false positives.
- **Re-review on new commits.** If the head commit changed, review `git diff lastSha..newSha`
  only, carry over earlier decisions, and mark findings whose code changed as "possibly addressed".
- **Review inbox** as the home screen.
- **Cost/time per run.** Store `total_cost_usd` (an estimate at list prices, not a charge),
  `duration_ms` and token usage for each Claude run.

## Layout

```
src/server/
  index.ts        Bun.serve routes + ws
  claude.ts       spawn, stream-json parser, session registry, env scrub
  gh.ts           typed gh wrappers
  git.ts          worktrees (per-repo clone cache under <data>/repos)
  stack.ts        base-chain discovery
  anchors.ts      diff-hunk parsing / anchor validation
  db/             schema.sql, migrate.ts, queries.ts
  prompts/        recon.md, review.md, qa.md, schemas/*.json
src/web/
  index.html, app.tsx, routes: Inbox, Recon, Review, Walkthrough, Submit, History
```

## Schema (sketch)

- `repos(id, owner, name, local_path, skill_path)`
- `reviews(id, repo_id, pr_number, title, author, head_sha, base_ref, phase, recon_json, verdict, review_session_id, started_at, read_at, submitted_at, gh_review_id)`
- `stack_links(review_id, pr_number, relation, title, head_ref, base_ref)`
- `findings(id, review_id, severity, lens, title, path, line, start_line, side, why, fix, comment, confidence, anchorable, decision, dismiss_reason, carried_from_id)`
- `finding_messages(id, finding_id, role, content, created_at)`
- `claude_runs(id, review_id, kind, session_id, model, cost_usd, duration_ms, input_tokens, output_tokens, status, log_path)`
- `reviews.cleared_at` (removed from the lists; Undo clears it), `inbox_hidden(key, mode, stamp, title, meta, hidden_at)`, `housekeeping(key, value)`

## Milestones

1. ✅ Scaffold: Bun server, React shell, SQLite migrations, `gh` wrapper, PR input, **recon screen**.
2. ✅ Worktrees, deep-review run with streaming progress, findings saved, anchor validation.
3. ✅ Walkthrough and Q&A (`--resume`).
4. ✅ Submit and post, status panel, approve.
5. ✅ Stacks, history and stats, dismissal memory, re-review on new commits, inbox.

## Self-review

Check your own branch or PR before anyone else sees it.

- **Sources:** a branch in your own checkout (found under ~/Developer, ~/code… or remembered from `bunny review`), optionally with uncommitted and untracked files, or one of your open PRs.
- **Snapshot:** the branch is fetched from your checkout into the app's clone (`git fetch <path>`), uncommitted work is applied as a patch and committed there as one snapshot commit. Your checkout is only read.
- **Flow:** Overview (plus "What reviewers will ask") → Findings (Fix / Won't fix, a coding-agent prompt per finding) → Ready check (combined prompt, checklist, re-run, suggested reviewers, Open PR).
- **Re-run:** in place. Snapshot again, Claude marks each open finding addressed or still present (with a note), and reports only new problems. Won't-fix decisions carry over.
- **Suggested reviewers:** CODEOWNERS for the touched paths, then recent committers to the most-changed files (via `gh api`).
- **Open PR:** `gh pr create --fill` with the chosen reviewers, only for a pushed branch whose GitHub tip matches your checkout; adds reviewers if a PR already exists. Findings are never posted.
- **CLI:** `bunny review [branch] [--base b] [--committed] [--pr n] [--rerun] [--no-open]` posts to the local server and opens the review.

## Agents

Reviews can run on Claude Code or Codex (Settings → Agent). `agents.ts` routes every run to the
chosen agent; session ids are prefixed per agent so one is never resumed with the other, and Codex
(which can't fork a session) starts finding Q&A fresh. `codex.ts` maps our schemas to OpenAI's
strict structured-output form (every property required, optional ones nullable) and reads the
`exec --json` event stream (`thread.started`, `item.*`, `turn.completed` / `turn.failed`).

## Stacks

- **Detection:** the tree of open PRs linked by base branches, from the root (based on the repo's base branch) up. Badges on inbox/search entries.
- **Model:** `stacks` + `stack_layers` (one row per PR, linked to that PR's latest review) + `stack_findings` (cross-layer). Cross findings are posted as ordinary findings on the PRs in their placements; per-layer findings they absorb are marked `superseded_by`.
- **Review all:** a background runner; base or top first, 1–3 at a time, skips "I've read it", resumes after a restart, pausable. Your own PRs route to self-review.
- **Across the stack:** after every layer is reviewed, one agent run over all layers (their findings, their diffs, the top layer's checkout), returning relies / repeated / fixed / breaks findings.
- **Changes:** layer head vs. its review's head; GitHub's compare API explains it. Re-review = delta re-review (peer) or in-place re-run (self); the cross pass resets and runs again.
- **Submit:** one review per PR with a suggested event; heads-up (soft) findings never force Request changes; optional summary comment on the top PR.

## Stop and tidy up

- **Stop:** every overview and deep review run claims an AbortController (`runs.ts`); Stop (`tidy.ts` `stopReview`, `POST /api/reviews/:id/cancel`) aborts it, which SIGTERMs the spawned `claude`/`codex` and SIGKILLs it after 5 s (`killOnAbort`). The run then settles as phase `cancelled` (a self-review re-run goes back to `walkthrough`); Force stop settles it at once. Under 30 s there's no confirm.
- **Resume / Start again:** a stopped overview kept nothing, so both rerun it. A stopped deep review keeps the overview; Resume continues its agent session (`--resume`), Start again runs it from scratch.
- **Stacks:** a stopped layer is `stopped`: Review all doesn't restart it and the across pass runs without it. Stop Review all stops running layers and the across pass (`cross_state = 'stopped'`, so it won't start on its own), optionally removing the layers' unposted reviews.
- **Remove:** `reviews.cleared_at` hides a review from the lists, stopping it first if it's running; Undo clears it. Settings › Housekeeping can clear posted and stopped reviews after N days (failed ones too, unless kept).
- **Inbox hiding:** `inbox_hidden`, "until it changes" (back when the row's timestamp passes `stamp`) or "for good". Local only; GitHub isn't told.

## Mock data and demo

A fictional world for tests and for filming: the `quokka-labs` org (`checkout`, `api`, `mobile`), ten invented people, the signed-in viewer `robin-vale`, and ~23 hand-written PRs (review requested, assigned, your own, drafts, a 4-layer stack, a 2-layer stack, new commits since your review, merged, closed), each with a real diff and scripted overview / deep-review / re-review / across-the-stack output. Nothing is random.

- **`src/mock/world/`** the content; **`fixtures.ts`** derives file states, diffs (`diff.ts`), finding line numbers (anchors are written as "the line containing …") and the JSON `gh` prints; **`git.ts`** builds real bare origins (with `refs/pull/N/head`) and your checkouts from it.
- **`src/mock/bin/{gh,claude,codex}`**: executable Bun fakes the app runs unchanged. `gh` answers every command shape the app uses from the fixtures and only *logs* writes (`<mock>/gh-writes.jsonl`); anything else exits 1 with `mock gh: unsupported: …`. `claude`/`codex` pick the step from the JSON schema and the PR from the prompt, stream real `stream-json` / `exec --json` events, honour `--max-turns`/`--resume`, and exit on SIGTERM. Pace: `PR_BUNNY_MOCK_SPEED` (1 realistic, 5 fast, 0 instant).
- **Tests:** `factories.ts` (`makeReview`, `makeFindings`, `makeStack`, `seedInbox`, `seedNotifications`, `seedOnboarding`…) write through the app's db module; `ghStub.ts` is `fixtureGh()` for `mock.module("./gh")`. `fixtures.test.ts` checks the world, the fakes and the seed against the app's real schemas.
- **`bun run demo`** (`scripts/demo.ts`): a throwaway folder with its own `HOME`, `PR_BUNNY_HOME`, `GH_CONFIG_DIR` and `CODEX_HOME`, the fakes first on `PATH`, tokens and API keys stripped, update checks off, server from source on **4478**. `--fresh` (first launch → /setup, checkouts and review skills to find), lived-in by default (`scenario.ts`: every phase, a stack mid Review all, cross findings, hidden items, a busy bell, Analytics history), `--dir`/`--reset`, `--port`, `--speed`, `--agent codex`. With `PR_BUNNY_DEMO=1` the server refuses to start unless `gh`, `claude` and `codex` resolve into `src/mock/bin` (`src/server/demo.ts`), and every avatar comes from `/api/avatar/:login` (generated SVG initials, `src/web/avatar.ts`) instead of github.com.
