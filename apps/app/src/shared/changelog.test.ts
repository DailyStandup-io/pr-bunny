import { expect, test } from "bun:test";
import { fixesOnly, parseChangelog } from "./changelog";
import changelog from "../../../../CHANGELOG.md" with { type: "text" };

const MD = `# Changelog

## 0.4.1 “Iceberg” — 2026-09-28

### Fixed
- **Self-review failing with \`invalid reference\`.** If copying your
  branch was cut off, Retry failed.

## 0.4.0 “Hay” — 2026-09-26

### Added
- **Merge from PR Bunny.** On your own PRs, a Merge card
  shows what's blocking.
- A plain addition.

### Changed
- Findings: the summary bar stays under the tabs.

### Fixed
- Hidden PRs no longer light the Inbox dot.
`;

test("parses versions, codenames, dates and sections", () => {
  const notes = parseChangelog(MD);
  expect(notes.map((n) => [n.version, n.name, n.date])).toEqual([
    ["0.4.1", "Iceberg", "2026-09-28"],
    ["0.4.0", "Hay", "2026-09-26"],
  ]);
  expect(notes[0]!.fixed).toEqual([{ title: "Self-review failing with `invalid reference`", text: "If copying your branch was cut off, Retry failed." }]);
  expect(notes[1]!.added).toEqual([
    { title: "Merge from PR Bunny", text: "On your own PRs, a Merge card shows what's blocking." },
    { title: null, text: "A plain addition." },
  ]);
  expect(notes[1]!.changed).toHaveLength(1);
  expect(fixesOnly(notes[0]!)).toBe(true);
  expect(fixesOnly(notes[1]!)).toBe(false);
});

test("the real CHANGELOG.md parses, newest first, every release with something in it", () => {
  const notes = parseChangelog(changelog);
  expect(notes.length).toBeGreaterThan(3);
  for (const n of notes) {
    expect(n.name).not.toBe("");
    expect(n.added.length + n.changed.length + n.fixed.length).toBeGreaterThan(0);
  }
});
