import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { compareManagedMemberPaths } from "../src/application/ManagedMemberComparisonService.js";
import { MANAGED_STATIC_PROVIDER } from "../src/application/InvestigationProviders.js";
import {
  compareManagedMembers,
  managedMemberComparisonResultSchema,
} from "../src/domain/managedMemberComparison.js";
import { createEvidence } from "../src/domain/evidence.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { inspectManagedMembersBytes } from "../src/dotnet/ManagedMemberInspector.js";
import { buildManagedPeFixture } from "./fixtures/managedPe.js";

const memberLimits = {
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

const pathMemberLimits = {
  ...memberLimits,
  maxFileBytes: 1024 * 1024,
};

const comparisonLimits = {
  max_method_matches: 100,
  max_field_matches: 100,
  max_candidates: 10,
};

describe("managed member comparison", () => {
  it("remaps renamed methods by exact CIL/signature without using names", () => {
    const leftBytes = buildManagedPeFixture();
    const rightBytes = buildManagedPeFixture({
      mvid: Buffer.from("00112233445566778899aabbccddeefe", "hex"),
      typeName: "A",
      typeNamespace: "X",
      methodName: "b",
      fieldName: "c",
    });
    const left = inspect(leftBytes, "/tmp/left.dll");
    const right = inspect(rightBytes, "/tmp/right.dll");
    const result = compareManagedMembers(
      { evidenceId: left.evidence.evidence_id, result: left.result },
      { evidenceId: right.evidence.evidence_id, result: right.result },
      comparisonLimits,
    );

    expect(result.algorithm.name_matching).toBe("not-used");
    expect(result.left.mvid).toBe("00112233-4455-6677-8899-aabbccddeeff");
    expect(result.right.mvid).toBe("33221100-5544-7766-8899-aabbccddeefe");
    expect(result.matching.exact_il_signature).toBe(1);
    expect(result.methods).toEqual([
      expect.objectContaining({
        status: "unchanged",
        left: expect.objectContaining({ token: "0x06000001", name: "Main" }),
        right: expect.objectContaining({ token: "0x06000001", name: "b" }),
        match: expect.objectContaining({
          status: "matched",
          basis: "exact-il-signature",
          confidence: "exact",
        }),
        dimensions: [],
      }),
    ]);
    expect(result.limitations).toContain(
      "Names are reported as observations but are not used as a matching basis.",
    );
  });

  it("uses structural method shape when build-local token operands drift", () => {
    const leftBytes = buildManagedPeFixture();
    const rightBytes = buildManagedPeFixture({
      ilBody: Buffer.from([
        0x32, 0x02, 0x7b, 0x02, 0x00, 0x00, 0x04, 0x28, 0x02, 0x00, 0x00, 0x0a,
        0x2a,
      ]),
    });
    const left = inspect(leftBytes, "/tmp/left.dll");
    const right = inspect(rightBytes, "/tmp/right.dll");
    const result = compareManagedMembers(
      { evidenceId: left.evidence.evidence_id, result: left.result },
      { evidenceId: right.evidence.evidence_id, result: right.result },
      comparisonLimits,
    );

    expect(result.matching.exact_il_signature).toBe(0);
    expect(result.matching.structural_method_shape).toBe(1);
    expect(result.methods[0]).toMatchObject({
      status: "changed",
      match: { status: "matched", basis: "structural-method-shape" },
      dimensions: ["cil"],
    });
  });

  it("does not match identical instruction-limited method prefixes", () => {
    const limited = { ...memberLimits, maxMethodInstructions: 1 };
    const left = inspect(
      buildManagedPeFixture(),
      "/tmp/left-partial.dll",
      limited,
    );
    const right = inspect(
      buildManagedPeFixture(),
      "/tmp/right-partial.dll",
      limited,
    );
    const result = compareManagedMembers(
      { evidenceId: left.evidence.evidence_id, result: left.result },
      { evidenceId: right.evidence.evidence_id, result: right.result },
      comparisonLimits,
    );

    expect(result.matching.exact_il_signature).toBe(0);
    expect(result.matching.structural_method_shape).toBe(0);
    expect(result.coverage).toMatchObject({
      status: "partial",
      left_status: "partial",
      right_status: "partial",
    });
  });

  it("keeps unmatched members unknown when the opposite page is incomplete", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left-paged.dll");
    const right = inspect(buildManagedPeFixture(), "/tmp/right-paged.dll");
    const leftPartial = {
      ...left.result,
      fields: {
        ...left.result.fields,
        items: [],
        returned: 0,
        dropped: 1,
        complete: false,
      },
    };
    const rightPartial = {
      ...right.result,
      methods: {
        ...right.result.methods,
        items: [],
        returned: 0,
        dropped: 1,
        complete: false,
      },
    };
    const result = compareManagedMembers(
      { evidenceId: left.evidence.evidence_id, result: leftPartial },
      { evidenceId: right.evidence.evidence_id, result: rightPartial },
      comparisonLimits,
    );

    expect(result.summary).toMatchObject({
      added: 0,
      removed: 0,
      unknown: 2,
    });
    expect(result.methods[0]).toMatchObject({
      status: "unknown",
      left: { token: "0x06000001" },
      right: null,
      limitations: [expect.stringContaining("unknown-within-unobserved-page")],
    });
    expect(result.fields[0]).toMatchObject({
      status: "unknown",
      left: null,
      right: { token: "0x04000001" },
      limitations: [expect.stringContaining("unknown-within-unobserved-page")],
    });
    expect(result.coverage).toEqual({
      status: "truncated",
      left_status: "partial",
      right_status: "partial",
      omitted_methods: 1,
      omitted_fields: 1,
      omitted_candidates: 0,
    });
  });

  it("does not guess ambiguous field signature matches", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left.dll");
    const leftField = left.result.fields.items[0];
    expect(leftField).toBeDefined();
    if (leftField === undefined) return;
    const duplicatedLeft = {
      ...left.result,
      fields: {
        ...left.result.fields,
        items: [
          leftField,
          {
            ...leftField,
            token: "0x04000002",
            name: "other",
          },
        ],
        total: 2,
        returned: 2,
      },
    };
    const right = inspect(buildManagedPeFixture(), "/tmp/right.dll");
    const rightField = right.result.fields.items[0];
    expect(rightField).toBeDefined();
    if (rightField === undefined) return;
    const duplicatedRight = {
      ...right.result,
      fields: {
        ...right.result.fields,
        items: [
          rightField,
          {
            ...rightField,
            token: "0x04000002",
            name: "renamed",
          },
        ],
        total: 2,
        returned: 2,
      },
    };
    const result = compareManagedMembers(
      { evidenceId: left.evidence.evidence_id, result: duplicatedLeft },
      { evidenceId: right.evidence.evidence_id, result: duplicatedRight },
      comparisonLimits,
    );

    expect(result.matching.ambiguous).toBe(1);
    expect(result.fields).toEqual([
      expect.objectContaining({
        status: "unknown",
        match: expect.objectContaining({
          status: "ambiguous",
          basis: "field-signature",
          candidate_left_tokens: ["0x04000001", "0x04000002"],
          candidate_right_tokens: ["0x04000001", "0x04000002"],
        }),
      }),
    ]);
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
      memberLimits: pathMemberLimits,
      comparisonLimits,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.operation).toBe("compare_managed_members");
    expect(result.value.confidence).toBe("inferred");
    expect(result.value.authority).toBe("analyst-inference");
    expect(
      managedMemberComparisonResultSchema.parse(result.value.normalized_result)
        .matching.exact_il_signature,
    ).toBe(1);
  });
});

const inspect = (
  bytes: Buffer,
  path: string,
  limits: typeof memberLimits = memberLimits,
) => {
  const target: BinaryTarget = {
    path,
    sha256: hash(bytes),
    kind: "executable",
    format: "pe",
    architecture: "x86",
  };
  const result = inspectManagedMembersBytes(bytes, target, limits);
  return {
    result,
    evidence: createEvidence(target, MANAGED_STATIC_PROVIDER, {
      operation: "inspect_managed_members",
      parameters: {},
      result,
      rawResult: null,
      limitations: result.limitations,
    }),
  };
};

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
