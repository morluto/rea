import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { compareManagedMemberPaths } from "../../../../src/application/ManagedMemberComparisonService.js";
import { managedMemberComparisonResultSchema } from "../../../../src/domain/managedMemberComparison.js";
import {
  buildManagedPeFixture,
  MANAGED_MEMBER_PATH_FIXTURE_LIMITS,
} from "../../../../src/dotnet/ManagedPe.fixture.js";

describe("managed member comparison path workflow", () => {
  it("compares two local paths and returns derived Evidence", async () => {
    const directory = await createTestTempDirectory("rea-managed-compare-");
    const leftPath = join(directory, "left.dll");
    const rightPath = join(directory, "right.dll");
    await writeFile(leftPath, buildManagedPeFixture());
    await writeFile(
      rightPath,
      buildManagedPeFixture({ methodName: "Renamed" }),
    );

    const result = await compareManagedMemberPaths({
      leftPath,
      rightPath,
      memberLimits: MANAGED_MEMBER_PATH_FIXTURE_LIMITS,
      comparisonLimits: {
        max_method_matches: 100,
        max_field_matches: 100,
        max_candidates: 10,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      operation: "compare_managed_members",
      confidence: "inferred",
      authority: "analyst-inference",
    });
    expect(
      managedMemberComparisonResultSchema.parse(result.value.normalized_result)
        .matching.exact_il_signature,
    ).toBe(1);
  });
});
