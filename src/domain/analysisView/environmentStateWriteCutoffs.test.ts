import { expect, it } from "vitest";
import {
  isParam,
  rootOf,
  type StateRecordFacts,
} from "./environmentStateRules.js";
import { offsetDateTimeInstantFromEpochMilliseconds } from "../offsetDateTime.js";
import { StateWriteCutoffs } from "./environmentStateWriteCutoffs.js";

const write = (
  path: string,
  ordinal: number,
  start = ordinal,
): StateRecordFacts => ({
  path,
  ordinal,
  method: "POST",
  query: undefined,
  status: 200,
  timing: {
    start: {
      instant: offsetDateTimeInstantFromEpochMilliseconds(start),
      ms: start,
    },
    end: offsetDateTimeInstantFromEpochMilliseconds(start),
    endMs: start,
  },
});

it("matches prefix and parameter semantics against an independent linear oracle", () => {
  const bases = new Map([
    ["api", 8],
    ["other", 8],
  ]);
  const writes = [
    write("/api/a", 0, 4),
    write("/api/b/c", 1, 2),
    write("/api/{owner}/d", 2, 3),
    write("/other/x", 3, 5),
    write("/api/a/{item}/e", 4, 1),
    write("", 5, 6),
  ];
  const patterns: string[][] = [[]];
  let level: string[][] = [[]];
  for (let depth = 0; depth < 4; depth += 1) {
    level = level.flatMap((prefix) =>
      ["api", "a", "b", "d", "{key}"].map((segment) => [...prefix, segment]),
    );
    patterns.push(...level);
  }
  for (const selection of [
    writes,
    writes.slice(0, -1),
    [...writes].reverse(),
  ]) {
    const index = new StateWriteCutoffs(
      selection,
      bases,
      (a, b) => a.timing.start!.ms < b.timing.start!.ms,
      () => {},
    );
    const chronological = [...selection]
      .sort((a, b) => a.timing.start!.ms - b.timing.start!.ms)
      .map((record) => ({ record, candidate: rootOf(record.path, bases) }));
    for (const root of patterns) {
      const expected = chronological.find(({ candidate }) => {
        const shared = Math.min(root.length, candidate.length);
        return Array.from({ length: shared }, (_, i) => i).every(
          (i) =>
            root[i] === candidate[i] ||
            isParam(root[i]!) ||
            isParam(candidate[i]!),
        );
      });
      expect(index.first(root), JSON.stringify(root)).toBe(expected?.record);
    }
  }
});

it("handles deep roots iteratively within admitted storage", () => {
  const root = ["api", ...Array<string>(12_000).fill("a")];
  const record = write(`/${root.join("/")}`, 1);
  let admitted = 0;
  const index = new StateWriteCutoffs(
    [record],
    new Map([["api", root.length]]),
    () => false,
    (bytes) => {
      admitted += bytes;
      if (admitted > 16 * 1024 * 1024)
        throw new Error("Test storage budget exceeded");
    },
  );
  expect(index.first(root)).toBe(record);
  expect(index.first(["other"])).toBeUndefined();
});
