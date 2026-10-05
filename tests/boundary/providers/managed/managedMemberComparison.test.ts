import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import {
  compareManagedMembersEvidenceValidated,
  compareManagedMemberPaths,
} from "../../../../src/application/ManagedMemberComparisonService.js";
import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { managedMemberComparisonResultSchema } from "../../../../src/domain/managedMemberComparison.js";
import { createEvidence } from "../../../../src/domain/evidence.js";
import { jsonValueSchema } from "../../../../src/domain/jsonValue.js";
import { compareManagedMembersInputSchema } from "../../../../src/domain/managedMemberComparison.js";
import { inspectManagedMembersBytes } from "../../../../src/dotnet/ManagedMemberInspector.js";
import { managedPeFixtureTarget } from "../../../../src/dotnet/ManagedPe.fixture.js";
import { buildManagedPeFixture } from "../../../../src/dotnet/ManagedPe.fixture.js";

describe("managed member comparison path workflow", () => {
  it("preserves undecoded signatures as unknown through content-addressed partial Evidence", () => {
    const observe = (signature: number, path: string) => {
      const bytes = buildManagedPeFixture({
        methodSignature: Buffer.from([signature]),
      });
      const target = managedPeFixtureTarget(bytes, path);
      const inspection = inspectManagedMembersBytes(bytes, target);
      return createEvidence(
        target,
        { id: "partial-fixture", name: "Partial fixture", version: "1" },
        {
          operation: "inspect_managed_members",
          parameters: {},
          result: jsonValueSchema.parse({
            ...inspection,
            coverage: { ...inspection.coverage, state: "partial" },
          }),
          confidence: "observed",
          authority: "shipped-artifact",
        },
      );
    };
    const input = compareManagedMembersInputSchema.parse({
      left: observe(0xff, "/tmp/partial-left.dll"),
      right: observe(0xfe, "/tmp/partial-right.dll"),
    });
    const result = compareManagedMembersEvidenceValidated(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const comparison = managedMemberComparisonResultSchema.parse(
      result.value.normalized_result,
    );
    expect(comparison.coverage.status).toBe("partial");
    expect(comparison.matching.structural_method_shape).toBe(0);
    expect(comparison.methods).toHaveLength(2);
    expect(
      comparison.methods.every(
        ({ status, match }) =>
          status === "unknown" && match.status === "unmatched",
      ),
    ).toBe(true);
  });

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

  it("rejects a file that changes after target identity is resolved", async () => {
    const directory = await createTestTempDirectory(
      "rea-managed-compare-race-",
    );
    const leftPath = join(directory, "left.dll");
    const rightPath = join(directory, "right.dll");
    await writeFile(leftPath, buildManagedPeFixture());
    await writeFile(rightPath, buildManagedPeFixture());
    const replacement = buildManagedPeFixture({
      methodName: "ChangedAfterOpen",
    });

    const result = await compareManagedMemberPaths(
      { leftPath, rightPath },
      {
        resolveTarget: async (path) => {
          const target = await parseBinaryTarget(path);
          if (target.ok && path === leftPath)
            await writeFile(path, replacement);
          return target;
        },
        readBytes: (path) => readFile(path),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("EvidenceIntegrityError");
    expect(result.error.message).toContain(leftPath);
  });
});
