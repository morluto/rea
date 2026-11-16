import { expect, it } from "vitest";
import type { ProcessTableEntry } from "./ProcessOwnership.js";
import { descendantsOf } from "./ProcessOwnershipProcessTree.js";

const row = (pid: number, parentPid: number): ProcessTableEntry => ({
  pid,
  parentPid,
  processGroupId: 1000,
  state: "S",
  command: "modeled process",
});

it.each([false, true])(
  "retains a wide family with an intermediate parent: %s",
  (nested) => {
    // Synthetic table rows, not launched processes. This adapter project forks
    // with the production main-thread stack, exceeding its argument capacity.
    const children = Array.from({ length: 130_000 }, (_, index) =>
      row(1002 + index, nested ? 1001 : 1000),
    );
    const intermediate = row(1001, 1000);
    const expected = nested ? [intermediate, ...children] : children;
    const table = [row(99, 0), row(1000, 0), ...expected];
    const found = descendantsOf([1000], table);
    expect(found).toHaveLength(expected.length);
    expect(found.every((process, index) => process === expected[index])).toBe(
      true,
    );
    expect(new Set(found.map(({ pid }) => pid)).size).toBe(expected.length);
    expect(found.at(-1)?.pid).toBe(131001);
  },
);

it("keeps breadth-first table order across several parents", () => {
  const table = [
    row(10, 1),
    row(1, 0),
    row(4, 3),
    row(2, 1),
    row(6, 2),
    row(3, 1),
    row(5, 3),
    row(99, 0),
  ];
  expect(descendantsOf([1], table).map(({ pid }) => pid)).toEqual([
    10, 2, 3, 6, 4, 5,
  ]);
});

it("excludes all selected roots and visits repeated or cyclic PIDs once", () => {
  const first = row(3, 2);
  const leaf = row(4, 3);
  const table = Object.freeze([
    row(1, 3),
    row(2, 1),
    first,
    { ...first, command: "later duplicate" },
    leaf,
  ]);
  const found = descendantsOf([1, 2, 1], table);
  expect(found).toEqual([first, leaf]);
  expect(found[0]).toBe(first);
  expect(found[1]).toBe(leaf);
});

it("returns no descendants for empty or unobserved roots", () => {
  const table = [row(1, 0), row(2, 1)];
  expect(descendantsOf([], table)).toEqual([]);
  expect(descendantsOf([99], table)).toEqual([]);
});
