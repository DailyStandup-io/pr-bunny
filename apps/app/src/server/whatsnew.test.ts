import { expect, test } from "bun:test";
import type { ReleaseNotes } from "../shared/changelog";
import { unseenVersions } from "./whatsnew";

const rel = (version: string): ReleaseNotes => ({ version, name: "", date: null, added: [], changed: [], fixed: [] });
const NOTES = ["0.5.0", "0.4.1", "0.4.0", "0.3.2", "0.3.1"].map(rel);

test("after updating: every version since the last one seen, newest first", () => {
  expect(unseenVersions(NOTES, "0.4.1", "0.3.1", true)).toEqual(["0.4.1", "0.4.0", "0.3.2"]);
  expect(unseenVersions(NOTES, "0.4.0", "0.3.2", true)).toEqual(["0.4.0"]);
});

test("nothing when seen, downgraded, or running from source", () => {
  expect(unseenVersions(NOTES, "0.4.1", "0.4.1", true)).toEqual([]);
  expect(unseenVersions(NOTES, "0.4.0", "0.4.1", true)).toEqual([]);
  expect(unseenVersions(NOTES, "dev", "0.4.1", true)).toEqual([]);
});

test("no record: a fresh install sees nothing, an older install sees this version", () => {
  expect(unseenVersions(NOTES, "0.4.1", null, false)).toEqual([]);
  expect(unseenVersions(NOTES, "0.4.1", null, true)).toEqual(["0.4.1"]);
});
