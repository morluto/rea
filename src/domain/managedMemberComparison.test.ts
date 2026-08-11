import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  compareManagedMembers,
  managedMemberComparisonResultSchema,
} from "./managedMemberComparison.js";
import { inspectManagedMembersBytes } from "../dotnet/ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
  MANAGED_MEMBER_FIXTURE_LIMITS,
} from "../dotnet/ManagedPe.fixture.js";

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
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
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
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
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

  it("rejects member states that disagree with their observed sides or match", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left.dll");
    const right = inspect(buildManagedPeFixture(), "/tmp/right.dll");
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
      comparisonLimits,
    );
    const method = result.methods[0];
    expect(method).toBeDefined();
    if (method === undefined) return;

    expect(
      managedMemberComparisonResultSchema.safeParse({
        ...result,
        methods: [{ ...method, status: "unchanged", right: null }],
      }).success,
    ).toBe(false);
    expect(
      managedMemberComparisonResultSchema.safeParse({
        ...result,
        methods: [
          {
            ...method,
            match: {
              ...method.match,
              basis: "none",
              confidence: "unknown",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("does not match identical instruction-limited method prefixes", () => {
    const limited = {
      ...MANAGED_MEMBER_FIXTURE_LIMITS,
      maxMethodInstructions: 1,
    };
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
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
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
});

describe("managed member comparison uncertainty", () => {
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
      { evidenceId: left.evidenceId, result: leftPartial },
      { evidenceId: right.evidenceId, result: rightPartial },
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
      { evidenceId: left.evidenceId, result: duplicatedLeft },
      { evidenceId: right.evidenceId, result: duplicatedRight },
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
});

const inspect = (
  bytes: Buffer,
  path: string,
  limits: typeof MANAGED_MEMBER_FIXTURE_LIMITS = MANAGED_MEMBER_FIXTURE_LIMITS,
) => {
  const target = managedPeFixtureTarget(bytes, path);
  const result = inspectManagedMembersBytes(bytes, target, limits);
  return {
    result,
    evidenceId: `ev_${hash(Buffer.from(path))}`,
  };
};

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
