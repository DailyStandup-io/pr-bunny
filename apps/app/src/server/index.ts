import type { BunRequest, Server } from "bun";
import index from "../web/index.html";
import { approve, ask, askPr, buildSubmission, decide, editComment, startRereview, stats, status, submit } from "./actions";
import { DOMAIN, HOST, PORT, publicUrl } from "./config";
import { CODENAME, VERSION } from "../build-info";
import { cleanupWorktrees } from "./cleanup";
import { detectAgents } from "./agents";
import { getSettings, MODEL_OPTIONS, PROVIDERS, resetSettings, updateSettings } from "./settings";
import { cancelDeepReview, continueDeepReview, isReviewRunning, rerunSelfReview, startDeepReview } from "./deep";
import { selfSources } from "./local";
import { checkoutFor, completeSetup, pickFolder, resolveRepo, setupChecks, setupLinkCli, setupRepos, setupState } from "./onboarding";
import { checkForUpdate, installUpdate, restartForUpdate, scheduleUpdateChecks, updateState } from "./update";
import { previewSkill, repoSkills, searchFiles } from "./skills";
import { findSelfReview, openPrFor, startSelfReview, suggestReviewers, type StartSelf } from "./self";
import { getInbox, repoPrs, searchPrs } from "./inbox";
import { ACTIVITY, attachServer, getBacklog, topic } from "./live";
import { activeRuns, continueRecon, getReview, getRow, lastStoppedRun, listReviews, markRead, recoverInterrupted, retryRecon, startReview } from "./reviews";

recoverInterrupted();
scheduleUpdateChecks();

// Remove posted/abandoned PR checkouts now and hourly (see cleanup.ts for the rules).
const runCleanup = () => cleanupWorktrees({ isRunning: isReviewRunning }).catch((e) => console.warn("cleanup failed:", e));
runCleanup();
setInterval(runCleanup, 60 * 60 * 1000);

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (e: unknown, status = 400) => json({ error: e instanceof Error ? e.message : String(e) }, status);

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, DOMAIN]);

/**
 * Blocks other websites from driving this server: a foreign Host header means DNS rebinding,
 * a foreign Origin means a cross-site request. This matters because it can post to GitHub.
 */
function rejectForeign(req: Request): Response | null {
  if (!ALLOWED_HOSTS.has(req.headers.get("host") ?? "")) return fail("Forbidden host", 403);
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ""))) return fail("Forbidden origin", 403);
  return null;
}

/** Host/origin guard + uniform error handling. */
const api =
  <R extends Request>(h: (req: R) => unknown) =>
  async (req: R) => {
    const blocked = rejectForeign(req);
    if (blocked) return blocked;
    try {
      const out = await h(req);
      return out instanceof Response ? out : json(out ?? { ok: true });
    } catch (e) {
      return fail(e);
    }
  };

const body = async <T>(req: Request): Promise<T> => (await req.json().catch(() => ({}))) as T;
const reviewOr404 = async (id: number) => (await getReview(id)) ?? Promise.reject(new Error("Not found"));

type R<P extends string> = BunRequest<P>;

const server = Bun.serve<{ reviewId: number }>({
  hostname: HOST,
  port: PORT,
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },

  routes: {
    "/": index,
    "/review": index,
    "/review/*": index,
    "/history": index,
    "/analytics": index,
    "/settings": index,
    "/setup": index,

    // For `bunny`: is the server up, which version, and where to open the UI.
    "/api/health": { GET: api(() => ({ ok: true, version: VERSION, name: CODENAME, url: publicUrl() })) },

    // ---------- updates (installing and restarting only from clicks in Settings) ----------
    "/api/update": { GET: api(() => updateState()) },
    "/api/update/check": { POST: api(() => checkForUpdate()) },
    "/api/update/install": { POST: api(() => installUpdate()) },
    "/api/update/restart": { POST: api(() => restartForUpdate()) },

    "/api/inbox": { GET: api(() => getInbox()) },

    "/api/repos/:owner/:name/prs": {
      GET: api((req: R<"/api/repos/:owner/:name/prs">) => repoPrs(`${req.params.owner}/${req.params.name}`)),
    },

    "/api/search": {
      GET: api((req) => searchPrs(new URL(req.url).searchParams.get("q") ?? "")),
    },

    "/api/stats": { GET: api(() => stats()) },

    "/api/active": { GET: api(() => activeRuns()) },

    // Claude Code and Codex as found on this machine: installed, version, signed in.
    "/api/agents": { GET: api(() => detectAgents()) },

    // ---------- one-time setup ----------
    // Saved config (null until setup is finished) and the current settings to prefill it.
    "/api/setup": {
      GET: api(() => setupState()),
      // "Finish setup": the only write. Links `bunny` if asked, saves settings, repos and review skills.
      POST: api(async (req) => completeSetup(await body(req))),
    },
    // Agents, gh and the `bunny` link as they are right now ("Check again").
    "/api/setup/checks": { GET: api(() => setupChecks()) },
    // Repos added before plus checkouts found in the usual code folders.
    "/api/setup/repos": { GET: api(() => setupRepos()) },
    // "Create link" / "Replace" on the terminal step.
    "/api/setup/cli": {
      POST: api(async (req) => setupLinkCli(Boolean((await body<{ replace?: boolean }>(req)).replace))),
    },
    // The folder button: macOS's folder picker. Returns { path } (null if cancelled).
    "/api/setup/pick-folder": { POST: api(async () => ({ path: await pickFolder() })) },
    // "Add a local folder": validates it's a checkout with a GitHub origin. Saves nothing.
    "/api/setup/repos/resolve": {
      POST: api(async (req) => resolveRepo((await body<{ path?: string }>(req)).path)),
    },
    // Review skill candidates on a checkout's default branch.
    "/api/setup/skills": {
      GET: api(async (req) => {
        const { repo, root } = await checkoutFor(new URL(req.url).searchParams.get("path"));
        return repoSkills(repo, root);
      }),
    },
    // "Choose another file…": files on the default branch matching ?q.
    "/api/setup/skills/files": {
      GET: api(async (req) => {
        const q = new URL(req.url).searchParams;
        return searchFiles((await checkoutFor(q.get("path"))).root, q.get("q") ?? "");
      }),
    },
    "/api/setup/skills/preview": {
      GET: api(async (req) => {
        const q = new URL(req.url).searchParams;
        return previewSkill((await checkoutFor(q.get("path"))).root, q.get("file") ?? "");
      }),
    },

    // ---------- self-review ----------
    "/api/self/sources": {
      GET: api((req) => {
        const repo = new URL(req.url).searchParams.get("repo") ?? "";
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Expected ?repo=owner/name");
        return selfSources(repo);
      }),
    },
    "/api/self-reviews": {
      POST: api(async (req) => json(await startSelfReview(await body<StartSelf>(req)), 201)),
    },
    // `bunny review --rerun`: find this checkout's self-review and re-run it.
    "/api/self-reviews/rerun": {
      POST: api(async (req) => {
        const { localPath, branch } = await body<{ localPath?: string; branch?: string }>(req);
        if (!localPath) throw new Error("Missing `localPath`");
        const id = await findSelfReview(localPath, branch);
        rerunSelfReview(id);
        return { id };
      }),
    },
    "/api/reviews/:id/rerun": {
      POST: api(async (req: R<"/api/reviews/:id/rerun">) => {
        rerunSelfReview(Number(req.params.id));
        return reviewOr404(Number(req.params.id));
      }),
    },
    "/api/reviews/:id/reviewers": {
      GET: api((req: R<"/api/reviews/:id/reviewers">) => suggestReviewers(Number(req.params.id))),
    },
    // GitHub write: only from the "Open PR" click on Ready check.
    "/api/reviews/:id/open-pr": {
      POST: api(async (req: R<"/api/reviews/:id/open-pr">) => {
        const { reviewers } = await body<{ reviewers?: string[] }>(req);
        return openPrFor(Number(req.params.id), Array.isArray(reviewers) ? reviewers : []);
      }),
    },

    "/api/settings": {
      GET: api(() => ({ settings: getSettings(), modelOptions: MODEL_OPTIONS, providers: PROVIDERS })),
      POST: api(async (req) => ({ settings: updateSettings(await body(req)), modelOptions: MODEL_OPTIONS, providers: PROVIDERS })),
    },
    "/api/settings/reset": {
      POST: api(() => ({ settings: resetSettings(), modelOptions: MODEL_OPTIONS, providers: PROVIDERS })),
    },

    "/api/reviews": {
      GET: api(() => listReviews()),
      POST: api(async (req) => {
        // `repo` is the repo selected in the inbox; bare numbers resolve against it.
        const { pr, repo } = await body<{ pr?: string; repo?: string }>(req);
        if (!pr) throw new Error("Missing `pr`");
        return json({ id: await startReview(pr, repo) }, 201);
      }),
    },

    "/api/reviews/:id": {
      GET: api((req: R<"/api/reviews/:id">) => reviewOr404(Number(req.params.id))),
    },

    // "I've read it" → mark read and start the deep review.
    "/api/reviews/:id/read": {
      POST: api(async (req: R<"/api/reviews/:id/read">) => {
        const id = Number(req.params.id);
        const row = getRow(id);
        if (!row) throw new Error("Not found");
        markRead(id);
        if (row.phase === "recon_ready" || row.phase === "read") startDeepReview(id);
        return reviewOr404(id);
      }),
    },

    "/api/reviews/:id/retry": {
      POST: api(async (req: R<"/api/reviews/:id/retry">) => {
        const id = Number(req.params.id);
        const row = getRow(id);
        if (!row) throw new Error("Not found");
        if (!row.recon_json) await retryRecon(id);
        else startDeepReview(id);
        return reviewOr404(id);
      }),
    },

    // A step that ran out of turns: resume its Claude session with `turns` more, optionally
    // saving `setDefault` as the stage's new turn limit.
    "/api/reviews/:id/continue": {
      POST: api(async (req: R<"/api/reviews/:id/continue">) => {
        const id = Number(req.params.id);
        const { turns, setDefault } = await body<{ turns?: number; setDefault?: number }>(req);
        const row = getRow(id);
        if (!row) throw new Error("Not found");
        const stop = row.phase === "failed" ? lastStoppedRun(id) : null;
        if (!stop) throw new Error("This review didn't stop at a turn limit, so there's nothing to continue.");
        const n = Number(turns);
        if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("Turns must be a whole number between 1 and 1000");
        if (setDefault != null) updateSettings(stop.kind === "recon" ? { reconMaxTurns: setDefault } : { reviewMaxTurns: setDefault });
        if (stop.kind === "recon") await continueRecon(id, stop.sessionId, n);
        else continueDeepReview(id, stop.sessionId, n);
        return reviewOr404(id);
      }),
    },

    "/api/reviews/:id/ask": {
      POST: api(async (req: R<"/api/reviews/:id/ask">) => {
        const { question } = await body<{ question: string }>(req);
        await askPr(Number(req.params.id), question ?? "");
        return { ok: true };
      }),
    },

    "/api/reviews/:id/cancel": {
      POST: api((req: R<"/api/reviews/:id/cancel">) => cancelDeepReview(Number(req.params.id))),
    },

    "/api/reviews/:id/rereview": {
      POST: api(async (req: R<"/api/reviews/:id/rereview">) => ({ id: await startRereview(Number(req.params.id)) })),
    },

    "/api/reviews/:id/submission": {
      GET: api((req: R<"/api/reviews/:id/submission">) => buildSubmission(Number(req.params.id))),
      POST: api(async (req: R<"/api/reviews/:id/submission">) => {
        const input = await body<{ event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; body: string }>(req);
        return submit(Number(req.params.id), { event: input.event, body: input.body ?? "" });
      }),
    },

    "/api/reviews/:id/status": {
      GET: api((req: R<"/api/reviews/:id/status">) => status(Number(req.params.id))),
    },

    "/api/reviews/:id/approve": {
      POST: api(async (req: R<"/api/reviews/:id/approve">) => {
        const { body: text } = await body<{ body?: string }>(req);
        await approve(Number(req.params.id), text);
        return { ok: true };
      }),
    },

    "/api/findings/:id/decision": {
      POST: api(async (req: R<"/api/findings/:id/decision">) => {
        const { decision, reason } = await body<{ decision: "accepted" | "dismissed" | null; reason?: string }>(req);
        if (decision !== null && decision !== "accepted" && decision !== "dismissed") throw new Error("Invalid decision");
        decide(Number(req.params.id), decision, reason);
        return { ok: true };
      }),
    },

    "/api/findings/:id/comment": {
      POST: api(async (req: R<"/api/findings/:id/comment">) => {
        const { comment } = await body<{ comment: string }>(req);
        editComment(Number(req.params.id), comment ?? "");
        return { ok: true };
      }),
    },

    "/api/findings/:id/ask": {
      POST: api(async (req: R<"/api/findings/:id/ask">) => {
        const { question } = await body<{ question: string }>(req);
        await ask(Number(req.params.id), question ?? "");
        return { ok: true };
      }),
    },

    // reviewId 0 = the activity feed (every review's events).
    "/ws/activity": (req: Request, srv: Server<{ reviewId: number }>) => {
      const blocked = rejectForeign(req);
      if (blocked) return blocked;
      if (srv.upgrade(req, { data: { reviewId: 0 } })) return undefined;
      return fail("Expected a websocket upgrade", 426);
    },

    "/ws/reviews/:id": (req: R<"/ws/reviews/:id">, srv: Server<{ reviewId: number }>) => {
      const blocked = rejectForeign(req);
      if (blocked) return blocked;
      if (srv.upgrade(req, { data: { reviewId: Number(req.params.id) } })) return undefined;
      return fail("Expected a websocket upgrade", 426);
    },
  },

  websocket: {
    open(ws) {
      if (ws.data.reviewId === 0) {
        ws.subscribe(ACTIVITY);
        return;
      }
      ws.subscribe(topic(ws.data.reviewId));
      for (const ev of getBacklog(ws.data.reviewId)) ws.send(JSON.stringify(ev));
    },
    message() {},
    close(ws) {
      ws.unsubscribe(ws.data.reviewId === 0 ? ACTIVITY : topic(ws.data.reviewId));
    },
  },

  fetch() {
    return fail("Not found", 404);
  },
});

attachServer(server);
console.log(`PR Bunny ${VERSION} → ${publicUrl()}${publicUrl() === server.url.origin ? "" : ` (listening on ${server.url.origin})`}`);
