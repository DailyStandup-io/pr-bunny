import { expect, test } from "bun:test";
import { MAX_PRS, parseReviewArgs } from "./review";

test("--pr repeats and takes comma lists, without duplicates", () => {
  expect(parseReviewArgs(["--pr", "12,#13", "--pr", "14", "--pr", "12"]).prs).toEqual([12, 13, 14]);
});

test("--deep and --no-open", () => {
  const o = parseReviewArgs(["--pr", "7", "--deep", "--no-open"]);
  expect(o).toMatchObject({ prs: [7], deep: true, open: false });
});

test("several PRs can't combine with --stack, --rerun or a branch", () => {
  expect(() => parseReviewArgs(["--pr", "1,2", "--stack"])).toThrow("--stack");
  expect(() => parseReviewArgs(["--pr", "1", "--pr", "2", "--rerun"])).toThrow("--rerun");
  expect(() => parseReviewArgs(["main", "--pr", "1,2"])).toThrow("a branch");
  expect(() => parseReviewArgs(["--pr", "1,x"])).toThrow("PR number");
});

test(`at most ${MAX_PRS} PRs at once`, () => {
  const list = Array.from({ length: MAX_PRS + 1 }, (_, i) => i + 1).join(",");
  expect(() => parseReviewArgs(["--pr", list])).toThrow(`At most ${MAX_PRS}`);
});
