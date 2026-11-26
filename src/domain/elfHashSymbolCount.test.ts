import { expect, it } from "vitest";
import {
  readElfGnuHashSymbolCount,
  readElfGnuHashSymbolCountSteps,
  readElfHashSymbolCount,
  readElfHashSymbolCountSteps,
  type ElfGnuHashCountWalk,
  type ElfHashWordReader,
} from "./elfHashSymbolCount.js";
import { err, ok } from "./result.js";

const words =
  (values: readonly number[]): ElfHashWordReader =>
  (offset) => {
    const value = values[offset / 4];
    return value === undefined ? err("is outside the image") : ok(value);
  };

const finish = (walk: ElfGnuHashCountWalk) => {
  for (let step = walk.next(); ; step = walk.next())
    if (step.done === true) return step.value;
};

/** nbuckets, symoffset, bloom words, shift, one 8-byte bloom word, buckets, chain. */
const gnuTable = (
  buckets: readonly number[],
  chain: readonly number[],
  firstSymbol = 2,
) => [buckets.length, firstSymbol, 1, 0, 0, 0, ...buckets, ...chain];

it("reads nchain from a complete DT_HASH table", () => {
  expect(readElfHashSymbolCount(words([1, 3, 0, 0, 0, 0]))).toEqual(ok(3));
  expect(readElfHashSymbolCount(words([1]))).toEqual(
    err({
      kind: "malformed",
      message: expect.stringMatching(/DT_HASH header.*outside/iu),
    }),
  );
  expect(readElfHashSymbolCount(words([1, 3, 0]))).toEqual(
    err({
      kind: "malformed",
      message: expect.stringMatching(/DT_HASH table.*outside/iu),
    }),
  );
  expect(readElfHashSymbolCount(words([1, 9]), 8)).toEqual(
    err({ kind: "budget", label: "DT_HASH symbol table", count: 9 }),
  );
});

it("follows the last DT_GNU_HASH chain to its end", () => {
  expect(
    finish(readElfGnuHashSymbolCount(words(gnuTable([2, 3], [0, 0, 1])), 8)),
  ).toEqual(ok(5));
  expect(
    finish(readElfGnuHashSymbolCount(words(gnuTable([0], [])), 8)),
  ).toEqual(ok(null));
  const narrow = [1, 1, 1, 0, 0, 1, 1];
  expect(finish(readElfGnuHashSymbolCount(words(narrow), 4))).toEqual(ok(2));
});

it("rejects DT_GNU_HASH tables that do not describe a chain", () => {
  const malformed = (values: readonly number[], reason: RegExp) =>
    expect(finish(readElfGnuHashSymbolCount(words(values), 8))).toEqual(
      err({ kind: "malformed", message: expect.stringMatching(reason) }),
    );
  malformed([1, 2, 1], /header.*outside/iu);
  malformed([0, 2, 1, 0], /buckets.*malformed/iu);
  malformed([1, 2, 0, 0], /buckets.*malformed/iu);
  malformed([1, 2, 1, 0, 0, 0], /buckets.*outside/iu);
  malformed(gnuTable([1], [1]), /bucket.*precedes.*symbol/iu);
  malformed(gnuTable([2], [0]), /chain.*outside/iu);
});

it("applies a caller budget before walking each table", () => {
  const budget = (values: readonly number[], maximum: number) =>
    finish(readElfGnuHashSymbolCount(words(values), 8, maximum));
  expect(budget([9, 0, 1, 0], 8)).toEqual(
    err({ kind: "budget", label: "DT_GNU_HASH bucket table", count: 9 }),
  );
  expect(budget([1, 0, 9, 0], 8)).toEqual(
    err({ kind: "budget", label: "DT_GNU_HASH bloom filter", count: 9 }),
  );
  expect(budget([1, 9, 1, 0], 8)).toEqual(
    err({ kind: "budget", label: "DT_GNU_HASH symbol index", count: 9 }),
  );
  expect(budget(gnuTable([2], [0, 0, 0, 1]), 3)).toEqual(
    err({
      kind: "budget",
      label: "DT_GNU_HASH symbol table",
      count: 4,
      // The chain walk stops at the budget, so 4 is a lower bound.
      lowerBound: true,
    }),
  );
});

it("yields between bounded steps so a driver can stop a long walk", () => {
  const walk = readElfGnuHashSymbolCount(words(gnuTable([2], [1])), 8);
  expect(walk.next().done).toBe(false);
});

it("labels end-of-table bounds probes explicitly for streaming drivers", () => {
  const gnuSteps = readElfGnuHashSymbolCountSteps(8);
  const gnuReader = words(gnuTable([2, 3], [0, 0, 1]));
  const gnuProbes: unknown[] = [];
  let gnuNext = gnuSteps.next();
  while (!gnuNext.done) {
    const step = gnuNext.value;
    if (step === undefined) gnuNext = gnuSteps.next(ok(0));
    else if (typeof step === "object") {
      gnuProbes.push(step);
      gnuNext = gnuSteps.next(ok(0));
    } else gnuNext = gnuSteps.next(gnuReader(step));
  }
  expect(gnuProbes).toEqual([{ kind: "bounds", offset: 28 }]);
  expect(gnuNext.value).toEqual(ok(5));

  const hashSteps = readElfHashSymbolCountSteps();
  const hashReader = words([1, 3, 0, 0, 0, 0]);
  const hashProbes: unknown[] = [];
  let hashNext = hashSteps.next();
  while (!hashNext.done) {
    const step = hashNext.value;
    if (typeof step === "object") {
      hashProbes.push(step);
      hashNext = hashSteps.next(ok(0));
    } else hashNext = hashSteps.next(hashReader(step));
  }
  expect(hashProbes).toEqual([{ kind: "bounds", offset: 20 }]);
  expect(hashNext.value).toEqual(ok(3));
});
