import { describe, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRepo } from "./onboarding";
import { checkSkillPath, criteriaFrom, previewSkill, repoSkills, reviewSection, searchFiles, skillCandidates } from "./skills";
import { newer } from "./update";
import { RELEASE_SOURCES } from "./config";
import { VERSION } from "../build-info";

describe("review skill ranking", () => {
  const read = (texts: Record<string, string>) => async (p: string) => texts[p] ?? null;

  test("follows the locations list; AGENTS.md only with a review section", async () => {
    const files = [
      "README.md",
      "AGENTS.md",
      "CONTRIBUTING.md",
      "docs/code-review.md",
      ".github/copilot-instructions.md",
      ".claude/commands/review.md",
      ".claude/skills/deploy/SKILL.md",
      ".claude/skills/review-pr/SKILL.md",
    ];
    const c = await skillCandidates(files, read({ "AGENTS.md": "# Agents\n\n## Code review\n- flag any\n\n## Setup\n" }));
    expect(c.map((x) => x.path)).toEqual([
      ".claude/skills/review-pr/SKILL.md",
      ".claude/commands/review.md",
      "AGENTS.md",
      ".github/copilot-instructions.md",
      "CONTRIBUTING.md",
      "docs/code-review.md",
    ]);
    expect(c.map((x) => x.why)).toContain("\u201cCode review\u201d section");
    expect(c.filter((x) => x.suggested).map((x) => x.path)).toEqual([".claude/skills/review-pr/SKILL.md"]);
    const none = await skillCandidates(["AGENTS.md"], read({ "AGENTS.md": "# Agents\n## Preview builds\n" }));
    expect(none).toEqual([]);
  });
  test("pr-bunny beats review-pr; the first match is suggested even if it's a general doc", async () => {
    const c = await skillCandidates([".claude/skills/review-pr/SKILL.md", ".claude/skills/pr-bunny/SKILL.md"], read({}));
    expect(c[0]!.path).toBe(".claude/skills/pr-bunny/SKILL.md");
    expect((await skillCandidates(["CONTRIBUTING.md"], read({})))[0]).toEqual({ path: "CONTRIBUTING.md", kind: "docs", why: "Contributing guide", suggested: true });
  });
  test("only AGENTS.md's review section becomes the criteria", () => {
    const text = "# Agents\n## Setup\npnpm i\n## Code review\n- no any\n### Tests\n- colocate\n## Conventions\n- x";
    expect(reviewSection(text)).toEqual({ heading: "Code review", body: "## Code review\n- no any\n### Tests\n- colocate" });
    expect(criteriaFrom("AGENTS.md", text)).toBe("## Code review\n- no any\n### Tests\n- colocate");
    expect(criteriaFrom("REVIEWING.md", "whole file")).toBe("whole file");
    expect(criteriaFrom("CLAUDE.md", "no section here")).toBe("no section here");
  });
  test("skill paths from the browser stay inside the repo", () => {
    expect(checkSkillPath("docs/review.md")).toBe("docs/review.md");
    for (const bad of ["/etc/passwd", "../x.md", "a/../../x", "-x", "", 5]) expect(() => checkSkillPath(bad)).toThrow();
  });
});

describe("release sources", () => {
  test("prbunny.dev first, then GitHub Releases for tag v<version>", () => {
    if (RELEASE_SOURCES === "off") throw new Error("expected sources");
    expect(RELEASE_SOURCES.map((s) => s.latest)).toEqual([
      `https://prbunny.dev/releases/latest.json?v=${VERSION}`,
      "https://github.com/DailyStandup-io/pr-bunny/releases/latest/download/latest.json",
    ]);
    expect(RELEASE_SOURCES[1]!.file("0.2.0", "bunny-darwin-arm64")).toBe("https://github.com/DailyStandup-io/pr-bunny/releases/download/v0.2.0/bunny-darwin-arm64");
    expect(RELEASE_SOURCES[1]!.download).toBeUndefined();
  });
  test("prbunny.dev counts the update from this version on the binary, not its checksum", () => {
    if (RELEASE_SOURCES === "off") throw new Error("expected sources");
    const site = RELEASE_SOURCES[0]!;
    expect(site.file("0.2.0", "bunny-darwin-arm64")).toBe("https://prbunny.dev/releases/0.2.0/bunny-darwin-arm64");
    expect(site.download!("0.2.0", "bunny-darwin-arm64")).toBe(`https://prbunny.dev/releases/0.2.0/bunny-darwin-arm64?from=${VERSION}`);
  });
});

describe("update versions", () => {
  test("semver order, releases beat their pre-releases", () => {
    expect(newer("1.5.0", "1.4.0")).toBe(true);
    expect(newer("1.4.10", "1.4.9")).toBe(true);
    expect(newer("1.4.0", "1.4.0")).toBe(false);
    expect(newer("1.4.0", "1.5.0")).toBe(false);
    expect(newer("2.0.0", "2.0.0-beta.2")).toBe(true);
    expect(newer("2.0.0-beta.10", "2.0.0-beta.2")).toBe(true);
    expect(newer("0.1.0", "dev")).toBe(true);
  });
});

describe("setup against a checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "pr-bunny-setup-"));
  const setup = (async () => {
    mkdirSync(join(root, ".claude", "skills", "review-pr"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "review-pr", "SKILL.md"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
    writeFileSync(join(root, "AGENTS.md"), "# agents\n");
    await $`git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm init && git remote add origin git@github.com:acme/widgets.git`.cwd(root).quiet();
    // Not committed: setup reads the default branch, not the working tree.
    writeFileSync(join(root, "REVIEWING.md"), "uncommitted\n");
  })();

  test("resolves a folder inside a checkout to its repo", async () => {
    await setup;
    mkdirSync(join(root, "sub"), { recursive: true });
    const r = await resolveRepo(join(root, "sub"));
    expect(r.repo).toBe("acme/widgets");
    expect(r.branch).toBe("main");
    await expect(resolveRepo(tmpdir())).rejects.toThrow(/git repository/);
    await expect(resolveRepo("/does/not/exist")).rejects.toThrow(/isn't a folder/);
  });

  test("lists skills and previews from the default branch only", async () => {
    await setup;
    const s = await repoSkills("acme/widgets", root);
    expect(s.branch).toBe("main");
    expect(s.suggested).toBe(".claude/skills/review-pr/SKILL.md");
    // AGENTS.md here has no review section, so it isn't a candidate.
    expect(s.candidates.map((c) => c.path)).toEqual([".claude/skills/review-pr/SKILL.md"]);
    const p = await previewSkill(root, ".claude/skills/review-pr/SKILL.md");
    expect(p.lines).toHaveLength(20);
    expect(p.truncated).toBe(true);
    await expect(previewSkill(root, "REVIEWING.md")).rejects.toThrow(/default branch/);
    expect(await searchFiles(root, "agents")).toEqual(["AGENTS.md"]);
  });
});
