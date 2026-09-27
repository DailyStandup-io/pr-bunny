// quokka-labs/api: the backend (TypeScript). Login rate limiting with a critical finding, webhook
// retries (assigned to the viewer), a receipts PR with new commits since the viewer's review, a
// 2-layer refunds stack whose across-the-stack pass is done, and the viewer's own draft.
import type { FixtureBranch, FixturePr, FixtureRepo, FixtureStack } from "../types";
import { code, ORG } from "./people";

const L = (...lines: string[]) => lines.join("\n");
const REPO = `${ORG}/api`;

export const apiRepo: FixtureRepo = {
  owner: ORG,
  name: "api",
  description: "Quokka Labs public API: auth, orders, payments and webhooks.",
  defaultBranch: "main",
  committers: ["dmitri-ashgrove", "felix-oduya", "hana-lindqvist", "priya-castell", "robin-vale"],
  files: {
    "README.md": code`
      # api

      The Quokka Labs API. \`bun run dev\` starts it on :8080 against the local Postgres in docker-compose.

      Routes live in \`src/routes\`, one file per resource. Migrations are plain SQL in \`migrations/\`.
    `,
    "CLAUDE.md": code`
      # api

      TypeScript on Bun, Postgres via \`src/lib/db.ts\`. Run \`bun test\` before pushing.

      ## Code review

      - **Auth and ownership first.** Every route that takes an id must check the resource belongs to
        \`ctx.session.userId\` (or the caller has the \`support\` role). Missing checks are critical.
      - **Never log secrets or personal data** (passwords, tokens, full card numbers, addresses).
      - **Money is integer cents.** Refund and payment amounts must be validated server-side.
      - **Migrations must be safe to run on a live table:** add indexes \`CONCURRENTLY\`, no table rewrites.
      - We run 4 API instances behind the load balancer: in-memory state is per instance.

      ## Style

      Prettier and ESLint handle formatting. Don't comment on it.
    `,
    "package.json": code`
      {
        "name": "@quokka/api",
        "private": true,
        "type": "module",
        "scripts": {
          "dev": "bun --watch src/server.ts",
          "test": "bun test",
          "lint": "eslint ."
        },
        "dependencies": {
          "postgres": "^3.4.5",
          "zod": "^3.23.8"
        },
        "devDependencies": {
          "eslint": "^9.12.0",
          "typescript": "^5.6.3"
        }
      }
    `,
    "src/lib/http.ts": code`
      export interface Session {
        userId: string;
        roles: string[];
      }

      export interface Context {
        session: Session;
        remoteAddress: string;
        param(name: string): string;
        header(name: string): string | undefined;
        json<T>(): Promise<T>;
        status(code: number): Context;
        setHeader(name: string, value: string): Context;
        setCookie(name: string, value: string, opts: Record<string, unknown>): void;
        json(body: unknown): Response;
        body(data: Uint8Array): Response;
      }
    `,
    "src/lib/log.ts": code`
      type Fields = Record<string, unknown>;

      function write(level: string, msg: string, fields: Fields = {}) {
        console.log(JSON.stringify({ level, msg, ...fields, at: new Date().toISOString() }));
      }

      export const log = {
        info: (msg: string, fields?: Fields) => write("info", msg, fields),
        warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
        error: (msg: string, fields?: Fields) => write("error", msg, fields),
      };
    `,
    "src/routes/auth.ts": code`
      import type { Context } from "../lib/http";
      import { db } from "../lib/db";
      import { log } from "../lib/log";
      import { verifyPassword } from "../lib/passwords";
      import { createSession } from "../sessions/store";

      export async function login(ctx: Context) {
        const { email, password } = await ctx.json<{ email: string; password: string }>();
        const user = await db.users.findByEmail(email.toLowerCase());
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
          log.info("login failed", { email });
          return ctx.status(401).json({ error: "invalid_credentials" });
        }
        const session = await createSession(user.id);
        ctx.setCookie("sid", session.id, { httpOnly: true, secure: true, sameSite: "lax" });
        return ctx.json({ userId: user.id });
      }
    `,
    "src/routes/orders.ts": code`
      import type { Context } from "../lib/http";
      import { db } from "../lib/db";

      export async function getOrder(ctx: Context) {
        const order = await db.orders.findById(ctx.param("id"));
        if (!order || order.userId !== ctx.session.userId) return ctx.status(404).json({ error: "not_found" });
        return ctx.json(order);
      }

      export async function listOrders(ctx: Context) {
        const orders = await db.orders.findByUser(ctx.session.userId);
        return ctx.json({ orders });
      }
    `,
    "src/webhooks/deliver.ts": code`
      import { db } from "../lib/db";
      import { log } from "../lib/log";

      export interface Delivery {
        id: string;
        url: string;
        payload: unknown;
        attempts: number;
        nextAttemptAt: number;
      }

      export async function deliver(delivery: Delivery): Promise<boolean> {
        const res = await fetch(delivery.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(delivery.payload),
        });
        await db.deliveries.update(delivery.id, { attempts: delivery.attempts + 1, lastStatus: res.status });
        if (!res.ok) log.warn("webhook delivery failed", { id: delivery.id, status: res.status });
        return res.ok;
      }
    `,
    "src/sessions/store.ts": code`
      import { randomUUID } from "node:crypto";

      const sessions = new Map<string, { userId: string; expiresAt: number }>();
      const TTL_MS = 30 * 24 * 60 * 60 * 1000;

      export async function createSession(userId: string) {
        const id = randomUUID();
        sessions.set(id, { userId, expiresAt: Date.now() + TTL_MS });
        return { id };
      }

      export async function readSession(id: string) {
        const s = sessions.get(id);
        return s && s.expiresAt > Date.now() ? s : null;
      }
    `,
    "migrations/0011_deliveries.sql": code`
      CREATE TABLE deliveries (
        id              TEXT PRIMARY KEY,
        url             TEXT NOT NULL,
        payload         JSONB NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 0,
        last_status     INTEGER,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
};

// ---------- review requested: login rate limiting ----------

const pr231: FixturePr = {
  repo: REPO,
  number: 231,
  title: "Rate-limit POST /v1/login per IP and per account",
  body: code`
    We had a credential-stuffing burst on Tuesday (INC-42). This adds a simple limiter:

    - 10 attempts per 15 minutes per IP
    - 10 attempts per 15 minutes per account
    - \`429\` with \`Retry-After\` when either is exceeded

    Also logs a bit more on failed logins so we can see what's being tried.
  `,
  author: "dmitri-ashgrove",
  branch: "dmitri/login-rate-limit",
  base: "main",
  state: "OPEN",
  labels: ["security"],
  requestedBy: "dmitri-ashgrove",
  requestedMinutesAgo: 60 * 6,
  updatedMinutesAgo: 60 * 5,
  github: { checks: [["test", "SUCCESS"], ["lint", "SUCCESS"]], decision: "REVIEW_REQUIRED" },
  commits: [
    {
      message: "Add an in-memory limiter for login attempts",
      edits: [
        {
          path: "src/lib/rateLimit.ts",
          add: code`
            import type { Context } from "./http";

            const WINDOW_MS = 15 * 60 * 1000;
            const MAX_ATTEMPTS = 10;
            const attempts = new Map<string, { count: number; resetAt: number }>();

            export function clientIp(ctx: Context): string {
              return ctx.header("x-forwarded-for")?.split(",")[0]?.trim() ?? ctx.remoteAddress;
            }

            export function hit(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
              const entry = attempts.get(key);
              if (!entry || entry.resetAt < now) {
                attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
                return { allowed: true, retryAfterSec: 0 };
              }
              entry.count++;
              return { allowed: entry.count <= MAX_ATTEMPTS, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
            }
          `,
        },
      ],
    },
    {
      message: "Limit /v1/login per IP and account; log failed attempts",
      edits: [
        {
          path: "src/routes/auth.ts",
          replace: [
            ['import { log } from "../lib/log";', 'import { log } from "../lib/log";\nimport { clientIp, hit } from "../lib/rateLimit";'],
            [
              "  const { email, password } = await ctx.json<{ email: string; password: string }>();\n",
              L(
                "  const { email, password } = await ctx.json<{ email: string; password: string }>();",
                '  const perIp = hit("ip:" + clientIp(ctx));',
                '  const perAccount = hit("acct:" + email);',
                "  if (!perIp.allowed || !perAccount.allowed) {",
                "    const wait = Math.max(perIp.retryAfterSec, perAccount.retryAfterSec);",
                '    return ctx.status(429).setHeader("retry-after", String(wait)).json({ error: "too_many_attempts" });',
                "  }",
                "",
              ),
            ],
            ['    log.info("login failed", { email });', '    log.info("login failed", { email, password, ip: clientIp(ctx) });'],
          ],
        },
        {
          path: "src/lib/rateLimit.test.ts",
          add: code`
            import { expect, test } from "bun:test";
            import { hit } from "./rateLimit";

            test("allows ten attempts per window", () => {
              for (let i = 0; i < 10; i++) expect(hit("k", 0).allowed).toBe(true);
              expect(hit("k", 0).allowed).toBe(false);
            });
          `,
        },
      ],
    },
  ],
  recon: {
    headline: "Adds per-IP and per-account rate limiting to POST /v1/login",
    summary:
      "New `src/lib/rateLimit.ts` keeps attempt counters in an in-memory `Map` (10 per 15 minutes) and the login route checks one bucket per client IP and one per account, answering `429` with `Retry-After`. Failed logins now log more fields.",
    intent: "Blunt credential stuffing like INC-42 on the login endpoint.",
    areas: {
      "src/lib": ["Rate limiter", "In-memory counters, client IP helper and a test"],
      "src/routes": ["Login route", "429 on too many attempts; more fields on failure logs"],
    },
    risks: [
      ["high", "Auth path, and failure logging now includes request fields"],
      ["high", "Client IP comes from a request header"],
      ["medium", "In-memory state with 4 API instances"],
    ],
    minutes: [24, 9],
    estReasoning: "Security-sensitive: small diff, slow careful read.",
    focus: ["What the failure log line now contains", "Where the client IP comes from", "How counters behave across instances"],
  },
  review: {
    trail: [
      { read: "src/routes/auth.ts" },
      { read: "src/lib/rateLimit.ts" },
      { say: "The failed-login log line now includes `password`. That's the submitted plaintext." },
      { grep: "log.info(", in: "src" },
      { read: "src/lib/log.ts" },
      { say: "log.ts writes to stdout, which ships to the log pipeline as-is." },
      { grep: "x-forwarded-for", in: "src" },
      { read: "CLAUDE.md" },
      { say: "CLAUDE.md: 4 instances behind the LB, so a per-process Map is 4 separate limiters." },
      { read: "src/lib/rateLimit.test.ts" },
    ],
    findings: [
      {
        severity: "critical",
        lens: "Security",
        title: "Failed logins log the plaintext password",
        at: { path: "src/routes/auth.ts", match: 'log.info("login failed", { email, password' },
        why: "`password` is the submitted plaintext from the request body. `log.info` writes JSON to stdout, which ships to the log pipeline, so every mistyped (or stuffed) password lands in logs that far more people can read than the users table. CLAUDE.md forbids logging secrets.",
        fix: "Drop `password` from the fields.",
        comment:
          "This logs the submitted password in plaintext on every failed login, which then ships to our log pipeline. Please drop it:\n\n```suggestion\n    log.info(\"login failed\", { email, ip: clientIp(ctx) });\n```",
        confidence: "high",
        qa: {
          answer:
            "Yes. `password` comes straight from `ctx.json()` on line 8, and `src/lib/log.ts:4` serialises every field with `JSON.stringify` to stdout. There's no redaction anywhere in the logger. It's the plaintext the user typed.",
          recommendation: "accept",
        },
      },
      {
        severity: "high",
        lens: "Security",
        title: "IP limit trusts X-Forwarded-For, so it's trivially bypassed",
        at: { path: "src/lib/rateLimit.ts", match: 'ctx.header("x-forwarded-for")' },
        why: "The first `X-Forwarded-For` entry is client-controlled: an attacker sends a random value per request and gets a fresh IP bucket every time. Only the last hop added by our load balancer can be trusted.",
        fix: "Use the right-most address added by the LB (or `ctx.remoteAddress` if the LB sets it), not the first entry.",
        comment: "The first `X-Forwarded-For` entry is whatever the client sends, so rotating it gives a new bucket per request. Could this use the address our LB appends (the last entry) instead?",
        confidence: "high",
      },
      {
        severity: "medium",
        lens: "Reliability",
        title: "Counters are per instance and never evicted",
        at: { path: "src/lib/rateLimit.ts", match: "const attempts = new Map" },
        why: "We run 4 API instances, so the effective limit is up to 40 attempts per window. Entries are only replaced when a key is hit again after its window, so a spray of unique IPs grows the map without bound.",
        fix: "Keep counters in Redis (INCR with EXPIRE), or at least sweep expired entries.",
        comment: "With 4 instances this is really 40 attempts per window, and the map never shrinks. Redis `INCR` + `EXPIRE` would fix both. Happy to take it as a follow-up if you'd rather ship this first.",
        confidence: "high",
      },
      {
        severity: "medium",
        lens: "Correctness",
        title: "Account bucket is case-sensitive",
        at: { path: "src/routes/auth.ts", match: 'hit("acct:" + email)' },
        why: "The user lookup lowercases the email but the bucket key doesn't, so `Alice@x.com` and `alice@x.com` get separate limits for the same account.",
        fix: "Use `email.toLowerCase()` for the key.",
        comment: "The lookup lowercases the email, but this key doesn't, so changing the case gets a fresh bucket for the same account.",
        confidence: "high",
      },
      {
        severity: "low",
        lens: "Tests",
        title: "No test for the 429 response",
        at: { path: "src/lib/rateLimit.test.ts", match: 'test("allows ten attempts per window"' },
        why: "The test covers the counter but not the route: the status, the `Retry-After` header and the per-account path are untested.",
        fix: "Add a route test that makes 11 attempts.",
        comment: "Could we add a route-level test for the 429 and `Retry-After`?",
        confidence: "medium",
      },
    ],
    verdict: "address_before_merge",
    summary:
      "Thanks for turning INC-42 around quickly. The limiter is the right idea, but this can't merge while failed logins log plaintext passwords, and the IP bucket is bypassable via `X-Forwarded-For`. Two smaller notes inline.",
    coverage: "Read the route, limiter, logger and test, and CLAUDE.md's review section. Didn't check the load balancer config for which X-Forwarded-For hop it appends.",
  },
};

// ---------- assigned to the viewer: webhook retries ----------

const pr236: FixturePr = {
  repo: REPO,
  number: 236,
  title: "Webhooks: retry failed deliveries with exponential backoff",
  body: code`
    Failed webhook deliveries are currently dropped. This retries them:

    - up to 8 attempts
    - 30s, 1m, 2m, 4m … backoff
    - a cron calls \`retryPending()\` every minute
  `,
  author: "hana-lindqvist",
  branch: "hana/webhook-retries",
  base: "main",
  state: "OPEN",
  labels: ["webhooks"],
  assigned: true,
  updatedMinutesAgo: 60 * 3,
  github: { checks: [["test", "SUCCESS"], ["lint", "SUCCESS"]], decision: "REVIEW_REQUIRED" },
  commits: [
    {
      message: "Retry failed webhook deliveries with backoff",
      edits: [
        {
          path: "src/webhooks/retry.ts",
          add: code`
            import { db } from "../lib/db";
            import { deliver } from "./deliver";

            const MAX_ATTEMPTS = 8;
            const BASE_DELAY_MS = 30_000;

            export function nextDelayMs(attempt: number): number {
              return BASE_DELAY_MS * 2 ** attempt;
            }

            /** Called every minute by the scheduler. */
            export async function retryPending(now = Date.now()) {
              const pending = await db.deliveries.findPending();
              for (const delivery of pending) {
                if (delivery.attempts >= MAX_ATTEMPTS) continue;
                if (delivery.nextAttemptAt > now) continue;
                const ok = await deliver(delivery);
                if (!ok) await db.deliveries.update(delivery.id, { nextAttemptAt: now + nextDelayMs(delivery.attempts) });
              }
            }
          `,
        },
        {
          path: "src/webhooks/retry.test.ts",
          add: code`
            import { expect, test } from "bun:test";
            import { nextDelayMs } from "./retry";

            test("backs off exponentially", () => {
              expect(nextDelayMs(0)).toBe(30_000);
              expect(nextDelayMs(3)).toBe(240_000);
            });
          `,
        },
      ],
    },
  ],
  recon: {
    headline: "Retries failed webhook deliveries with exponential backoff",
    summary:
      "Adds `retryPending()`, run every minute, which re-sends due deliveries up to 8 attempts with a 30s × 2ⁿ backoff. A test pins the backoff curve.",
    intent: "Stop silently dropping webhooks when a customer endpoint is briefly down.",
    areas: { "src/webhooks": ["Webhook retries", "retryPending(), backoff and a test"] },
    risks: [
      ["medium", "Sequential sends: one slow endpoint delays every other retry"],
      ["low", "Deliveries past the max stay pending forever"],
    ],
    minutes: [16, 7],
    estReasoning: "Small, but retry loops fail in slow, quiet ways.",
    focus: ["Timeouts on deliver()", "What happens after the 8th attempt", "Which HTTP statuses get retried"],
  },
  review: {
    trail: [
      { read: "src/webhooks/retry.ts" },
      { read: "src/webhooks/deliver.ts" },
      { say: "deliver() has no timeout, and retryPending awaits each delivery in turn." },
      { grep: "findPending", in: "src" },
      { read: "migrations/0011_deliveries.sql" },
      { say: "Nothing marks a delivery as dead after MAX_ATTEMPTS, so findPending keeps returning it." },
      { grep: "res.ok", in: "src/webhooks" },
      { read: "src/webhooks/retry.test.ts" },
    ],
    findings: [
      {
        severity: "high",
        lens: "Reliability",
        title: "One slow endpoint stalls every other retry",
        at: { path: "src/webhooks/retry.ts", match: "const ok = await deliver(delivery);" },
        why: "`deliver()` calls `fetch` with no timeout, and `retryPending` awaits deliveries one by one. A customer endpoint that hangs for minutes blocks the whole batch, and the next cron run starts a second overlapping loop.",
        fix: "Give `fetch` an `AbortSignal.timeout(10_000)` and deliver with bounded concurrency; skip the run if one is already in progress.",
        comment: "`deliver()` has no timeout and these run sequentially, so one hanging endpoint holds up every other customer's retries (and the next minute's run overlaps). Could we add a timeout and a little concurrency?",
        confidence: "high",
      },
      {
        severity: "medium",
        lens: "Correctness",
        title: "Deliveries past the last attempt stay pending forever",
        at: { path: "src/webhooks/retry.ts", match: "if (delivery.attempts >= MAX_ATTEMPTS) continue;" },
        why: "Exhausted deliveries are skipped but never marked failed, so `findPending()` returns a growing set of dead rows every minute.",
        fix: "Mark them `failed` (and maybe notify the customer) instead of `continue`.",
        comment: "After 8 attempts these are skipped but stay pending, so every run re-reads them. Worth marking them failed here?",
        confidence: "high",
      },
      {
        severity: "medium",
        lens: "Correctness",
        title: "4xx responses are retried like outages",
        at: { path: "src/webhooks/deliver.ts", match: "return res.ok;" },
        why: "A 410 Gone or 401 from a customer endpoint is permanent, but it's retried 8 times over ~2 hours like a 503.",
        fix: "Only retry 408, 429 and 5xx.",
        comment: "Should 4xx (other than 408/429) count as permanent? Retrying a 410 eight times won't help.",
        confidence: "medium",
      },
      {
        severity: "low",
        lens: "Reliability",
        title: "No jitter on the backoff",
        at: { path: "src/webhooks/retry.ts", match: "return BASE_DELAY_MS * 2 ** attempt;" },
        why: "Deliveries that failed together retry together, which hammers an endpoint the moment it recovers.",
        fix: "Add ±20% jitter.",
        comment: "Nit: a bit of jitter would spread retries after an outage.",
        confidence: "high",
      },
    ],
    verdict: "address_before_merge",
    summary:
      "Retrying is overdue, thanks! Before this runs every minute in production, `deliver()` needs a timeout (one slow endpoint currently stalls everyone), and exhausted deliveries should be marked failed. Smaller notes inline.",
    coverage: "Read retry.ts, deliver.ts, the deliveries migration and the test. Didn't check the scheduler config.",
  },
};

// ---------- reviewed and posted, then new commits: receipts ----------

const pr238: FixturePr = {
  repo: REPO,
  number: 238,
  title: "Add GET /v1/orders/:id/receipt",
  body: code`
    PDF receipts for orders, for the "Download receipt" link in the account area.

    Renders with the existing invoice template.
  `,
  author: "felix-oduya",
  branch: "felix/order-receipts",
  base: "main",
  state: "OPEN",
  labels: ["orders"],
  requestedBy: "felix-oduya",
  requestedMinutesAgo: 60 * 30,
  updatedMinutesAgo: 40,
  github: {
    checks: [["test", "SUCCESS"], ["lint", "SUCCESS"]],
    decision: "CHANGES_REQUESTED",
    reviews: [{ author: "robin-vale", state: "CHANGES_REQUESTED", minutesAgo: 60 * 22, comments: 2 }],
  },
  commits: [
    {
      message: "Add PDF receipts endpoint",
      edits: [
        {
          path: "src/routes/orders.ts",
          replace: [
            ['import { db } from "../lib/db";', 'import { db } from "../lib/db";\nimport { renderReceipt } from "../receipts/render";'],
            [
              "export async function listOrders(ctx: Context) {",
              L(
                "export async function getReceipt(ctx: Context) {",
                '  const order = await db.orders.findById(ctx.param("id"));',
                '  if (!order) return ctx.status(404).json({ error: "not_found" });',
                "  const pdf = await renderReceipt(order);",
                '  return ctx.setHeader("content-type", "application/pdf").body(pdf);',
                "}",
                "",
                "export async function listOrders(ctx: Context) {",
              ),
            ],
          ],
        },
        {
          path: "src/receipts/render.ts",
          add: code`
            import { renderTemplate } from "../pdf/templates";

            export async function renderReceipt(order: { id: string; totalCents: number; lines: unknown[] }) {
              return renderTemplate("invoice", { order, title: "Receipt " + order.id });
            }
          `,
        },
      ],
    },
    {
      message: "Receipts: check the order belongs to the caller",
      edits: [
        {
          path: "src/routes/orders.ts",
          replace: [
            [
              '  if (!order) return ctx.status(404).json({ error: "not_found" });\n  const pdf',
              '  if (!order) return ctx.status(404).json({ error: "not_found" });\n  if (order.userId !== ctx.session.userId) return ctx.status(403).json({ error: "forbidden" });\n  const pdf',
            ],
          ],
        },
      ],
    },
  ],
  recon: {
    headline: "Adds a PDF receipt endpoint for orders",
    summary: "New `GET /v1/orders/:id/receipt` loads the order and renders it with the invoice PDF template via `renderReceipt`.",
    intent: "Back the \"Download receipt\" link in the account area.",
    areas: {
      "src/routes": ["Orders routes", "New getReceipt handler"],
      "src/receipts": ["Receipt rendering", "renderReceipt() on the invoice template"],
    },
    risks: [["high", "Route takes an order id: ownership must be checked"]],
    minutes: [10, 4],
    estReasoning: "Small, but an id-taking route is exactly where IDORs hide.",
    focus: ["Ownership check on the order", "Caching headers on a personal document"],
  },
  review: {
    findings: [
      {
        severity: "critical",
        lens: "Security",
        title: "Any signed-in user can download any order's receipt",
        at: { path: "src/routes/orders.ts", match: "if (!order) return ctx.status(404)" },
        why: "`getReceipt` loads the order by id without checking `order.userId === ctx.session.userId`, unlike `getOrder` right above it. Order ids are sequential-ish, so receipts (names, addresses, amounts) can be enumerated.",
        fix: "Treat a foreign order like a missing one: `if (!order || order.userId !== ctx.session.userId) return 404`.",
        comment: "This doesn't check the order belongs to the caller (`getOrder` does), so anyone signed in can fetch any receipt by id. Could it mirror `getOrder`'s check?",
        confidence: "high",
      },
      {
        severity: "low",
        lens: "Privacy",
        title: "Receipt PDFs can be cached by shared caches",
        at: { path: "src/routes/orders.ts", match: 'setHeader("content-type", "application/pdf")' },
        why: "The response has no `Cache-Control`, so an intermediary may cache a personal document.",
        fix: "Add `Cache-Control: private, no-store`.",
        comment: "Could we add `Cache-Control: private, no-store`? These are personal documents.",
        confidence: "medium",
      },
    ],
    verdict: "address_before_merge",
    summary: "Nice and small, but the receipt route is missing the ownership check that `getOrder` has, so any user can fetch any receipt. Requesting changes for that one.",
    coverage: "Read the new route and renderer, compared against getOrder. Didn't read the PDF template.",
  },
  rereview: {
    trail: [
      { bash: "git diff HEAD~1 HEAD -- src/routes/orders.ts" },
      { read: "src/routes/orders.ts" },
      { say: "Ownership is now checked, but a foreign order answers 403 while a missing one answers 404." },
    ],
    prior: {
      "Any signed-in user can download any order's receipt": ["addressed", "getReceipt now rejects orders that don't belong to the caller."],
      "Receipt PDFs can be cached by shared caches": ["still_present", "Still no Cache-Control header on the PDF response."],
    },
    findings: [
      {
        severity: "low",
        lens: "Security",
        title: "403 vs 404 reveals which order ids exist",
        at: { path: "src/routes/orders.ts", match: 'ctx.status(403).json({ error: "forbidden" })' },
        why: "A foreign order now answers 403 while a missing one answers 404, so ids can still be probed for existence. `getOrder` returns 404 for both.",
        fix: "Return 404 for both, like getOrder.",
        comment: "Thanks for adding the check! Small thing: 403 here vs 404 for missing orders lets someone tell which ids exist. `getOrder` answers 404 for both; could this match?",
        confidence: "high",
      },
    ],
    verdict: "merge_with_followups",
    summary: "The ownership check is in, thanks. One small follow-up on 403 vs 404, and the Cache-Control note from last time still applies. Good to merge after that.",
    coverage: "Re-read the delta since my last review and the full getReceipt handler.",
  },
};

// ---------- the viewer's own draft ----------

const pr240: FixturePr = {
  repo: REPO,
  number: 240,
  title: "Orders: cursor pagination for GET /v1/orders",
  body: "Draft. Customers with 2k+ orders time out on the account page. Adds `?cursor=` and `limit` (max 100).",
  author: "robin-vale",
  branch: "robin/orders-pagination",
  base: "main",
  state: "OPEN",
  draft: true,
  updatedMinutesAgo: 60 * 20,
  github: { checks: [["test", "SUCCESS"], ["lint", "FAILURE"]] },
  commits: [
    {
      message: "wip: cursor pagination for orders",
      edits: [
        {
          path: "src/routes/orders.ts",
          replace: [
            [
              "  const orders = await db.orders.findByUser(ctx.session.userId);\n  return ctx.json({ orders });",
              L(
                '  const limit = Math.min(Number(ctx.param("limit") || 50), 100);',
                '  const cursor = ctx.param("cursor") || null;',
                "  const orders = await db.orders.findByUser(ctx.session.userId, { after: cursor, limit });",
                "  const next = orders.length === limit ? orders[orders.length - 1].id : null;",
                "  return ctx.json({ orders, next });",
              ),
            ],
          ],
        },
      ],
    },
  ],
  recon: {
    headline: "Adds cursor pagination to the orders list",
    summary: "`listOrders` takes `cursor` and `limit` (max 100) and returns a `next` cursor when the page is full.",
    intent: "Stop the account page timing out for customers with thousands of orders.",
    areas: { "src/routes": ["Orders routes", "Cursor and limit on listOrders"] },
    risks: [["medium", "Changes a public response shape"]],
    minutes: [8, 4],
    estReasoning: "Small, API-shape change.",
    focus: ["Invalid limit values", "Cursor ordering"],
    questions: [
      ["Is `next` backwards compatible for existing clients?", "Say in the description that `orders` is unchanged and `next` is additive."],
      ["What's the sort order the cursor relies on?", "Mention that findByUser sorts by id and that ids are monotonic."],
    ],
  },
  review: {
    findings: [
      {
        severity: "medium",
        lens: "Correctness",
        title: "limit=abc becomes NaN and returns nothing",
        at: { path: "src/routes/orders.ts", match: 'const limit = Math.min(Number(ctx.param("limit") || 50), 100);' },
        why: "`Number(\"abc\")` is NaN and `Math.min(NaN, 100)` is NaN, so the query gets `limit: NaN`.",
        fix: "Parse with a fallback and clamp to 1..100.",
        comment: "Non-numeric limits become NaN.",
        confidence: "high",
        prompt: "In src/routes/orders.ts listOrders, parse limit with `Number.parseInt`, default to 50 when it isn't a finite number, and clamp to 1..100. Add a test for limit=abc.",
      },
      {
        severity: "low",
        lens: "Commit hygiene",
        title: "\"wip\" commit message",
        at: null,
        why: "The only commit is \"wip: cursor pagination for orders\".",
        fix: "Reword before opening for review.",
        comment: "Reword the wip commit.",
        confidence: "high",
        prompt: "Run `git commit --amend -m \"Orders: cursor pagination for GET /v1/orders\"` on robin/orders-pagination.",
      },
    ],
    verdict: "merge_with_followups",
    summary: "Close. Validate `limit` and reword the commit.",
    coverage: "Read listOrders.",
  },
};

// ---------- hidden "for good": a dependency bot ----------

const pr237: FixturePr = {
  repo: REPO,
  number: 237,
  title: "Bump eslint from 9.12.0 to 9.14.0",
  body: "Bumps eslint from 9.12.0 to 9.14.0. Release notes and commits are linked in the bot's usual comment.",
  author: "quokka-deps[bot]",
  branch: "deps/eslint-9.14.0",
  base: "main",
  state: "OPEN",
  labels: ["dependencies"],
  requestedBy: "quokka-deps[bot]",
  requestedMinutesAgo: 60 * 50,
  updatedMinutesAgo: 60 * 50,
  github: { checks: [["test", "SUCCESS"], ["lint", "SUCCESS"]] },
  commits: [{ message: "Bump eslint from 9.12.0 to 9.14.0", edits: [{ path: "package.json", replace: [['"eslint": "^9.12.0"', '"eslint": "^9.14.0"']] }] }],
};

// ---------- the refunds stack (#243 → #244), across-the-stack pass done ----------

const pr243: FixturePr = {
  repo: REPO,
  number: 243,
  title: "Refunds: add refunds table and model",
  body: "Schema for partial refunds. The endpoint comes in #244.\n\nStack: **#243** → #244",
  author: "felix-oduya",
  branch: "refunds/schema",
  base: "main",
  state: "OPEN",
  labels: ["refunds"],
  requestedBy: "felix-oduya",
  requestedMinutesAgo: 60 * 28,
  updatedMinutesAgo: 60 * 26,
  github: { checks: [["test", "SUCCESS"], ["lint", "SUCCESS"], ["migrations", "SUCCESS"]] },
  commits: [
    {
      message: "Add refunds table",
      edits: [
        {
          path: "migrations/0012_refunds.sql",
          add: code`
            CREATE TABLE refunds (
              id            TEXT PRIMARY KEY,
              order_id      TEXT NOT NULL REFERENCES orders(id),
              amount_cents  INTEGER NOT NULL,
              reason        TEXT,
              created_by    TEXT NOT NULL,
              created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
            );
          `,
        },
        {
          path: "src/models/refund.ts",
          add: code`
            import { db } from "../lib/db";

            export interface Refund {
              id: string;
              orderId: string;
              amountCents: number;
              reason: string | null;
              createdBy: string;
            }

            export async function refundedCents(orderId: string): Promise<number> {
              const rows = await db.sql\`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM refunds WHERE order_id = \${orderId}\`;
              return Number(rows[0].n);
            }
          `,
        },
      ],
    },
  ],
  recon: {
    headline: "Adds the refunds table and a refundedCents() helper",
    summary: "Migration 0012 creates `refunds` (order, amount in cents, reason, who) and `src/models/refund.ts` adds the type and a sum-per-order helper.",
    intent: "Groundwork for partial refunds (#244).",
    areas: {
      migrations: ["Migrations", "New refunds table"],
      "src/models": ["Refund model", "Type and refundedCents()"],
    },
    risks: [["medium", "New table on a hot foreign key: indexing and constraints"]],
    minutes: [9, 4],
    estReasoning: "Schema review: small but hard to change later.",
    focus: ["Indexes for the per-order sum", "Constraints on amount_cents"],
  },
  review: {
    findings: [
      {
        severity: "medium",
        lens: "Performance",
        title: "No index on refunds.order_id",
        at: { path: "migrations/0012_refunds.sql", match: "order_id      TEXT NOT NULL REFERENCES orders(id)," },
        why: "`refundedCents` sums by `order_id`, which is a sequential scan without an index. Postgres doesn't index foreign keys automatically.",
        fix: "`CREATE INDEX CONCURRENTLY refunds_order_id ON refunds (order_id);` in a follow-up migration.",
        comment: "Postgres won't index this foreign key for us, and `refundedCents` sums by it. Could we add an index (concurrently, per CLAUDE.md)?",
        confidence: "high",
      },
      {
        severity: "medium",
        lens: "Money",
        title: "amount_cents allows zero and negative refunds",
        at: { path: "migrations/0012_refunds.sql", match: "amount_cents  INTEGER NOT NULL," },
        why: "Nothing stops a negative refund, which would increase what the customer owes.",
        fix: "`CHECK (amount_cents > 0)`.",
        comment: "Could we add `CHECK (amount_cents > 0)` so a negative refund can't be stored?",
        confidence: "high",
      },
    ],
    verdict: "merge_with_followups",
    summary: "Schema looks right. Two constraints worth adding before the endpoint lands on top.",
    coverage: "Read the migration and model.",
  },
};

const pr244: FixturePr = {
  repo: REPO,
  number: 244,
  title: "Refunds: POST /v1/orders/:id/refunds",
  body: "Support can issue partial refunds. Only the `support` role can call it.\n\nStack: #243 → **#244**",
  author: "felix-oduya",
  branch: "refunds/api",
  base: "refunds/schema",
  state: "OPEN",
  labels: ["refunds"],
  requestedBy: "felix-oduya",
  requestedMinutesAgo: 60 * 28,
  updatedMinutesAgo: 60 * 25,
  github: { checks: [["test", "SUCCESS"], ["lint", "SUCCESS"]] },
  commits: [
    {
      message: "Add refunds endpoint for support",
      edits: [
        {
          path: "src/routes/refunds.ts",
          add: code`
            import { randomUUID } from "node:crypto";
            import type { Context } from "../lib/http";
            import { db } from "../lib/db";
            import { payments } from "../lib/payments";

            export async function createRefund(ctx: Context) {
              if (!ctx.session.roles.includes("support")) return ctx.status(403).json({ error: "forbidden" });
              const order = await db.orders.findById(ctx.param("id"));
              if (!order) return ctx.status(404).json({ error: "not_found" });
              const { amountCents, reason } = await ctx.json<{ amountCents: number; reason?: string }>();
              await payments.refund(order.paymentId, amountCents);
              const refund = { id: randomUUID(), orderId: order.id, amountCents, reason: reason ?? null, createdBy: ctx.session.userId };
              await db.refunds.insert(refund);
              return ctx.status(201).json(refund);
            }
          `,
        },
      ],
    },
  ],
  recon: {
    headline: "Adds a support-only endpoint for partial refunds",
    summary: "`POST /v1/orders/:id/refunds` (support role) refunds through the payment provider, then records the refund row.",
    intent: "Let support issue partial refunds without the payment provider's dashboard.",
    areas: { "src/routes": ["Refunds route", "createRefund handler"] },
    risks: [
      ["high", "Moves money: amount validation and idempotency"],
      ["medium", "Provider call happens before the database write"],
    ],
    minutes: [14, 6],
    estReasoning: "Money-moving endpoint; worth a slow read.",
    focus: ["Refunding more than was paid", "Retries creating double refunds", "Validation of amountCents"],
  },
  review: {
    findings: [
      {
        severity: "high",
        lens: "Money",
        title: "Nothing stops refunding more than the order total",
        at: { path: "src/routes/refunds.ts", match: "await payments.refund(order.paymentId, amountCents);" },
        why: "The handler doesn't compare `amountCents` plus `refundedCents(order.id)` with the order total, so repeated partial refunds can exceed what was paid.",
        fix: "Check `refundedCents(order.id) + amountCents <= order.totalCents` in a transaction before calling the provider.",
        comment: "Could we check that previous refunds plus this one don't exceed the order total before calling the provider? `refundedCents` from #243 gives us the sum.",
        confidence: "high",
      },
      {
        severity: "high",
        lens: "Reliability",
        title: "A retried request refunds twice",
        at: { path: "src/routes/refunds.ts", match: "export async function createRefund(ctx: Context) {" },
        why: "No idempotency key is accepted or passed to the provider, so a client retry after a timeout issues a second refund.",
        fix: "Require an `Idempotency-Key` header and pass it to `payments.refund`.",
        comment: "If support's tool retries after a timeout, this refunds twice. Could we take an `Idempotency-Key` and pass it through to the provider?",
        confidence: "high",
      },
      {
        severity: "medium",
        lens: "Money",
        title: "amountCents isn't validated",
        at: { path: "src/routes/refunds.ts", match: "const { amountCents, reason } = await ctx.json" },
        why: "A zero, negative or fractional `amountCents` goes straight to the provider.",
        fix: "Validate with zod: positive integer.",
        comment: "Could we validate `amountCents` as a positive integer here (zod)?",
        confidence: "high",
      },
    ],
    verdict: "address_before_merge",
    summary: "The flow is right, but this needs an over-refund check and idempotency before support can use it safely.",
    coverage: "Read the handler; the payments client isn't in this PR.",
  },
};

export const refundsStack: FixtureStack = {
  repo: REPO,
  root: 243,
  name: "refunds",
  cross: {
    findings: [
      {
        kind: "repeated",
        prs: [243, 244],
        severity: "medium",
        lens: "Money",
        title: "Refund amounts aren't validated in the schema (#243) or the API (#244)",
        why: "#243's table accepts any integer and #244's handler passes `amountCents` straight through, so a zero or negative refund can reach both the provider and the table. One CHECK constraint plus request validation covers it.",
        fix: "`CHECK (amount_cents > 0)` in #243, zod validation in #244.",
        fixedNote: null,
        fixedIn: null,
        confidence: "high",
        placements: [
          {
            pr: 243,
            at: { path: "migrations/0012_refunds.sql", match: "amount_cents  INTEGER NOT NULL," },
            comment: "Reading this with #244: neither the table nor the endpoint rejects a zero or negative amount. A `CHECK (amount_cents > 0)` here is the backstop.",
          },
          {
            pr: 244,
            at: { path: "src/routes/refunds.ts", match: "const { amountCents, reason } = await ctx.json" },
            comment: "Same gap as #243's table: `amountCents` isn't validated before it reaches the provider. A positive-integer check here (plus the CHECK in #243) covers both.",
          },
        ],
        replaces: ["amount_cents allows zero and negative refunds", "amountCents isn't validated"],
        prompt: "On refunds/schema add `CHECK (amount_cents > 0)` to migrations/0012_refunds.sql. On refunds/api validate amountCents with z.number().int().positive() in src/routes/refunds.ts.",
      },
      {
        kind: "relies",
        prs: [243, 244],
        severity: "medium",
        lens: "Performance",
        title: "#244's over-refund check will scan refunds without #243 indexing order_id",
        why: "The fix for #244's over-refund issue sums refunds per order via `refundedCents` from #243, on every refund request. Without an index on `refunds.order_id` that's a sequential scan that grows with the table.",
        fix: "Index `order_id` in #243.",
        fixedNote: null,
        fixedIn: null,
        confidence: "medium",
        placements: [
          {
            pr: 243,
            at: { path: "migrations/0012_refunds.sql", match: "order_id      TEXT NOT NULL REFERENCES orders(id)," },
            comment: "#244 will call `refundedCents` on every refund, so this sum runs a lot. An index on `order_id` (created concurrently) keeps it cheap.",
          },
        ],
        replaces: ["No index on refunds.order_id"],
        prompt: "On refunds/schema add migrations/0013_refunds_order_idx.sql with CREATE INDEX CONCURRENTLY refunds_order_id ON refunds (order_id);",
      },
    ],
  },
};

// ---------- history ----------

const pr226: FixturePr = {
  repo: REPO,
  number: 226,
  title: "Add request ids to every log line",
  body: "Adds `requestId` to log fields so we can follow a request through the logs.",
  author: "priya-castell",
  branch: "priya/request-ids",
  base: "main",
  state: "MERGED",
  updatedMinutesAgo: 60 * 24 * 12,
  commits: [
    {
      message: "Log request ids",
      edits: [
        {
          path: "src/lib/log.ts",
          replace: [
            [
              "function write(level: string, msg: string, fields: Fields = {}) {\n  console.log(JSON.stringify({ level, msg, ...fields, at: new Date().toISOString() }));",
              "let requestId: string | undefined;\nexport const setRequestId = (id: string | undefined) => (requestId = id);\n\nfunction write(level: string, msg: string, fields: Fields = {}) {\n  console.log(JSON.stringify({ level, msg, requestId, ...fields, at: new Date().toISOString() }));",
            ],
          ],
        },
      ],
    },
  ],
  recon: {
    headline: "Adds a request id to every log line",
    summary: "`log.ts` keeps a module-level `requestId` that's included in every line; `setRequestId` sets it.",
    intent: "Follow one request through the logs.",
    areas: { "src/lib": ["Logging", "requestId on every log line"] },
    risks: [["medium", "Module-level state shared by concurrent requests"]],
    minutes: [6, 3],
    estReasoning: "Small, but concurrency matters.",
    focus: ["Concurrent requests overwriting the id"],
  },
  review: {
    findings: [
      {
        severity: "high",
        lens: "Correctness",
        title: "Concurrent requests overwrite each other's request id",
        at: { path: "src/lib/log.ts", match: "let requestId: string | undefined;" },
        why: "A module-level variable is shared by every in-flight request, so logs get tagged with whichever request set it last.",
        fix: "Use AsyncLocalStorage.",
        comment: "Since this is module state, concurrent requests will stamp each other's ids. `AsyncLocalStorage` would keep it per request.",
        confidence: "high",
      },
      {
        severity: "low",
        lens: "Tests",
        title: "No test for the new field",
        at: null,
        why: "Nothing asserts requestId appears in output.",
        fix: "Add one.",
        comment: "A quick test would help.",
        confidence: "medium",
      },
    ],
    verdict: "address_before_merge",
    summary: "Good idea; the id needs to be per request rather than per process.",
    coverage: "Read log.ts.",
  },
};

const pr229: FixturePr = {
  repo: REPO,
  number: 229,
  title: "Sessions: shorten the TTL to 14 days",
  body: "Security asked for a shorter session lifetime (SEC-19).",
  author: "dmitri-ashgrove",
  branch: "dmitri/session-ttl",
  base: "main",
  state: "MERGED",
  updatedMinutesAgo: 60 * 24 * 6,
  commits: [
    {
      message: "Shorten session TTL to 14 days",
      edits: [{ path: "src/sessions/store.ts", replace: [["const TTL_MS = 30 * 24 * 60 * 60 * 1000;", "const TTL_MS = 14 * 24 * 60 * 60 * 1000;"]] }],
    },
  ],
  recon: {
    headline: "Shortens sessions from 30 to 14 days",
    summary: "One constant: `TTL_MS` goes from 30 to 14 days.",
    intent: "SEC-19: shorter session lifetime.",
    areas: { "src/sessions": ["Sessions", "TTL constant"] },
    risks: [["low", "Existing sessions keep their old expiry"]],
    minutes: [3, 2],
    estReasoning: "One line.",
    focus: ["Existing sessions"],
  },
  review: {
    findings: [
      {
        severity: "low",
        lens: "Compatibility",
        title: "Existing sessions keep a 30-day expiry",
        at: { path: "src/sessions/store.ts", match: "const TTL_MS = 14" },
        why: "`expiresAt` is stored at creation, so current sessions still last 30 days.",
        fix: "Fine if acceptable; otherwise cap on read.",
        comment: "FYI existing sessions keep their 30-day expiry. Probably fine?",
        confidence: "high",
      },
    ],
    verdict: "approve",
    summary: "LGTM.",
    coverage: "One constant.",
  },
};

export const apiPrs: FixturePr[] = [pr226, pr229, pr231, pr236, pr237, pr238, pr240, pr243, pr244];

/** Pushed to GitHub but no PR yet: self-review it, then "Open PR". */
export const apiBranches: FixtureBranch[] = [
  {
    repo: REPO,
    branch: "robin/order-events",
    base: "main",
    pushed: true,
    commits: [
      {
        message: "Emit order.paid and order.refunded events",
        edits: [
          {
            path: "src/events/orders.ts",
            add: code`
              import { log } from "../lib/log";
              import { enqueue } from "../webhooks/queue";

              export type OrderEvent = { type: "order.paid" | "order.refunded"; orderId: string; amountCents: number };

              export async function emitOrderEvent(event: OrderEvent) {
                log.info("order event", { type: event.type, orderId: event.orderId });
                await enqueue("orders", event);
              }
            `,
          },
        ],
      },
    ],
    recon: {
      headline: "Emits order.paid and order.refunded events to the webhook queue",
      summary: "New `emitOrderEvent` logs and enqueues order events for webhooks.",
      intent: "Let customers subscribe to order payments and refunds.",
      areas: { "src/events": ["Order events", "emitOrderEvent()"] },
      risks: [["low", "No callers yet"]],
      minutes: [5, 3],
      estReasoning: "One small new function.",
      focus: ["Where it gets called"],
      questions: [["Where is this called from?", "Say in the description that the callers land in a follow-up PR."]],
    },
    review: {
      findings: [
        {
          severity: "low",
          lens: "Tests",
          title: "No test for emitOrderEvent",
          at: { path: "src/events/orders.ts", match: "export async function emitOrderEvent" },
          why: "New behaviour without a test.",
          fix: "Add a test that stubs enqueue.",
          comment: "Add a test.",
          confidence: "high",
          prompt: "Add src/events/orders.test.ts that mocks ../webhooks/queue and asserts emitOrderEvent enqueues the event on the \"orders\" queue.",
        },
      ],
      verdict: "approve",
      summary: "Small and clean. Add a test and it's ready.",
      coverage: "Read the new file.",
    },
  },
];
