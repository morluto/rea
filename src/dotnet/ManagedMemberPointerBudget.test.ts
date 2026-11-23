import { expect, it, vi } from "vitest";

import {
  attachManagedDecodeBudget,
  ManagedDecodeBudget,
} from "../domain/managed/managedDecodeBudget.js";
import { memberListRowLookup } from "../domain/managed/managedMemberPointers.js";
import { readManagedMetadataLayout } from "../domain/managed/managedMetadataLayout.js";
import { buildManagedMemberPointerFixture } from "./ManagedPe.fixture.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";
import { ManagedReaderFailure } from "../domain/managed/managedReaderFailure.js";

const pointerFixture = () => {
  const bytes = buildManagedMemberPointerFixture();
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture has no CLI metadata");
  const layout = readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "cli.metadata"),
    pe.cli.metadata.size,
  );
  // A fresh owner lets the test set exact remaining capacity independently of
  // the metadata version/string admission already exercised by the parser.
  const budget = new ManagedDecodeBudget();
  attachManagedDecodeBudget(layout, budget);
  // Two MethodDef rows and the zero sentinel need three uint32 slots.
  return { bytes, layout, budget, indexBytes: 3 * 4 + 256 };
};

it.each([
  ["one byte short", 1, 0],
  ["exact capacity", 0, 1],
] as const)(
  "constructs the inverse pointer index at %s",
  (_label, shortfall, expectedAllocations) => {
    const { bytes, layout, budget, indexBytes } = pointerFixture();
    budget.reserve(budget.maximumBytes - indexBytes + shortfall, null);
    const lookup = () => memberListRowLookup(bytes, layout, 6);
    let allocations = 0;
    // Forward static width facts too so invalid allocation setup cannot pass as refusal.
    vi.stubGlobal(
      "Uint32Array",
      new Proxy(Uint32Array, {
        construct(target, args, newTarget) {
          allocations++;
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    try {
      if (shortfall === 1) {
        expect(lookup).toThrow(
          expect.objectContaining({
            issue: expect.objectContaining({
              code: "resource-limit",
              scope: "metadata.representation",
              offset: layout.table(5)?.offset,
            }),
          }),
        );
      } else {
        for (const read of [lookup(), lookup()])
          expect([read(1), read(2)]).toEqual([2, 1]);
        expect(() => budget.reserve(1, null)).toThrow(ManagedReaderFailure);
      }
      expect(allocations).toBe(expectedAllocations);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
