import { createHash } from "node:crypto";

import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import {
  assessManagedGraphOmissions,
  managedGraphEvidenceCoverage,
  totalManagedGraphOmitted,
  type ManagedGraphProjectionLimits,
} from "../src/domain/managedApplicationGraphCoverage.js";
import {
  assessKnownPageCoverage,
  type KnownCollectionPage,
} from "../src/domain/knownPageCoverage.js";
import { inspectManagedMembersBytes } from "../src/dotnet/ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "../src/dotnet/ManagedNativeBoundaryInspector.js";
import { buildManagedPeFixture } from "./fixtures/managedPe.js";

const MEMBER_LIMITS = {
  typeOffset: 0,
  typeLimit: 100,
  methodOffset: 0,
  methodLimit: 100,
  fieldOffset: 0,
  fieldLimit: 100,
  memberRefOffset: 0,
  memberRefLimit: 100,
  edgeOffset: 0,
  edgeLimit: 100,
  instructionAnchorLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
  maxMethodBodyBytes: 1024 * 1024,
  maxMethodInstructions: 1_000,
};

const BOUNDARY_LIMITS = {
  moduleRefOffset: 0,
  moduleRefLimit: 100,
  importOffset: 0,
  importLimit: 100,
  implementationOffset: 0,
  implementationLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

const limitPair = fc
  .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 12 }))
  .map(
    ([first, second]) =>
      [Math.min(first, second), Math.max(first, second)] as const,
  );

describe("coverage monotonicity", () => {
  it.prop([fc.integer({ min: 0, max: 200 }), limitPair])(
    "never makes a smaller source page more complete",
    (total, [smallerLimit, largerLimit]) => {
      const smaller = assessKnownPageCoverage(sourcePage(total, smallerLimit));
      const larger = assessKnownPageCoverage(sourcePage(total, largerLimit));

      expect(smaller.includedCount).toBeLessThanOrEqual(larger.includedCount);
      expect(smaller.omittedCount).toBeGreaterThanOrEqual(larger.omittedCount);
      expect(smaller.sourceOmittedCount).toBeGreaterThanOrEqual(
        larger.sourceOmittedCount,
      );
      if (smaller.complete) expect(larger.complete).toBe(true);
    },
  );

  it.prop([fc.integer({ min: 0, max: 200 }), limitPair])(
    "never makes a smaller downstream projection more complete",
    (total, [smallerLimit, largerLimit]) => {
      const page = sourcePage(total, Math.max(1, total));
      const smaller = assessKnownPageCoverage(page, smallerLimit);
      const larger = assessKnownPageCoverage(page, largerLimit);

      expect(smaller.includedCount).toBeLessThanOrEqual(larger.includedCount);
      expect(smaller.omittedCount).toBeGreaterThanOrEqual(larger.omittedCount);
      expect(smaller.sourceComplete).toBe(larger.sourceComplete);
      if (smaller.complete) expect(larger.complete).toBe(true);
    },
  );

  it.prop([
    fc.array(fc.integer({ min: 0, max: 12 }), {
      minLength: 5,
      maxLength: 5,
    }),
    fc.array(limitPair, { minLength: 5, maxLength: 5 }),
  ])(
    "does not improve aggregate managed graph coverage when projection limits shrink",
    (totals, pairs) => {
      const sources = managedSources(totals);
      const smaller = assessManagedGraphOmissions(
        sources,
        graphLimits(pairs, 0),
      );
      const larger = assessManagedGraphOmissions(
        sources,
        graphLimits(pairs, 1),
      );
      const smallerCoverage = managedGraphEvidenceCoverage(smaller);
      const largerCoverage = managedGraphEvidenceCoverage(larger);

      expect(totalManagedGraphOmitted(smaller)).toBeGreaterThanOrEqual(
        totalManagedGraphOmitted(larger),
      );
      expect(smaller.types).toBeGreaterThanOrEqual(larger.types);
      expect(smaller.methods).toBeGreaterThanOrEqual(larger.methods);
      expect(smaller.fields).toBeGreaterThanOrEqual(larger.fields);
      expect(smaller.pinvokeImports).toBeGreaterThanOrEqual(
        larger.pinvokeImports,
      );
      expect(smaller.nativeImplementations).toBeGreaterThanOrEqual(
        larger.nativeImplementations,
      );
      if (smallerCoverage.status === "complete")
        expect(largerCoverage.status).toBe("complete");
    },
  );

  it("does not let wider projection limits repair parser-unknown input", () => {
    const sources = managedSources([2, 2, 2, 2, 2]);
    const partialSources = {
      ...sources,
      members: {
        ...sources.members,
        coverage: {
          state: "partial" as const,
          issues: [
            {
              code: "limit-exceeded" as const,
              scope: "method.0x06000001.body.instructions",
              offset: 0x0a00,
              detail: "instruction limit reached",
            },
          ],
        },
      },
    };
    const narrow = managedGraphEvidenceCoverage(
      assessManagedGraphOmissions(partialSources, constantGraphLimits(1)),
    );
    const wide = managedGraphEvidenceCoverage(
      assessManagedGraphOmissions(partialSources, constantGraphLimits(100)),
    );

    expect(narrow).toMatchObject({
      status: "partial",
      truncated: false,
      omitted_count: null,
    });
    expect(wide).toEqual(narrow);
  });
});

const sourcePage = (
  total: number,
  limit: number,
): KnownCollectionPage<number> => {
  const returned = Math.min(total, limit);
  return {
    items: Array.from({ length: returned }, (_, index) => index),
    offset: 0,
    limit,
    total,
    returned,
    complete: returned === total,
  };
};

const fixtureBytes = buildManagedPeFixture({
  pinvoke: {
    moduleName: "user32.dll",
    importName: "MessageBoxW",
    mappingFlags: 0x0345,
  },
  readyToRun: true,
});
const fixtureTarget: BinaryTarget = {
  path: "/fixture/ManagedCoverage.exe",
  sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  kind: "executable",
  format: "pe",
  architecture: "x86",
  availableArchitectures: ["x86"],
};
const fixtureMembers = inspectManagedMembersBytes(
  fixtureBytes,
  fixtureTarget,
  MEMBER_LIMITS,
);
const fixtureBoundaries = inspectManagedNativeBoundariesBytes(
  fixtureBytes,
  fixtureTarget,
  BOUNDARY_LIMITS,
);

const managedSources = (totals: readonly number[]) => ({
  artifact: null,
  members: {
    ...fixtureMembers,
    types: repeatPage(fixtureMembers.types, totals[0] ?? 0),
    methods: repeatPage(fixtureMembers.methods, totals[1] ?? 0),
    fields: repeatPage(fixtureMembers.fields, totals[2] ?? 0),
  },
  boundaries: {
    ...fixtureBoundaries,
    pinvoke_imports: repeatPage(
      fixtureBoundaries.pinvoke_imports,
      totals[3] ?? 0,
    ),
    native_implementations: repeatPage(
      fixtureBoundaries.native_implementations,
      totals[4] ?? 0,
    ),
  },
});

const repeatPage = <Item, Page extends KnownCollectionPage<Item>>(
  page: Page,
  total: number,
) => {
  const first = page.items[0];
  const items =
    first === undefined ? [] : Array.from({ length: total }, () => first);
  return {
    ...page,
    items,
    offset: 0,
    limit: Math.max(1, total),
    total,
    returned: total,
    complete: true,
  };
};

const graphLimits = (
  pairs: readonly (readonly [number, number])[],
  index: 0 | 1,
): ManagedGraphProjectionLimits => ({
  max_types: pairs[0]?.[index] ?? 1,
  max_methods: pairs[1]?.[index] ?? 1,
  max_fields: pairs[2]?.[index] ?? 1,
  max_pinvoke_imports: pairs[3]?.[index] ?? 1,
  max_native_implementations: pairs[4]?.[index] ?? 1,
});

const constantGraphLimits = (value: number): ManagedGraphProjectionLimits => ({
  max_types: value,
  max_methods: value,
  max_fields: value,
  max_pinvoke_imports: value,
  max_native_implementations: value,
});
