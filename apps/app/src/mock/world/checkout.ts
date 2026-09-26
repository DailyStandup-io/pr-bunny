// quokka-labs/checkout: the web checkout (TypeScript + React). Home of the 4-layer "checkout v2"
// stack, a payment double-submit fix, a draft autocomplete PR and the viewer's own money-format PR.
import type { FixturePr, FixtureRepo, FixtureStack } from "../types";
import { code, ORG } from "./people";

const L = (...lines: string[]) => lines.join("\n");
const REPO = `${ORG}/checkout`;

export const checkoutRepo: FixtureRepo = {
  owner: ORG,
  name: "checkout",
  description: "The Quokka Labs web checkout: cart, shipping, payment and the order summary.",
  defaultBranch: "main",
  committers: ["amara-fenwick", "jonah-pike", "lena-okoro", "yuki-brenner", "robin-vale"],
  files: {
    "README.md": code`
      # checkout

      The Quokka Labs web checkout: cart, shipping, payment and the order summary.

      ## Develop

          bun install
          bun run dev

      Feature flags live in \`src/lib/flags.ts\`. Money is always integer cents.
    `,
    "package.json": code`
      {
        "name": "@quokka/checkout",
        "private": true,
        "type": "module",
        "scripts": {
          "dev": "vite",
          "test": "vitest run",
          "typecheck": "tsc --noEmit"
        },
        "dependencies": {
          "react": "^18.3.1",
          "react-dom": "^18.3.1",
          "zod": "^3.23.8"
        },
        "devDependencies": {
          "@types/react": "^18.3.11",
          "@types/react-dom": "^18.3.1",
          "typescript": "^5.6.3",
          "vite": "^5.4.10",
          "vitest": "^2.1.4"
        }
      }
    `,
    ".github/CODEOWNERS": code`
      *               @quokka-labs/web
      src/cart/       @amara-fenwick
      src/checkout/   @jonah-pike @lena-okoro
    `,
    ".claude/skills/review-pr/SKILL.md": code`
      ---
      name: review-pr
      description: How we review checkout PRs. Use when reviewing a pull request in this repo.
      ---

      # Reviewing checkout PRs

      Money is the one thing we can't get wrong. Look for these, most severe first:

      1. **Money math.** Amounts are integer cents end to end. No floats, no \`toFixed\` on amounts,
         rounding only at display. A wrong total is always **critical**.
      2. **Double charges.** Anything that can submit a payment must be idempotent (one
         \`Idempotency-Key\` per attempt) and must not fire twice on a fast double click.
      3. **Flags.** New checkout behaviour ships behind a flag in \`src/lib/flags.ts\`, **default off**.
      4. **Accessibility.** Every field has a label; errors and changing totals are announced
         (\`aria-live\`).
      5. **Tests.** Changes to totals or promo logic need unit tests in \`src/cart/*.test.ts\`.

      Don't comment on formatting; Prettier owns it.
    `,
    "src/cart/cart.ts": code`
      export interface CartLine {
        sku: string;
        name: string;
        unitPriceCents: number;
        quantity: number;
      }

      export interface Cart {
        id: string;
        currency: "USD" | "EUR" | "GBP";
        lines: CartLine[];
        shippingCountry: string | null;
      }

      export function lineTotalCents(line: CartLine): number {
        return line.unitPriceCents * line.quantity;
      }

      export function itemCount(cart: Cart): number {
        return cart.lines.reduce((n, line) => n + line.quantity, 0);
      }
    `,
    "src/checkout/Summary.tsx": code`
      import type { Cart } from "../cart/cart";
      import { lineTotalCents } from "../cart/cart";
      import { formatMoney } from "../lib/money";

      const TAX_RATES: Record<string, number> = { US: 0.0725, GB: 0.2, DE: 0.19 };

      export function Summary({ cart }: { cart: Cart }) {
        const subtotal = cart.lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
        const shipping = subtotal >= 5000 ? 0 : 499;
        const tax = Math.round(subtotal * (TAX_RATES[cart.shippingCountry ?? "US"] ?? 0));
        const total = subtotal + shipping + tax;

        return (
          <dl className="summary">
            <dt>Subtotal</dt>
            <dd>{formatMoney(subtotal, cart.currency)}</dd>
            <dt>Shipping</dt>
            <dd>{shipping === 0 ? "Free" : formatMoney(shipping, cart.currency)}</dd>
            <dt>Tax</dt>
            <dd>{formatMoney(tax, cart.currency)}</dd>
            <dt className="summary-total">Total</dt>
            <dd className="summary-total">{formatMoney(total, cart.currency)}</dd>
          </dl>
        );
      }
    `,
    "src/checkout/CheckoutPage.tsx": code`
      import type { Cart } from "../cart/cart";
      import { lineTotalCents } from "../cart/cart";
      import { PaymentButton } from "./PaymentButton";
      import { ShippingForm } from "./ShippingForm";
      import { Summary } from "./Summary";

      export function CheckoutPage({ cart, onPaid }: { cart: Cart; onPaid: (orderId: string) => void }) {
        const amountCents = cart.lines.reduce((sum, line) => sum + lineTotalCents(line), 0);

        return (
          <main className="checkout">
            <section>
              <h1>Checkout</h1>
              <ShippingForm onSubmit={() => {}} />
            </section>
            <aside>
              <Summary cart={cart} />
              <PaymentButton cartId={cart.id} amountCents={amountCents} onPaid={onPaid} />
            </aside>
          </main>
        );
      }
    `,
    "src/checkout/PaymentButton.tsx": code`
      import { useState } from "react";
      import { createPayment } from "../api/client";

      interface Props {
        cartId: string;
        amountCents: number;
        onPaid: (orderId: string) => void;
      }

      export function PaymentButton({ cartId, amountCents, onPaid }: Props) {
        const [error, setError] = useState<string | null>(null);

        async function pay() {
          setError(null);
          try {
            const { orderId } = await createPayment({ cartId, amountCents });
            onPaid(orderId);
          } catch {
            setError("Payment failed. Please try again.");
          }
        }

        return (
          <div className="pay">
            <button type="button" className="pay-button" onClick={pay}>
              Pay now
            </button>
            {error && <p className="pay-error">{error}</p>}
          </div>
        );
      }
    `,
    "src/checkout/ShippingForm.tsx": code`
      import { useState } from "react";

      export interface Address {
        line1: string;
        city: string;
        postcode: string;
        country: string;
      }

      export function ShippingForm({ onSubmit }: { onSubmit: (address: Address) => void }) {
        const [address, setAddress] = useState<Address>({ line1: "", city: "", postcode: "", country: "US" });
        const set = (key: keyof Address) => (e: React.ChangeEvent<HTMLInputElement>) =>
          setAddress({ ...address, [key]: e.target.value });

        return (
          <form
            className="shipping"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(address);
            }}
          >
            <label>
              Address
              <input value={address.line1} onChange={set("line1")} autoComplete="address-line1" />
            </label>
            <label>
              City
              <input value={address.city} onChange={set("city")} autoComplete="address-level2" />
            </label>
            <label>
              Postcode
              <input value={address.postcode} onChange={set("postcode")} autoComplete="postal-code" />
            </label>
            <button type="submit">Continue to payment</button>
          </form>
        );
      }
    `,
    "src/checkout/EmptyCart.tsx": code`
      export function EmptyCart({ onBrowse }: { onBrowse: () => void }) {
        return (
          <div className="empty-cart">
            <h2>Your cart is empty</h2>
            <p>Add something to get started.</p>
            <button type="button" onClick={onBrowse}>
              Browse products
            </button>
          </div>
        );
      }
    `,
    "src/api/client.ts": code`
      const BASE_URL = "/api/v1";

      export interface CreatePaymentInput {
        cartId: string;
        amountCents: number;
      }

      async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
        const res = await fetch(BASE_URL + path, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error("Request failed: " + res.status);
        return (await res.json()) as T;
      }

      export function createPayment(input: CreatePaymentInput): Promise<{ orderId: string }> {
        return post("/payments", input);
      }
    `,
    "src/lib/money.ts": code`
      const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

      /** Formats integer cents for display, e.g. 1999 → "$19.99". */
      export function formatMoney(cents: number, currency: string): string {
        const symbol = SYMBOLS[currency] ?? "";
        return symbol + (cents / 100).toFixed(2);
      }
    `,
    "src/lib/flags.ts": code`
      export type Flag = "express_pay" | "saved_addresses";

      const DEFAULTS: Record<Flag, boolean> = {
        express_pay: false,
        saved_addresses: true,
      };

      export function isEnabled(flag: Flag, overrides: Partial<Record<Flag, boolean>> = {}): boolean {
        return overrides[flag] ?? DEFAULTS[flag];
      }
    `,
  },
};

// ---------- the checkout v2 stack (#1482 → #1483 → #1484 → #1485) ----------

const pr1482: FixturePr = {
  repo: REPO,
  number: 1482,
  title: "Checkout v2: extract cart totals into a pure module",
  body: code`
    First of four PRs for checkout v2. This one only moves math around.

    - New \`src/cart/totals.ts\` with \`computeTotals(cart)\`: subtotal, shipping, tax and total, all in integer cents.
    - Unit tests for the free-shipping threshold and tax.
    - Nothing uses it yet; #1484 switches the summary over.

    Stack: **#1482** → #1483 → #1484 → #1485
  `,
  author: "amara-fenwick",
  branch: "checkout-v2/totals",
  base: "main",
  state: "OPEN",
  labels: ["checkout-v2"],
  requestedBy: "amara-fenwick",
  requestedMinutesAgo: 60 * 26,
  updatedMinutesAgo: 60 * 5,
  github: { checks: [["typecheck", "SUCCESS"], ["unit", "SUCCESS"], ["e2e", "SUCCESS"]], decision: "REVIEW_REQUIRED" },
  commits: [
    {
      message: "Add computeTotals: subtotal, shipping and tax in cents",
      edits: [
        {
          path: "src/cart/totals.ts",
          add: code`
            import type { Cart } from "./cart";
            import { lineTotalCents } from "./cart";

            /** Orders of $50 or more ship free. */
            export const FREE_SHIPPING_THRESHOLD_CENTS = 5000;
            export const STANDARD_SHIPPING_CENTS = 499;

            const TAX_RATES: Record<string, number> = { US: 0.0725, GB: 0.2, DE: 0.19 };

            export interface Totals {
              subtotalCents: number;
              shippingCents: number;
              taxCents: number;
              totalCents: number;
            }

            /** Everything the summary and the payment step show, in integer cents. */
            export function computeTotals(cart: Cart): Totals {
              const subtotalCents = cart.lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
              const shippingCents = subtotalCents > FREE_SHIPPING_THRESHOLD_CENTS ? 0 : STANDARD_SHIPPING_CENTS;
              const rate = TAX_RATES[cart.shippingCountry ?? "US"] ?? 0;
              const taxCents = Math.round(subtotalCents * rate);
              return { subtotalCents, shippingCents, taxCents, totalCents: subtotalCents + shippingCents + taxCents };
            }
          `,
        },
        {
          path: "src/cart/totals.test.ts",
          add: code`
            import { describe, expect, test } from "vitest";
            import type { Cart } from "./cart";
            import { computeTotals } from "./totals";

            const cart = (cents: number, country = "US"): Cart => ({
              id: "c1",
              currency: "USD",
              shippingCountry: country,
              lines: [{ sku: "tee", name: "Tee", unitPriceCents: cents, quantity: 1 }],
            });

            describe("computeTotals", () => {
              test("charges shipping under the threshold", () => {
                expect(computeTotals(cart(4999)).shippingCents).toBe(499);
              });

              test("ships free over the threshold", () => {
                expect(computeTotals(cart(6000)).shippingCents).toBe(0);
              });

              test("rounds tax to whole cents", () => {
                expect(computeTotals(cart(1999)).taxCents).toBe(145);
              });

              test("uses the destination's rate", () => {
                expect(computeTotals(cart(1000, "GB")).taxCents).toBe(200);
              });
            });
          `,
        },
      ],
    },
  ],
  recon: {
    headline: "Moves checkout's totals math into a pure, tested computeTotals() module",
    summary:
      "Adds `src/cart/totals.ts`, a pure `computeTotals(cart)` returning subtotal, shipping, tax and total in integer cents, with Vitest coverage for the threshold and tax rounding. Nothing calls it yet: the order summary switches over in #1484, higher in the stack.",
    intent: "Give checkout v2 one tested source of truth for money instead of math inlined in the summary component.",
    areas: {
      "src/cart": ["Cart totals", "New computeTotals() module and its unit tests"],
    },
    risks: [
      ["medium", "Free-shipping threshold is re-implemented, not moved: check it matches today's Summary.tsx exactly"],
      ["low", "The old tax table in Summary.tsx stays until #1484 lands"],
    ],
    minutes: [14, 6],
    estReasoning: "Small and pure, but every line is money math, so it deserves a slow read.",
    focus: ["The `>` vs `>=` on the free-shipping threshold", "Fallback when a country has no tax rate", "Whether the tests cover exactly $50.00"],
  },
  review: {
    trail: [
      { read: "src/cart/totals.ts" },
      { read: "src/checkout/Summary.tsx" },
      { grep: "FREE_SHIPPING_THRESHOLD_CENTS" },
      { say: "Summary.tsx ships free at `>= 5000` but totals.ts uses `> 5000`: exactly $50.00 changes behaviour." },
      { read: "src/cart/totals.test.ts" },
      { grep: "TAX_RATES", in: "src" },
      { bash: "git log --oneline -5 -- src/checkout/Summary.tsx" },
      { say: "Unknown countries fall back to a 0% rate silently. Checking where shippingCountry comes from." },
      { grep: "shippingCountry", in: "src" },
    ],
    findings: [
      {
        severity: "medium",
        lens: "Correctness",
        title: "Exactly $50.00 no longer ships free",
        at: { path: "src/cart/totals.ts", match: "subtotalCents > FREE_SHIPPING_THRESHOLD_CENTS" },
        why: "Today `Summary.tsx` uses `subtotal >= 5000`, and the constant's own comment says \"$50 or more ship free\". `computeTotals` uses `>`, so a cart of exactly 5000 cents gets charged $4.99 shipping once #1484 switches over. The tests check 4999 and 6000 but not 5000, so they don't catch it.",
        fix: "Use `>=` and add a test for exactly 5000 cents.",
        comment:
          "This is `>` but `Summary.tsx` uses `>=` (and the comment above says \"$50 or more\"), so a $50.00 cart would start paying shipping when the summary switches over.\n\n```suggestion\n  const shippingCents = subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS ? 0 : STANDARD_SHIPPING_CENTS;\n```\n\nCould you add a test for exactly 5000 too?",
        confidence: "high",
        qa: {
          answer:
            "Yes, it's a real behaviour change. `src/checkout/Summary.tsx:9` has `subtotal >= 5000 ? 0 : 499`, and `src/cart/totals.ts:4` documents \"$50 or more\". With `>`, `computeTotals` returns `shippingCents: 499` for a 5000-cent cart, and nothing in the test file covers 5000.",
          recommendation: "accept",
        },
      },
      {
        severity: "medium",
        lens: "Correctness",
        title: "Countries without a tax rate are silently taxed at 0%",
        at: { path: "src/cart/totals.ts", match: "?? 0;" },
        why: "`TAX_RATES[country] ?? 0` returns 0 for any country not in the table (e.g. FR or NL), so those orders are undercharged tax with no error or log. Summary.tsx has the same fallback today, but this module is about to become the one source of truth.",
        fix: "Throw (or return an explicit `taxUnavailable`) for unknown countries, and cover it in a test.",
        comment:
          "`?? 0` means any country missing from `TAX_RATES` quietly gets 0% tax. Since this becomes the source of truth for checkout v2, could it fail loudly instead (or return something the UI can show)?",
        confidence: "medium",
      },
      {
        severity: "low",
        lens: "Maintainability",
        title: "Tax table now exists twice (totals.ts and Summary.tsx)",
        at: { path: "src/cart/totals.ts", match: "const TAX_RATES" },
        why: "The same `TAX_RATES` literal is copied from `src/checkout/Summary.tsx`. Until the summary uses `computeTotals`, a rate change has to be made in both places.",
        fix: "Export the table from totals.ts and import it in Summary.tsx, or delete Summary's copy when it switches over.",
        comment: "This duplicates the `TAX_RATES` table in `Summary.tsx`. Worth exporting it from here so there's one copy while both exist?",
        confidence: "high",
      },
    ],
    verdict: "merge_with_followups",
    summary:
      "Nice extraction: the module is pure and the tests read well. One behaviour change slipped in on the free-shipping threshold (`>` instead of `>=`), and unknown countries fall back to 0% tax silently. Happy for this to merge once the threshold matches today's checkout.",
    coverage: "Read all of totals.ts and its tests, compared against Summary.tsx and every caller of shippingCountry. Skipped nothing; the change is small.",
  },
};

const pr1483: FixturePr = {
  repo: REPO,
  number: 1483,
  title: "Checkout v2: apply promo codes in totals",
  body: code`
    Adds promo support to \`computeTotals\`:

    - \`percentOff\` and \`amountOffCents\` promos
    - discount comes off before tax
    - new \`discountCents\` on \`Totals\`

    Stack: #1482 → **#1483** → #1484 → #1485
  `,
  author: "amara-fenwick",
  branch: "checkout-v2/promo",
  base: "checkout-v2/totals",
  state: "OPEN",
  labels: ["checkout-v2"],
  requestedBy: "amara-fenwick",
  requestedMinutesAgo: 60 * 26,
  updatedMinutesAgo: 60 * 5,
  github: { checks: [["typecheck", "SUCCESS"], ["unit", "SUCCESS"], ["e2e", "SUCCESS"]], decision: "REVIEW_REQUIRED" },
  commits: [
    {
      message: "Apply percent and fixed-amount promos before tax",
      edits: [
        {
          path: "src/cart/totals.ts",
          replace: [
            [
              "export interface Totals {\n  subtotalCents: number;\n",
              "export interface Promo {\n  code: string;\n  percentOff?: number;\n  amountOffCents?: number;\n}\n\nexport interface Totals {\n  subtotalCents: number;\n  discountCents: number;\n",
            ],
            ["export function computeTotals(cart: Cart): Totals {", "export function computeTotals(cart: Cart, promo: Promo | null = null): Totals {"],
            [
              "  const shippingCents = subtotalCents",
              "  const discountCents = promo ? discountFor(subtotalCents, promo) : 0;\n  const shippingCents = subtotalCents",
            ],
            [
              "  const taxCents = Math.round(subtotalCents * rate);\n  return { subtotalCents, shippingCents, taxCents, totalCents: subtotalCents + shippingCents + taxCents };\n}",
              L(
                "  const taxCents = Math.round((subtotalCents - discountCents) * rate);",
                "  const totalCents = subtotalCents - discountCents + shippingCents + taxCents;",
                "  return { subtotalCents, discountCents, shippingCents, taxCents, totalCents };",
                "}",
                "",
                "function discountFor(subtotalCents: number, promo: Promo): number {",
                "  if (promo.percentOff) return subtotalCents * (promo.percentOff / 100);",
                "  return promo.amountOffCents ?? 0;",
                "}",
              ),
            ],
          ],
        },
        {
          path: "src/cart/totals.test.ts",
          replace: [
            [
              '  test("uses the destination\'s rate", () => {',
              L(
                '  test("takes a percent promo off before tax", () => {',
                '    const t = computeTotals(cart(10000), { code: "SPRING10", percentOff: 10 });',
                "    expect(t.discountCents).toBe(1000);",
                "    expect(t.taxCents).toBe(653);",
                "  });",
                "",
                '  test("takes a fixed promo off", () => {',
                '    expect(computeTotals(cart(3000), { code: "FIVER", amountOffCents: 500 }).discountCents).toBe(500);',
                "  });",
                "",
                '  test("uses the destination\'s rate", () => {',
              ),
            ],
          ],
        },
      ],
    },
  ],
  recon: {
    headline: "Adds percent and fixed-amount promo codes to computeTotals()",
    summary:
      "Extends `computeTotals` with an optional `Promo`: a percent or fixed discount taken off the subtotal before tax, exposed as `discountCents`. Two new tests cover a 10% promo and a $5 promo. Shipping still keys off the pre-discount subtotal.",
    intent: "Let checkout v2 show and charge promo discounts from the same totals module.",
    areas: { "src/cart": ["Cart totals", "Promo type, discountFor() and two promo tests"] },
    risks: [
      ["high", "Discount math on money: percent promos can produce fractional cents"],
      ["medium", "No clamp: a fixed promo larger than the cart could make the total negative"],
    ],
    minutes: [16, 7],
    estReasoning: "Tiny diff, but new money math with edge cases the tests don't reach.",
    focus: ["Rounding in discountFor()", "Promo bigger than the subtotal", "Which subtotal the free-shipping threshold uses now"],
  },
  review: {
    trail: [
      { read: "src/cart/totals.ts" },
      { say: "discountFor() multiplies by percentOff / 100 without rounding. A 15% promo on 1999 cents gives 299.85." },
      { read: "src/cart/totals.test.ts" },
      { grep: "discountCents", in: "src" },
      { bash: "git diff checkout-v2/totals -- src/cart/totals.ts" },
      { say: "Checking what happens when amountOffCents exceeds the subtotal." },
      { grep: "amountOffCents" },
    ],
    findings: [
      {
        severity: "critical",
        lens: "Money math",
        title: "Percent promos produce fractional cents",
        at: { path: "src/cart/totals.ts", match: "subtotalCents * (promo.percentOff / 100)" },
        why: "`discountFor` returns `subtotalCents * (percentOff / 100)` unrounded. A 15% promo on a 1999-cent cart gives `discountCents = 299.85`, so `totalCents` is fractional too. The repo's review skill treats any non-integer amount as critical: the payment API takes integer cents and the summary rounds each line separately, so lines stop adding up to the total.",
        fix: "Round once, here: `Math.round(subtotalCents * promo.percentOff / 100)`, and add a test with an odd subtotal.",
        comment:
          "This can return a fractional number of cents (15% of 1999 is 299.85), which then flows into `totalCents`.\n\n```suggestion\n  if (promo.percentOff) return Math.round((subtotalCents * promo.percentOff) / 100);\n```",
        confidence: "high",
      },
      {
        severity: "high",
        lens: "Money math",
        title: "A fixed promo bigger than the cart makes the total negative",
        at: { path: "src/cart/totals.ts", match: "return promo.amountOffCents ?? 0;" },
        why: "Nothing clamps the discount: `FIVER` (500 cents off) on a 300-cent cart gives `discountCents = 500`, a negative taxable amount, and a total below zero before shipping.",
        fix: "`Math.min(promo.amountOffCents ?? 0, subtotalCents)`, plus a test.",
        comment: "Could this clamp to the subtotal? A $5 promo on a $3 cart currently makes the taxable amount negative.",
        confidence: "high",
      },
      {
        severity: "medium",
        lens: "Correctness",
        title: "Free shipping still uses the pre-discount subtotal",
        at: { path: "src/cart/totals.ts", match: "const shippingCents = subtotalCents" },
        why: "A $55 cart with a $10 promo pays $45 but still ships free. That may be intended, but the PR description doesn't say and there's no test pinning it.",
        fix: "Decide which subtotal the threshold uses, then test it.",
        comment: "Is free shipping meant to use the subtotal before the promo? A $55 cart with $10 off would still ship free. Fine either way, but worth a test so it's deliberate.",
        confidence: "medium",
      },
    ],
    verdict: "address_before_merge",
    summary:
      "The promo shape is good and taking the discount off before tax matches how we charge today. Two money bugs need fixing first: percent promos produce fractional cents, and fixed promos aren't clamped to the subtotal. Details inline.",
    coverage: "Read totals.ts, its tests and every use of discountCents in the stack. Didn't check the promo validation API (not in this PR).",
  },
};

const pr1484: FixturePr = {
  repo: REPO,
  number: 1484,
  title: "Checkout v2: new order summary panel",
  body: code`
    Replaces \`Summary\` with a new \`OrderSummary\` panel built on \`computeTotals\`, including a discount row.

    - Deletes \`Summary.tsx\` (its math now lives in totals.ts)
    - \`CheckoutPage\` takes an optional promo

    Screenshots in the Figma link on the ticket.

    Stack: #1482 → #1483 → **#1484** → #1485
  `,
  author: "amara-fenwick",
  branch: "checkout-v2/summary-ui",
  base: "checkout-v2/promo",
  state: "OPEN",
  labels: ["checkout-v2", "ui"],
  requestedBy: "amara-fenwick",
  requestedMinutesAgo: 60 * 26,
  updatedMinutesAgo: 60 * 4,
  github: { checks: [["typecheck", "SUCCESS"], ["unit", "SUCCESS"], ["e2e", "PENDING"]], decision: "REVIEW_REQUIRED" },
  commits: [
    {
      message: "Add OrderSummary panel on top of computeTotals",
      edits: [
        {
          path: "src/checkout/OrderSummary.tsx",
          add: code`
            import type { Cart } from "../cart/cart";
            import { computeTotals, type Promo } from "../cart/totals";
            import { formatMoney } from "../lib/money";

            export function OrderSummary({ cart, promo }: { cart: Cart; promo: Promo | null }) {
              const totals = computeTotals(cart, promo);
              const money = (cents: number) => formatMoney(cents, cart.currency);

              return (
                <section className="order-summary" aria-labelledby="order-summary-title">
                  <h2 id="order-summary-title">Order summary</h2>
                  <dl>
                    <dt>Subtotal</dt>
                    <dd>{money(totals.subtotalCents)}</dd>
                    <dt>Discount{promo ? " (" + promo.code + ")" : ""}</dt>
                    <dd>-{money(totals.discountCents)}</dd>
                    <dt>Shipping</dt>
                    <dd>{totals.shippingCents === 0 ? "Free" : money(totals.shippingCents)}</dd>
                    <dt>Tax</dt>
                    <dd>{money(totals.taxCents)}</dd>
                  </dl>
                  <p className="order-summary-total">
                    Total <strong>{money(totals.totalCents)}</strong>
                  </p>
                </section>
              );
            }
          `,
        },
        { path: "src/checkout/Summary.tsx", remove: true },
        {
          path: "src/checkout/CheckoutPage.tsx",
          replace: [
            ['import { Summary } from "./Summary";', 'import { OrderSummary } from "./OrderSummary";\nimport type { Promo } from "../cart/totals";'],
            [
              "export function CheckoutPage({ cart, onPaid }: { cart: Cart; onPaid: (orderId: string) => void }) {",
              "export function CheckoutPage({ cart, promo = null, onPaid }: { cart: Cart; promo?: Promo | null; onPaid: (orderId: string) => void }) {",
            ],
            ["        <Summary cart={cart} />", "        <OrderSummary cart={cart} promo={promo} />"],
          ],
        },
      ],
    },
  ],
  recon: {
    headline: "Swaps the old Summary for a new OrderSummary panel with a discount row",
    summary:
      "Adds `OrderSummary`, which renders subtotal, discount, shipping, tax and total from `computeTotals`, and deletes `Summary.tsx` along with its inline tax math. `CheckoutPage` now accepts an optional promo and renders the new panel.",
    intent: "Put the checkout v2 totals in front of shoppers, with promos visible.",
    areas: {
      "src/checkout": ["Checkout UI", "New OrderSummary panel, Summary.tsx deleted, CheckoutPage wired up"],
    },
    risks: [
      ["medium", "Deletes Summary.tsx: anything still importing it breaks"],
      ["low", "Discount row renders even when there's no promo"],
    ],
    minutes: [12, 5],
    estReasoning: "Mostly markup; the risk is in what the deletion leaves behind.",
    focus: ["Remaining imports of Summary", "The discount row with no promo", "Screen-reader announcement of the total"],
  },
  review: {
    trail: [
      { read: "src/checkout/OrderSummary.tsx" },
      { read: "src/checkout/CheckoutPage.tsx" },
      { grep: "from \"./Summary\"", in: "src" },
      { say: "No remaining importers of Summary in this layer. #1485 is worth a look later." },
      { grep: "aria-live", in: "src/checkout" },
    ],
    findings: [
      {
        severity: "low",
        lens: "UX",
        title: "Discount row shows \"-$0.00\" when there's no promo",
        at: { path: "src/checkout/OrderSummary.tsx", match: "<dd>-{money(totals.discountCents)}</dd>" },
        why: "The `Discount` term and `-$0.00` render unconditionally, so every order without a promo shows an empty discount line.",
        fix: "Render the discount `dt`/`dd` only when `totals.discountCents > 0`.",
        comment: "Could the discount row only render when there is one? Right now every cart shows `Discount -$0.00`.",
        confidence: "high",
      },
      {
        severity: "low",
        lens: "Accessibility",
        title: "Total changes aren't announced to screen readers",
        at: { path: "src/checkout/OrderSummary.tsx", match: '<p className="order-summary-total">' },
        why: "Applying a promo changes the total without any `aria-live` region, which the review skill asks for on changing totals.",
        fix: "Add `aria-live=\"polite\"` to the total.",
        comment: "Per our checklist, changing totals should be announced. `aria-live=\"polite\"` on this paragraph would do it.",
        confidence: "high",
      },
    ],
    verdict: "merge_with_followups",
    summary: "Clean panel and a nice simplification of CheckoutPage. Two small follow-ups inline (the empty discount row and announcing total changes).",
    coverage: "Read the new component and CheckoutPage; searched the layer for remaining Summary imports. Didn't run the app.",
  },
};

const pr1485: FixturePr = {
  repo: REPO,
  number: 1485,
  title: "Checkout v2: ship behind the checkout_v2 flag",
  body: code`
    Last layer: puts the new summary and totals behind \`checkout_v2\` so we can roll it out gradually.

    - New flag \`checkout_v2\`
    - Flag on: \`OrderSummary\` and \`computeTotals\` for the charged amount
    - Flag off: today's checkout

    Stack: #1482 → #1483 → #1484 → **#1485**
  `,
  author: "jonah-pike",
  branch: "checkout-v2/flag",
  base: "checkout-v2/summary-ui",
  state: "OPEN",
  labels: ["checkout-v2"],
  requestedBy: "jonah-pike",
  requestedMinutesAgo: 60 * 20,
  updatedMinutesAgo: 60 * 3,
  github: { checks: [["typecheck", "FAILURE"], ["unit", "SUCCESS"], ["e2e", "PENDING"]], decision: "REVIEW_REQUIRED" },
  commits: [
    {
      message: "Gate checkout v2 behind the checkout_v2 flag",
      edits: [
        {
          path: "src/lib/flags.ts",
          replace: [
            ['export type Flag = "express_pay" | "saved_addresses";', 'export type Flag = "express_pay" | "saved_addresses" | "checkout_v2";'],
            ["  saved_addresses: true,\n", "  saved_addresses: true,\n  checkout_v2: true,\n"],
          ],
        },
        {
          path: "src/checkout/CheckoutPage.tsx",
          replace: [
            ['import { lineTotalCents } from "../cart/cart";', 'import { lineTotalCents } from "../cart/cart";\nimport { computeTotals } from "../cart/totals";\nimport { isEnabled } from "../lib/flags";'],
            ['import { OrderSummary } from "./OrderSummary";', 'import { OrderSummary } from "./OrderSummary";\nimport { Summary } from "./Summary";'],
            [
              "  const amountCents = cart.lines.reduce((sum, line) => sum + lineTotalCents(line), 0);",
              L(
                '  const v2 = isEnabled("checkout_v2");',
                "  const amountCents = v2",
                "    ? computeTotals(cart).totalCents",
                "    : cart.lines.reduce((sum, line) => sum + lineTotalCents(line), 0);",
              ),
            ],
            ["        <OrderSummary cart={cart} promo={promo} />", "        {v2 ? <OrderSummary cart={cart} promo={promo} /> : <Summary cart={cart} />}"],
          ],
        },
      ],
    },
  ],
  recon: {
    headline: "Puts checkout v2 behind a new checkout_v2 flag",
    summary:
      "Adds a `checkout_v2` flag and branches `CheckoutPage` on it: flag on renders `OrderSummary` and charges `computeTotals(cart).totalCents`; flag off renders the old `Summary` and charges the plain subtotal.",
    intent: "Roll checkout v2 out gradually instead of all at once.",
    areas: {
      "src/checkout": ["Checkout page", "Branches summary and charged amount on the flag"],
      "src/lib": ["Feature flags", "New checkout_v2 flag"],
    },
    risks: [
      ["high", "Changes the amount sent to the payment API"],
      ["medium", "Flag default decides who sees v2 on deploy"],
      ["medium", "Flag-off path imports Summary, which #1484 deletes"],
    ],
    minutes: [10, 5],
    estReasoning: "Few lines, but it changes what we charge, so it's slower than its size.",
    focus: ["The flag's default", "Which amount is charged with the flag on", "Whether the flag-off path still builds"],
  },
  review: {
    trail: [
      { read: "src/lib/flags.ts" },
      { read: "src/checkout/CheckoutPage.tsx" },
      { say: "computeTotals(cart) is called without the promo here, but OrderSummary gets it." },
      { grep: "computeTotals(", in: "src" },
      { read: ".claude/skills/review-pr/SKILL.md" },
      { say: "The skill says new checkout behaviour ships default off; this defaults on." },
    ],
    findings: [
      {
        severity: "critical",
        lens: "Money math",
        title: "Charged amount ignores the promo the summary shows",
        at: { path: "src/checkout/CheckoutPage.tsx", match: "? computeTotals(cart).totalCents" },
        why: "`OrderSummary` computes totals with `promo`, but the amount sent to `PaymentButton` is `computeTotals(cart)` with no promo. A shopper with SPRING10 sees the discounted total and is charged the full one.",
        fix: "Compute totals once with the promo and pass the same `totalCents` to both.",
        comment:
          "This charges `computeTotals(cart)` without the promo, while `OrderSummary` shows `computeTotals(cart, promo)`. Anyone using a code would be charged more than the total they see.\n\n```suggestion\n    ? computeTotals(cart, promo).totalCents\n```",
        confidence: "high",
      },
      {
        severity: "high",
        lens: "Flags",
        title: "checkout_v2 defaults on",
        at: { path: "src/lib/flags.ts", match: "checkout_v2: true," },
        why: "The repo's review skill requires new checkout behaviour to ship default off. With `true`, every shopper gets v2 on deploy, which defeats the gradual rollout the PR description promises.",
        fix: "`checkout_v2: false`, and turn it on per cohort.",
        comment: "Our flags ship default off (see the review checklist), and the description says this is for a gradual rollout. Should this be `false`?",
        confidence: "high",
      },
    ],
    verdict: "address_before_merge",
    summary:
      "Right shape for the rollout. Two things before merging: the charged amount skips the promo that the summary shows, and the flag defaults on, so it wouldn't actually be gradual.",
    coverage: "Read both changed files and the review skill; traced computeTotals callers across the stack's checkout. Didn't run typecheck.",
  },
};

export const checkoutStack: FixtureStack = {
  repo: REPO,
  root: 1482,
  name: "checkout-v2",
  cross: {
    trail: [
      { read: "src/cart/totals.ts" },
      { read: "src/checkout/OrderSummary.tsx" },
      { read: "src/checkout/CheckoutPage.tsx" },
      { bash: "git log --oneline main..HEAD" },
      { grep: "Summary", in: "src/checkout" },
      { say: "#1485's flag-off path imports ./Summary, which #1484 deleted." },
      { grep: "TAX_RATES", in: "src" },
    ],
    findings: [
      {
        kind: "relies",
        prs: [1483, 1484, 1485],
        severity: "critical",
        lens: "Money math",
        title: "Fractional discount from #1483 is shown by #1484 and charged by #1485",
        why: "`discountFor` in #1483 returns unrounded cents (15% of 1999 = 299.85). #1484 formats each line separately, so the summary rows stop adding up to the total, and #1485 sends `totalCents` to the payment API, which only accepts integer cents. One rounding fix in #1483 fixes all three.",
        fix: "Round inside `discountFor` in #1483; #1484 and #1485 need no change.",
        fixedNote: null,
        fixedIn: null,
        confidence: "high",
        placements: [
          {
            pr: 1483,
            at: { path: "src/cart/totals.ts", match: "subtotalCents * (promo.percentOff / 100)" },
            comment:
              "Heads-up from reading the stack together: this unrounded value is what #1484 displays and #1485 charges, so rounding here once fixes the summary and the payment amount.\n\n```suggestion\n  if (promo.percentOff) return Math.round((subtotalCents * promo.percentOff) / 100);\n```",
          },
        ],
        replaces: ["Percent promos produce fractional cents"],
        prompt:
          "On branch checkout-v2/promo, in src/cart/totals.ts discountFor(): round the percent discount with Math.round((subtotalCents * promo.percentOff) / 100). Add a test in src/cart/totals.test.ts for a 15% promo on 1999 cents expecting discountCents 300.",
      },
      {
        kind: "breaks",
        prs: [1484, 1485],
        severity: "high",
        lens: "Build",
        title: "#1485's flag-off path imports Summary, which #1484 deletes",
        why: "#1484 deletes `src/checkout/Summary.tsx`. #1485 re-imports it for the flag-off branch (`import { Summary } from \"./Summary\"`), so the top of the stack doesn't typecheck (CI's typecheck job is red on #1485). Merged in order, main breaks.",
        fix: "Either keep Summary.tsx in #1484 until the flag is removed, or render the old markup inline in #1485.",
        fixedNote: null,
        fixedIn: null,
        confidence: "high",
        placements: [
          {
            pr: 1485,
            at: { path: "src/checkout/CheckoutPage.tsx", match: 'import { Summary } from "./Summary";' },
            comment: "`Summary.tsx` is deleted in #1484, so this import breaks the build at the top of the stack. Maybe keep the file in #1484 until the flag goes away?",
          },
        ],
        replaces: [],
        prompt:
          "On branch checkout-v2/summary-ui, restore src/checkout/Summary.tsx (it's still needed for the flag-off path in checkout-v2/flag). Then rebase checkout-v2/flag and run tsc --noEmit.",
      },
      {
        kind: "fixed",
        prs: [1482, 1484],
        severity: "low",
        lens: "Maintainability",
        title: "Duplicated tax table from #1482 goes away in #1484",
        why: "#1482 copies `TAX_RATES` into totals.ts while Summary.tsx keeps its own. #1484 deletes Summary.tsx, so the duplicate only lives between the two merges.",
        fix: null,
        fixedNote: "#1484 deletes Summary.tsx and its copy of the table.",
        fixedIn: 1484,
        confidence: "high",
        placements: [
          {
            pr: 1482,
            at: { path: "src/cart/totals.ts", match: "const TAX_RATES" },
            comment: "FYI this duplicates the table in `Summary.tsx`, but #1484 deletes that file, so no change needed if they merge together.",
          },
        ],
        replaces: ["Tax table now exists twice (totals.ts and Summary.tsx)"],
        prompt: null,
      },
    ],
  },
};

// ---------- standalone PRs ----------

const pr1490: FixturePr = {
  repo: REPO,
  number: 1490,
  title: "Fix double charge when the Pay button is clicked twice",
  body: code`
    Support saw three double charges last week, all from fast double clicks on **Pay now**.

    - Disable the button while a payment is in flight
    - Send an \`Idempotency-Key\` with each payment
    - Test for the double click

    Fixes CHK-311.
  `,
  author: "jonah-pike",
  branch: "jonah/pay-double-submit",
  base: "main",
  state: "OPEN",
  labels: ["bug", "payments"],
  requestedBy: "jonah-pike",
  requestedMinutesAgo: 95,
  updatedMinutesAgo: 70,
  github: { checks: [["typecheck", "SUCCESS"], ["unit", "SUCCESS"], ["e2e", "SUCCESS"]], decision: "REVIEW_REQUIRED" },
  commits: [
    {
      message: "Disable Pay while a payment is in flight",
      edits: [
        {
          path: "src/checkout/PaymentButton.tsx",
          replace: [
            [
              "  const [error, setError] = useState<string | null>(null);\n\n  async function pay() {\n    setError(null);\n    try {\n      const { orderId } = await createPayment({ cartId, amountCents });",
              L(
                "  const [error, setError] = useState<string | null>(null);",
                "  const [submitting, setSubmitting] = useState(false);",
                "  const idempotencyKey = crypto.randomUUID();",
                "",
                "  async function pay() {",
                "    if (submitting) return;",
                "    setSubmitting(true);",
                "    setError(null);",
                "    try {",
                "      const { orderId } = await createPayment({ cartId, amountCents }, idempotencyKey);",
              ),
            ],
            [
              '      setError("Payment failed. Please try again.");\n    }\n  }',
              '      setError("Payment failed. Please try again.");\n    } finally {\n      setSubmitting(false);\n    }\n  }',
            ],
            [
              '      <button type="button" className="pay-button" onClick={pay}>\n        Pay now',
              '      <button type="button" className="pay-button" onClick={pay} disabled={submitting}>\n        {submitting ? "Paying…" : "Pay now"}',
            ],
          ],
        },
        {
          path: "src/api/client.ts",
          replace: [
            [
              'export function createPayment(input: CreatePaymentInput): Promise<{ orderId: string }> {\n  return post("/payments", input);',
              'export function createPayment(input: CreatePaymentInput, idempotencyKey: string): Promise<{ orderId: string }> {\n  return post("/payments", input, { "Idempotency-Key": idempotencyKey });',
            ],
          ],
        },
        {
          path: "src/checkout/PaymentButton.test.tsx",
          add: code`
            import { fireEvent, render, screen } from "@testing-library/react";
            import { expect, test, vi } from "vitest";
            import * as client from "../api/client";
            import { PaymentButton } from "./PaymentButton";

            test("a double click only pays once", async () => {
              const spy = vi.spyOn(client, "createPayment").mockResolvedValue({ orderId: "o1" });
              render(<PaymentButton cartId="c1" amountCents={1999} onPaid={() => {}} />);
              const button = screen.getByRole("button", { name: "Pay now" });
              fireEvent.click(button);
              fireEvent.click(button);
              expect(spy).toHaveBeenCalledTimes(1);
            });
          `,
        },
      ],
    },
  ],
  recon: {
    headline: "Stops double charges by disabling Pay and sending an Idempotency-Key",
    summary:
      "`PaymentButton` now tracks a `submitting` state, ignores clicks while a payment is in flight and disables the button. `createPayment` sends an `Idempotency-Key` header, generated in the component. A new test double-clicks and expects one call.",
    intent: "Fix CHK-311: fast double clicks on Pay now created two charges.",
    areas: {
      "src/checkout": ["Payment button", "In-flight guard, disabled state and a double-click test"],
      "src/api": ["API client", "createPayment sends an Idempotency-Key header"],
    },
    risks: [
      ["high", "Payment path: the idempotency key must be stable across retries of one attempt"],
      ["low", "Error message isn't announced to assistive tech"],
    ],
    minutes: [18, 7],
    estReasoning: "Short diff, but it's the payment path and idempotency is easy to get subtly wrong.",
    focus: ["When the idempotency key is generated", "The in-flight guard across re-renders", "What the test actually proves"],
  },
  review: {
    trail: [
      { read: "src/checkout/PaymentButton.tsx" },
      { read: "src/api/client.ts" },
      { say: "idempotencyKey is created in the render body, so every re-render (including setSubmitting) makes a new key." },
      { grep: "createPayment(", in: "src" },
      { read: "src/checkout/PaymentButton.test.tsx" },
      { say: "The test's two clicks land before React re-renders, so the guard reads stale state. Checking whether it really passes for the right reason." },
      { grep: "aria-live", in: "src" },
    ],
    findings: [
      {
        severity: "high",
        lens: "Double charges",
        title: "Idempotency key changes on every render",
        at: { path: "src/checkout/PaymentButton.tsx", match: "const idempotencyKey = crypto.randomUUID();" },
        why: "The key is generated in the component body, so `setSubmitting(true)` re-renders with a new key. If the first request times out and the shopper retries, the retry carries a different key and the API treats it as a new payment: exactly the double charge this PR fixes.",
        fix: "Create the key when an attempt starts (inside `pay`, stored in a ref) and reuse it for retries of that attempt.",
        comment:
          "Because this runs on every render, the key changes as soon as `submitting` flips, so a retry after a timeout gets a fresh key and can charge twice. Could it live in a `useRef` that's set when a payment attempt starts?",
        confidence: "high",
        qa: {
          answer:
            "Confirmed. `crypto.randomUUID()` is at `src/checkout/PaymentButton.tsx:13`, in the render body. `setSubmitting(true)` on line 17 triggers a re-render, and any later click (after an error resets `submitting`) sends a different key. Nothing in `src/api/client.ts` reuses keys, so the server sees two independent payments.",
          recommendation: "accept",
        },
      },
      {
        severity: "medium",
        lens: "Tests",
        title: "The double-click test passes without the fix",
        at: { path: "src/checkout/PaymentButton.test.tsx", match: "expect(spy).toHaveBeenCalledTimes(1);" },
        why: "`createPayment` is mocked to resolve, but both `fireEvent.click` calls run before React commits `submitting = true`, so the second click hits the `if (submitting)` guard with stale state only by luck of batching. The disabled attribute is what actually stops it, and the test doesn't assert it.",
        fix: "Assert the button is disabled after the first click, and use a mock that doesn't resolve until the test says so.",
        comment: "Could the test assert the button is disabled after the first click (with a promise that stays pending)? As written I don't think it would fail without the guard.",
        confidence: "medium",
      },
      {
        severity: "low",
        lens: "Accessibility",
        title: "Payment error isn't announced",
        at: { path: "src/checkout/PaymentButton.tsx", match: '{error && <p className="pay-error">{error}</p>}' },
        why: "The error paragraph appears without `role=\"alert\"` or `aria-live`, so screen reader users don't hear that payment failed.",
        fix: "`<p className=\"pay-error\" role=\"alert\">`.",
        comment: "Small one: `role=\"alert\"` here would announce the failure to screen reader users.",
        confidence: "high",
      },
    ],
    verdict: "address_before_merge",
    summary:
      "Thanks for chasing this down. Disabling the button is right, but the idempotency key is regenerated on every render, so retries still get new keys, which is the case that matters most. Details and a small test tweak inline.",
    coverage: "Read PaymentButton, the API client and the new test; checked every caller of createPayment. Didn't look at the server's idempotency handling.",
  },
};

const pr1493: FixturePr = {
  repo: REPO,
  number: 1493,
  title: "Address autocomplete on the shipping form",
  body: code`
    **Draft:** wiring is done, styling isn't.

    Adds a \`useAddressSearch\` hook backed by the maps provider and shows suggestions under the address field. Picking one fills address, city and postcode.
  `,
  author: "lena-okoro",
  branch: "lena/address-autocomplete",
  base: "main",
  state: "OPEN",
  draft: true,
  labels: ["feature"],
  assigned: true,
  updatedMinutesAgo: 60 * 30,
  github: { checks: [["typecheck", "SUCCESS"], ["unit", "SUCCESS"]], decision: "REVIEW_REQUIRED" },
  commits: [
    {
      message: "Address autocomplete: hook and suggestions list",
      edits: [
        {
          path: "src/checkout/useAddressSearch.ts",
          add: code`
            import { useEffect, useState } from "react";

            const PLACES_URL = "https://places.maps-provider.example/v1/autocomplete";
            const PLACES_KEY = "pk_live_quokka_7Qm2dX9fRk41";

            export interface Suggestion {
              id: string;
              label: string;
              line1: string;
              city: string;
              postcode: string;
            }

            export function useAddressSearch(query: string): Suggestion[] {
              const [results, setResults] = useState<Suggestion[]>([]);

              useEffect(() => {
                if (query.length < 3) return;
                fetch(PLACES_URL + "?q=" + encodeURIComponent(query) + "&key=" + PLACES_KEY)
                  .then((res) => res.json())
                  .then((body) => setResults(body.suggestions));
              }, [query]);

              return results;
            }
          `,
        },
        {
          path: "src/checkout/ShippingForm.tsx",
          replace: [
            ['import { useState } from "react";', 'import { useState } from "react";\nimport { useAddressSearch } from "./useAddressSearch";'],
            [
              "    setAddress({ ...address, [key]: e.target.value });\n",
              "    setAddress({ ...address, [key]: e.target.value });\n  const suggestions = useAddressSearch(address.line1);\n",
            ],
            [
              '        <input value={address.line1} onChange={set("line1")} autoComplete="address-line1" />\n      </label>',
              L(
                '        <input value={address.line1} onChange={set("line1")} autoComplete="address-line1" />',
                "      </label>",
                '      <ul className="suggestions">',
                "        {suggestions.map((s) => (",
                "          <li key={s.id} onClick={() => setAddress({ ...address, line1: s.line1, city: s.city, postcode: s.postcode })}>",
                "            {s.label}",
                "          </li>",
                "        ))}",
                "      </ul>",
              ),
            ],
          ],
        },
      ],
    },
  ],
  recon: {
    headline: "Adds address autocomplete to the shipping form (draft)",
    summary:
      "New `useAddressSearch` hook queries a maps provider as the shopper types (3+ characters) and `ShippingForm` lists the suggestions under the address field; clicking one fills address, city and postcode. Marked draft: styling isn't done.",
    intent: "Fewer typos and failed deliveries by letting shoppers pick a known address.",
    areas: {
      "src/checkout": ["Shipping form", "useAddressSearch hook and a suggestions list"],
    },
    risks: [
      ["high", "A live API key is committed to client code"],
      ["medium", "One request per keystroke, with no ordering of responses"],
    ],
    minutes: [15, 6],
    estReasoning: "Small, but network and security questions need care.",
    focus: ["The API key", "Request volume and out-of-order responses", "Keyboard access to the suggestions"],
  },
  review: {
    findings: [
      {
        severity: "high",
        lens: "Security",
        title: "Live maps API key is committed in client code",
        at: { path: "src/checkout/useAddressSearch.ts", match: "const PLACES_KEY" },
        why: "`pk_live_…` is bundled into the web app and now in git history. If the provider bills per request and the key isn't restricted by referrer, anyone can spend on our account.",
        fix: "Proxy the lookup through our API, or at least load a referrer-restricted key from env and rotate this one.",
        comment: "This live key ends up in the bundle (and git history). Could we proxy through the API, or use a referrer-restricted key from config? Either way this one probably needs rotating.",
        confidence: "medium",
      },
      {
        severity: "medium",
        lens: "Correctness",
        title: "Slow responses can overwrite newer suggestions",
        at: { path: "src/checkout/useAddressSearch.ts", match: ".then((body) => setResults(body.suggestions));" },
        why: "Each keystroke starts a fetch and whichever resolves last wins. Typing \"12 Hi\" then \"12 High\" can show results for \"12 Hi\" if that request is slower.",
        fix: "Abort the previous request in the effect cleanup (AbortController), and debounce by ~200 ms.",
        comment: "Nothing cancels the previous request, so an older, slower response can replace newer results. An `AbortController` in the cleanup (plus a short debounce) would fix both this and the request volume.",
        confidence: "high",
      },
      {
        severity: "low",
        lens: "Accessibility",
        title: "Suggestions can't be reached with the keyboard",
        at: { path: "src/checkout/ShippingForm.tsx", match: "<li key={s.id} onClick=" },
        why: "`li` elements with `onClick` aren't focusable and have no listbox semantics.",
        fix: "Use buttons inside the list items, or a proper combobox pattern.",
        comment: "These `li`s only respond to clicks. Buttons inside them (or a combobox) would make them keyboard accessible.",
        confidence: "high",
      },
    ],
    verdict: "address_before_merge",
    summary: "Good start. The committed live key needs sorting before this goes further, and the fetch should cancel stale requests. I know it's a draft; flagging early.",
    coverage: "Read the new hook and the form. Didn't check the provider's key restrictions.",
  },
};

const pr1495: FixturePr = {
  repo: REPO,
  number: 1495,
  title: "Format money with Intl.NumberFormat",
  body: code`
    \`formatMoney\` hard-codes symbols and always puts them first, which is wrong for EUR in most of Europe ("19,99 €").

    - Use \`Intl.NumberFormat\` with the shopper's locale
    - Cache formatters
  `,
  author: "robin-vale",
  branch: "robin/intl-money",
  base: "main",
  state: "OPEN",
  labels: ["i18n"],
  updatedMinutesAgo: 60 * 2,
  github: {
    checks: [["typecheck", "SUCCESS"], ["unit", "SUCCESS"], ["e2e", "SUCCESS"]],
    decision: "APPROVED",
    reviews: [{ author: "lena-okoro", state: "APPROVED", minutesAgo: 50, comments: 1 }],
  },
  commits: [
    {
      message: "Format money with Intl.NumberFormat and the shopper's locale",
      edits: [
        {
          path: "src/lib/money.ts",
          replace: [
            [
              'const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };',
              "const formatters = new Map<string, Intl.NumberFormat>();",
            ],
            [
              '/** Formats integer cents for display, e.g. 1999 → "$19.99". */\nexport function formatMoney(cents: number, currency: string): string {\n  const symbol = SYMBOLS[currency] ?? "";\n  return symbol + (cents / 100).toFixed(2);\n}',
              L(
                '/** Formats integer cents in the shopper\'s locale, e.g. 1999 → "$19.99" or "19,99 €". */',
                "export function formatMoney(cents: number, currency: string, locale = navigator.language): string {",
                "  let formatter = formatters.get(currency);",
                "  if (!formatter) {",
                '    formatter = new Intl.NumberFormat(locale, { style: "currency", currency });',
                "    formatters.set(currency, formatter);",
                "  }",
                '  console.log("formatMoney", cents, currency, locale);',
                "  return formatter.format(cents / 100);",
                "}",
              ),
            ],
          ],
        },
        {
          path: "src/lib/money.test.ts",
          add: code`
            import { expect, test } from "vitest";
            import { formatMoney } from "./money";

            test("formats dollars", () => {
              expect(formatMoney(1999, "USD", "en-US")).toBe("$19.99");
            });
          `,
        },
      ],
    },
  ],
  recon: {
    headline: "Switches formatMoney to Intl.NumberFormat with the shopper's locale",
    summary:
      "`formatMoney` drops the hard-coded symbol table and formats with `Intl.NumberFormat` in the shopper's locale (defaulting to `navigator.language`), caching one formatter per currency. A first test covers USD.",
    intent: "Show prices the way shoppers expect them in their locale, e.g. \"19,99 €\" instead of \"€19.99\".",
    areas: { "src/lib": ["Money formatting", "Intl-based formatMoney and a first test"] },
    risks: [
      ["medium", "`navigator.language` doesn't exist during server rendering or in Node tests"],
      ["low", "Formatter cache keyed by currency only"],
    ],
    minutes: [8, 4],
    estReasoning: "One function, but it runs on every price in the app.",
    focus: ["The formatter cache key", "Where formatMoney runs without a browser", "Leftover logging"],
    questions: [
      ["Why cache per currency and not per locale?", "Say in the description that the locale is fixed per session, or key the cache by locale too."],
      ["How does this look for currencies without minor units, like JPY?", "Note that Cart.currency is limited to USD/EUR/GBP today, or divide by the currency's minor-unit factor."],
      ["Was this checked in Safari?", "Add a line to the description about which browsers you tried."],
    ],
  },
  review: {
    findings: [
      {
        severity: "medium",
        lens: "Correctness",
        title: "Formatter cache ignores the locale",
        at: { path: "src/lib/money.ts", match: "let formatter = formatters.get(currency);" },
        why: "The cache is keyed by currency only, so the first call's locale wins: after `formatMoney(1999, \"EUR\", \"de-DE\")`, `formatMoney(1999, \"EUR\", \"en-IE\")` still returns \"19,99 €\".",
        fix: "Key the cache by `locale + \":\" + currency`.",
        comment: "Cache is keyed by currency only, so the first locale wins.",
        confidence: "high",
        prompt:
          "In src/lib/money.ts, key the formatters cache by `${locale}:${currency}` instead of currency alone. Add a test in src/lib/money.test.ts that formats EUR in de-DE and then en-IE and expects \"19,99 €\" and \"€19.99\".",
      },
      {
        severity: "medium",
        lens: "Correctness",
        title: "navigator.language crashes outside the browser",
        at: { path: "src/lib/money.ts", match: "locale = navigator.language" },
        why: "The default parameter reads `navigator` whenever no locale is passed. In Vitest's node environment and during SSR of the receipt page, `navigator` is undefined, so `formatMoney(1999, \"USD\")` throws a ReferenceError.",
        fix: "Default to `typeof navigator === \"undefined\" ? \"en-US\" : navigator.language`.",
        comment: "`navigator` is undefined in node and SSR.",
        confidence: "high",
        prompt:
          "In src/lib/money.ts, change the default locale to `typeof navigator === \"undefined\" ? \"en-US\" : navigator.language`. Add a test that calls formatMoney(1999, \"USD\") without a locale.",
      },
      {
        severity: "low",
        lens: "Leftovers",
        title: "console.log left in formatMoney",
        at: { path: "src/lib/money.ts", match: 'console.log("formatMoney"' },
        why: "This logs on every price render, which is hundreds of lines per page view in production.",
        fix: "Remove it.",
        comment: "Leftover debug log.",
        confidence: "high",
        prompt: "Remove the console.log line from formatMoney in src/lib/money.ts.",
      },
      {
        severity: "low",
        lens: "Tests",
        title: "Only USD is tested, but the PR is about EUR",
        at: { path: "src/lib/money.test.ts", match: 'test("formats dollars"' },
        why: "The motivating case (\"19,99 €\") isn't covered, so a regression to symbol-first formatting wouldn't be caught.",
        fix: "Add EUR/de-DE and GBP/en-GB cases.",
        comment: "No test for the EUR case the PR is about.",
        confidence: "high",
        prompt: "In src/lib/money.test.ts add tests: formatMoney(1999, \"EUR\", \"de-DE\") → \"19,99 €\" and formatMoney(1999, \"GBP\", \"en-GB\") → \"£19.99\".",
      },
    ],
    verdict: "address_before_merge",
    summary: "Right approach. Fix the cache key and the navigator default before asking for review, and drop the log.",
    coverage: "Read money.ts, its test and every formatMoney caller.",
  },
};

const pr1497: FixturePr = {
  repo: REPO,
  number: 1497,
  title: "Friendlier copy on the empty-cart screen",
  body: "Copy from the content team (CONTENT-88).",
  author: "yuki-brenner",
  branch: "yuki/empty-cart-copy",
  base: "main",
  state: "OPEN",
  labels: ["copy"],
  requestedBy: "yuki-brenner",
  requestedMinutesAgo: 60 * 8,
  updatedMinutesAgo: 60 * 8,
  github: { checks: [["typecheck", "SUCCESS"], ["unit", "SUCCESS"]] },
  commits: [
    {
      message: "Empty cart: new copy",
      edits: [
        {
          path: "src/checkout/EmptyCart.tsx",
          replace: [
            ["      <h2>Your cart is empty</h2>\n      <p>Add something to get started.</p>", "      <h2>Nothing in your cart yet</h2>\n      <p>Find something you love. We'll keep it here for you.</p>"],
            ["        Browse products", "        Start shopping"],
          ],
        },
      ],
    },
  ],
};

// ---------- history: merged and closed ----------

const pr1471: FixturePr = {
  repo: REPO,
  number: 1471,
  title: "Upgrade to React 19",
  body: "Bumps react, react-dom and their types to 19. No code changes needed; the test suite passes.",
  author: "yuki-brenner",
  branch: "yuki/react-19",
  base: "main",
  state: "MERGED",
  labels: ["dependencies"],
  updatedMinutesAgo: 60 * 24 * 9,
  commits: [
    {
      message: "Upgrade React to 19",
      edits: [
        {
          path: "package.json",
          replace: [
            ['    "react": "^18.3.1",\n    "react-dom": "^18.3.1",', '    "react": "^19.1.0",\n    "react-dom": "^19.1.0",'],
            ['    "@types/react": "^18.3.11",\n    "@types/react-dom": "^18.3.1",', '    "@types/react": "^19.1.2",\n    "@types/react-dom": "^19.1.2",'],
          ],
        },
      ],
    },
  ],
  recon: {
    headline: "Bumps React and its types from 18 to 19",
    summary: "Updates `react`, `react-dom` and their type packages to 19.x. No source changes.",
    intent: "Stay on a supported React and unblock the new form actions.",
    areas: { "(root)": ["Dependencies", "React 18 → 19"] },
    risks: [["medium", "Major version bump: removed APIs (propTypes, string refs, test-utils act)"]],
    minutes: [6, 3],
    estReasoning: "Tiny diff; the risk is behavioural, not in the lines.",
    focus: ["Removed React 19 APIs anywhere in src", "Testing Library compatibility"],
  },
  review: {
    findings: [
      {
        severity: "low",
        lens: "Dependencies",
        title: "@testing-library/react may need a bump for React 19",
        at: { path: "package.json", match: '"react": "^19.1.0",' },
        why: "Older Testing Library versions import `react-dom/test-utils`, which React 19 removed.",
        fix: "Bump @testing-library/react to 16.1+ in the same PR.",
        comment: "Heads-up: older `@testing-library/react` versions import `react-dom/test-utils`, which is gone in 19. Worth bumping it here too.",
        confidence: "medium",
      },
      {
        severity: "low",
        lens: "Docs",
        title: "No changelog entry for a major upgrade",
        at: null,
        why: "Other dependency majors got a line in CHANGELOG.md.",
        fix: "Add a line.",
        comment: "Could you add a CHANGELOG line? We've done that for other majors.",
        confidence: "low",
      },
    ],
    verdict: "approve",
    summary: "Clean upgrade. One note about Testing Library; approving.",
    coverage: "Checked src for APIs React 19 removed. None found.",
  },
};

const pr1466: FixturePr = {
  repo: REPO,
  number: 1466,
  title: "Experiment: one-page checkout",
  body: "Spike for the one-page layout. Not meant to merge; opening for feedback on the approach.",
  author: "lena-okoro",
  branch: "lena/one-page-spike",
  base: "main",
  state: "CLOSED",
  labels: ["spike"],
  updatedMinutesAgo: 60 * 24 * 14,
  commits: [
    {
      message: "Spike: render shipping and payment on one page",
      edits: [
        {
          path: "src/checkout/CheckoutPage.tsx",
          replace: [['    <main className="checkout">', '    <main className="checkout checkout--one-page">']],
        },
      ],
    },
  ],
  recon: {
    headline: "Spike: one-page checkout layout",
    summary: "Adds a `checkout--one-page` class to try shipping and payment on one page. Explicitly not for merging.",
    intent: "Get feedback on a one-page checkout direction.",
    areas: { "src/checkout": ["Checkout page", "Layout class for the spike"] },
    risks: [],
    minutes: [3, 2],
    estReasoning: "One line.",
    focus: ["Whether the approach is worth pursuing"],
  },
  review: {
    findings: [
      {
        severity: "low",
        lens: "Scope",
        title: "Spike should go behind a flag if it's kept",
        at: { path: "src/checkout/CheckoutPage.tsx", match: "checkout--one-page" },
        why: "If this ever merges it changes the layout for everyone.",
        fix: "Flag it.",
        comment: "If we keep going with this, let's put it behind a flag.",
        confidence: "high",
      },
    ],
    verdict: "merge_with_followups",
    summary: "Direction looks promising; happy to pair on a flagged version.",
    coverage: "One-line change.",
  },
};

export const checkoutPrs: FixturePr[] = [pr1471, pr1466, pr1482, pr1483, pr1484, pr1485, pr1490, pr1493, pr1495, pr1497];
