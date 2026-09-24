import type { StackPr } from "../shared/types";
import type { OpenPr } from "./gh";

/**
 * Finds the stack around a PR by following base-branch chains through the repo's open PRs.
 * Parents: the PR whose head is our base, recursively. Children: PRs whose base is our head,
 * recursively (a branch can have several children, so this walks a tree).
 */
export function findStack(self: { headRefName: string; baseRefName: string; number: number }, open: OpenPr[]): StackPr[] {
  const byHead = new Map(open.map((p) => [p.headRefName, p]));
  const byBase = new Map<string, OpenPr[]>();
  for (const p of open) byBase.set(p.baseRefName, [...(byBase.get(p.baseRefName) ?? []), p]);

  const seen = new Set<number>([self.number]);
  const out: StackPr[] = [];

  let base = self.baseRefName;
  for (let depth = 1; ; depth++) {
    const parent = byHead.get(base);
    if (!parent || seen.has(parent.number)) break;
    seen.add(parent.number);
    out.push(toStackPr(parent, "parent", depth));
    base = parent.baseRefName;
  }

  const queue: Array<[string, number]> = [[self.headRefName, 1]];
  while (queue.length) {
    const [head, depth] = queue.shift()!;
    for (const child of byBase.get(head) ?? []) {
      if (seen.has(child.number)) continue;
      seen.add(child.number);
      out.push(toStackPr(child, "child", depth));
      queue.push([child.headRefName, depth + 1]);
    }
  }
  return out;
}

function toStackPr(p: OpenPr, relation: StackPr["relation"], depth: number): StackPr {
  return { number: p.number, title: p.title, headRef: p.headRefName, baseRef: p.baseRefName, relation, depth };
}
