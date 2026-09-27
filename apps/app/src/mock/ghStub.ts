// The app's gh module (src/server/gh.ts) answered from the fixtures, in-process, for tests that
// `mock.module("./gh", …)`. Same data the fake `gh` binary serves, without git (pseudo SHAs unless
// real ones are passed).
import type { InboxPr, MyPr } from "../shared/types";
import type { OpenPr, PrRef, PrView, RawStatus } from "../server/gh";
import { findPr, headSha, minutesAgoIso, prChange, prsOf, PRS, prUrl, prViewJson, VIEWER, type FixturePr, type ShaMap } from "./fixtures";

const ref = (r: PrRef) => {
  const pr = findPr(`${r.owner}/${r.repo}`, r.number);
  if (!pr) throw new Error(`gh pr view ${r.number} failed: GraphQL: Could not resolve to a PullRequest with the number of ${r.number}.`);
  return pr;
};

export function prViewOf(pr: FixturePr, shas?: ShaMap): PrView {
  const v = prViewJson(pr, Date.now(), shas);
  return {
    number: v.number, title: v.title, body: v.body, url: v.url, author: v.author.login, isDraft: v.isDraft, state: v.state,
    headRefName: v.headRefName, headRefOid: v.headRefOid, baseRefName: v.baseRefName, additions: v.additions, deletions: v.deletions,
    changedFiles: v.changedFiles, labels: v.labels.map((l) => l.name), files: v.files,
  };
}

const inbox = (p: FixturePr, now = Date.now()): InboxPr => ({ repo: p.repo, number: p.number, title: p.title, author: p.author, url: prUrl(p), updatedAt: minutesAgoIso(p.updatedMinutesAgo, now), isDraft: Boolean(p.draft) });
const open = (repo?: string) => PRS.filter((p) => p.state === "OPEN" && (!repo || p.repo === repo));

/** Drop-in replacements for src/server/gh.ts's read functions. */
export function fixtureGh(shas?: ShaMap) {
  return {
    viewer: async () => VIEWER.login,
    prView: async (r: PrRef): Promise<PrView> => prViewOf(ref(r), shas),
    prDiff: async (r: PrRef): Promise<string> => prChange(ref(r)).diff,
    listOpenPrs: async (owner: string, repo: string): Promise<OpenPr[]> =>
      open(`${owner}/${repo}`).map((p) => ({ number: p.number, title: p.title, headRefName: p.branch, baseRefName: p.base, headRefOid: headSha(p, shas), author: p.author, isDraft: Boolean(p.draft), url: prUrl(p), ...(({ additions, deletions }) => ({ additions, deletions }))(prChange(p)) })),
    reviewInbox: async (): Promise<InboxPr[]> => open().filter((p) => p.requestedBy).map((p) => inbox(p)),
    assignedPrs: async (): Promise<InboxPr[]> => open().filter((p) => p.assigned).map((p) => inbox(p)),
    repoOpenPrs: async (repo: string): Promise<InboxPr[]> => open(repo).map((p) => inbox(p)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    myOpenPrs: async (repo: string): Promise<MyPr[]> =>
      open(repo).filter((p) => p.author === VIEWER.login).map((p) => ({ number: p.number, title: p.title, isDraft: Boolean(p.draft), headRefName: p.branch, updatedAt: inbox(p).updatedAt, url: prUrl(p) })),
    prStatus: async (r: PrRef): Promise<RawStatus> => {
      const v = prViewJson(ref(r), Date.now(), shas);
      return {
        state: v.state, isDraft: v.isDraft, headRefOid: v.headRefOid, reviewDecision: v.reviewDecision, mergeable: v.mergeable, mergeStateStatus: v.mergeStateStatus,
        checks: v.statusCheckRollup.map((c) => ({ name: c.name, state: c.status === "COMPLETED" ? c.conclusion : c.status, url: c.detailsUrl })),
        reviews: v.latestReviews.map((x) => ({ author: x.author.login, state: x.state, submittedAt: x.submittedAt })),
      };
    },
  };
}

export { prsOf };
