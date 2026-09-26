// The demo's "lived-in" scenario: a database that looks like a few weeks of real use, with reviews in
// every phase, stacks, hidden inbox items, notifications and enough history for Analytics. Built
// from the factories, so tests can seed it too (into a throwaway database).
import { join } from "node:path";
import { turnLimitMessage } from "../server/reviews";
import { decideCross, makeReview, makeStack, seedHidden, seedNotifications, seedOnboarding, seedSession, type Ctx } from "./factories";
import { findPr, REPOS, repoName, STACKS, type FixturePr } from "./fixtures";

const pr = (repo: string, n: number): FixturePr => {
  const p = findPr(`quokka-labs/${repo}`, n);
  if (!p) throw new Error(`No fixture PR ${repo}#${n}`);
  return p;
};

export interface LivedIn {
  reviews: Record<string, number>;
  stacks: Record<string, number>;
  /** Started by the demo once the server is up (they're live runs, not seeded rows). */
  live: { scan: FixturePr; deep: { pr: FixturePr; reviewId: number } };
  /** What's staged where, for the demo's cheat-sheet. */
  notes: string[];
}

export function seedLivedIn(ctx: Ctx & { home: string }): LivedIn {
  const checkouts = REPOS.map((r) => ({ repo: repoName(r), path: join(ctx.home, "Developer", r.owner, r.name) }));
  seedOnboarding(checkouts, ctx);
  const R: Record<string, number> = {};
  const S: Record<string, number> = {};

  // ---------- history (Analytics) ----------
  R.h1471 = makeReview({ pr: pr("checkout", 1471), phase: "submitted", startedMinutesAgo: 60 * 24 * 9 + 90, decisions: ["accepted", ["dismissed", "We bump Testing Library separately"]], posted: { event: "APPROVE", minutesAgo: 60 * 24 * 9 + 60 } }, ctx);
  R.h1466 = makeReview({ pr: pr("checkout", 1466), phase: "submitted", startedMinutesAgo: 60 * 24 * 14 + 40, decisions: ["accepted"], posted: { event: "COMMENT", minutesAgo: 60 * 24 * 14 + 20 } }, ctx);
  R.h226 = makeReview({ pr: pr("api", 226), phase: "submitted", startedMinutesAgo: 60 * 24 * 12 + 50, decisions: ["accepted", ["dismissed", "Covered by the logging integration tests"]], posted: { event: "REQUEST_CHANGES", minutesAgo: 60 * 24 * 12 + 30 } }, ctx);
  R.h229 = makeReview({ pr: pr("api", 229), phase: "submitted", startedMinutesAgo: 60 * 24 * 6 + 30, decisions: [["dismissed", "Expected: old sessions age out within 30 days"]], posted: { event: "APPROVE", minutesAgo: 60 * 24 * 6 + 20 } }, ctx);
  R.h84 = makeReview({ pr: pr("mobile", 84), phase: "submitted", startedMinutesAgo: 60 * 24 * 11 + 25, posted: { event: "APPROVE", minutesAgo: 60 * 24 * 11 + 15 } }, ctx);
  R.h85 = makeReview({ pr: pr("mobile", 85), phase: "cancelled", startedMinutesAgo: 60 * 24 * 16, runs: [{ kind: "recon", status: "success" }, { kind: "review", status: "error", error: "Stopped" }] }, ctx);

  // ---------- today ----------
  // Ready to read: the overview is done, "I've read it" starts the deep review.
  R.r1490 = makeReview({ pr: pr("checkout", 1490), phase: "recon_ready", startedMinutesAgo: 62 }, ctx);
  // Findings to decide, some already decided.
  R.r231 = makeReview(
    { pr: pr("api", 231), phase: "walkthrough", startedMinutesAgo: 60 * 5, decisions: ["accepted", "accepted", ["dismissed", "Redis limiter is tracked in API-77"]] },
    ctx,
  );
  // Posted with changes requested, then the author pushed a fix: "new commits since your review".
  R.r238 = makeReview(
    { pr: pr("api", 238), phase: "submitted", upTo: 1, startedMinutesAgo: 60 * 23, decisions: ["accepted", "accepted"], posted: { event: "REQUEST_CHANGES", minutesAgo: 60 * 22 } },
    ctx,
  );
  // Ran out of turns in the deep review: Continue resumes the agent session.
  const s91 = "seed-quokka-labs-mobile-91-turn-limit";
  R.r91 = makeReview(
    {
      pr: pr("mobile", 91),
      phase: "failed",
      startedMinutesAgo: 60 * 3,
      findings: false,
      error: turnLimitMessage("review", 40),
      sessionId: null,
      runs: [{ kind: "recon", status: "success" }, { kind: "review", status: "error", error: "error_max_turns", hitTurnLimit: true, maxTurns: 40, sessionId: s91 }],
    },
    ctx,
  );
  seedSession(s91, pr("mobile", 91), "review", 1, false);
  // Stopped during the deep review: Resume continues the session, Start again runs it afresh.
  const s1493 = "seed-quokka-labs-checkout-1493-stopped";
  R.r1493 = makeReview(
    { pr: pr("checkout", 1493), phase: "cancelled", startedMinutesAgo: 60 * 26, findings: false, sessionId: null, runs: [{ kind: "recon", status: "success" }, { kind: "review", status: "error", error: "Stopped", sessionId: s1493 }] },
    ctx,
  );
  seedSession(s1493, pr("checkout", 1493), "review", 2, false);
  // Your own PR: a self-review with agent prompts, one fixed and one won't-fix.
  R.r1495 = makeReview({ pr: pr("checkout", 1495), phase: "walkthrough", startedMinutesAgo: 60 * 2 + 20, decisions: ["accepted", null, "accepted", ["dismissed", "Follow-up PR adds the EUR cases"]] }, ctx);
  // Overview done; the demo clicks "I've read it" at launch so a deep review is running live.
  R.r236 = makeReview({ pr: pr("api", 236), phase: "recon_ready", startedMinutesAgo: 4 }, ctx);

  // ---------- stacks ----------
  // checkout-v2: the two lower layers reviewed, Review all running (the runner picks up #1484 at launch).
  R.s1482 = makeReview({ pr: pr("checkout", 1482), phase: "walkthrough", startedMinutesAgo: 70, decisions: ["accepted"] }, ctx);
  R.s1483 = makeReview({ pr: pr("checkout", 1483), phase: "walkthrough", startedMinutesAgo: 45 }, ctx);
  const checkoutStack = STACKS.find((s) => s.name === "checkout-v2")!;
  S["checkout-v2"] = makeStack({ stack: checkoutStack, reviews: { 1482: R.s1482, 1483: R.s1483 }, runState: "running", updatedMinutesAgo: 2 }, ctx);
  // refunds: both layers reviewed and the across-the-stack pass is done.
  R.s243 = makeReview({ pr: pr("api", 243), phase: "walkthrough", startedMinutesAgo: 60 * 25 }, ctx);
  R.s244 = makeReview({ pr: pr("api", 244), phase: "walkthrough", startedMinutesAgo: 60 * 25 - 20, decisions: ["accepted", "accepted"] }, ctx);
  const refunds = STACKS.find((s) => s.name === "refunds")!;
  S.refunds = makeStack({ stack: refunds, reviews: { 243: R.s243, 244: R.s244 }, cross: "done", updatedMinutesAgo: 60 * 24 }, ctx);
  decideCross(S.refunds, refunds.cross.findings[0]!.title, "accepted", { minutesAgo: 60 * 23 }, ctx);

  // ---------- inbox hiding ----------
  seedHidden(
    [
      { pr: pr("api", 237), mode: "good", minutesAgo: 60 * 30 },
      { pr: pr("checkout", 1497), mode: "change", minutesAgo: 60 * 6 },
    ],
    ctx,
  );

  // ---------- the bell ----------
  seedNotifications(
    [
      { kind: "req", title: `Review requested: ${pr("mobile", 88).title}`, body: "@sol-hartley · quokka-labs/mobile #88", summary: "@sol-hartley asked you to review", pr: pr("mobile", 88), href: "/", face: "wink", minutesAgo: 25 },
      { kind: "myReview", title: "Approved: #1495", body: `@lena-okoro left 1 comment on ${pr("checkout", 1495).title}.`, summary: "@lena-okoro approved", pr: pr("checkout", 1495), face: "hearts", minutesAgo: 50 },
      { kind: "changed", title: "Changed since your review · #238", body: `New commits on ${pr("api", 238).title}. quokka-labs/api`, summary: "New commits since your review", pr: pr("api", 238), reviewId: R.r238, face: "surprised", minutesAgo: 40, seen: true },
      { kind: "failed", title: "Review stopped · quokka-labs/mobile #91", body: "Ran out of turns at 40. Run it again or raise the limit.", summary: "Review ran out of turns", pr: pr("mobile", 91), reviewId: R.r91, face: "crying", minutesAgo: 60 * 3 - 5, seen: true },
      { kind: "deep", title: "Deep review ready · #231", body: "5 findings, 2 high. Rate-limit POST /v1/login per IP and per account.", summary: "Deep review finished · 5 findings", pr: pr("api", 231), reviewId: R.r231, face: "surprised", minutesAgo: 60 * 5 - 6, read: true },
      { kind: "req", title: `Review requested: ${pr("api", 231).title}`, body: "@dmitri-ashgrove · quokka-labs/api #231", summary: "@dmitri-ashgrove asked you to review", pr: pr("api", 231), href: "/", face: "wink", minutesAgo: 60 * 6, read: true },
      { kind: "across", title: `Across the stack · ${pr("api", 243).title}`, body: "2 findings span more than one PR.", summary: "Across-the-stack pass is ready", stackId: S.refunds, face: "surprised", minutesAgo: 60 * 24, read: true },
      { kind: "all", title: `Stack reviewed · ${pr("api", 243).title}`, body: "2 PRs, 5 findings. The across-the-stack pass runs next.", summary: `Review all finished on ${pr("api", 243).title}`, stackId: S.refunds, face: "wink", minutesAgo: 60 * 24 + 4, read: true },
      { kind: "assign", title: `Assigned to you: ${pr("checkout", 1493).title}`, body: "@lena-okoro · quokka-labs/checkout #1493", summary: "You were assigned a PR", pr: pr("checkout", 1493), href: "/", face: "wink", minutesAgo: 60 * 30, read: true },
    ],
    ctx,
  );

  return {
    reviews: R,
    stacks: S,
    live: { scan: pr("mobile", 88), deep: { pr: pr("api", 236), reviewId: R.r236 } },
    notes: [
      `PR #1490 (checkout) is ready to read: /review/${R.r1490}`,
      `PR #231 (api) has findings to decide, incl. a critical: /review/${R.r231}`,
      `PR #238 (api) was posted with changes requested and has new commits since: /review/${R.r238}`,
      `PR #91 (mobile) ran out of turns; Continue resumes it: /review/${R.r91}`,
      `PR #1493 (checkout, draft) was stopped mid deep review; Resume or Start again: /review/${R.r1493}`,
      `PR #1495 (checkout) is your own PR, self-reviewed with agent prompts: /review/${R.r1495}`,
      `Stack "checkout-v2" (#1482→#1485) has Review all running: /stack/${S["checkout-v2"]}`,
      `Stack "refunds" (#243→#244) has across-the-stack findings to decide: /stack/${S.refunds}`,
      "Hidden in the inbox: api#237 (for good) and checkout#1497 (until it changes)",
      "Bell: 9 notifications, 4 unread (2 new since you last looked)",
    ],
  };
}
