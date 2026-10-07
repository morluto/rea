import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  compareManagedMembers,
  managedMemberComparisonResultSchema,
} from "../../../../src/domain/managedMemberComparison.js";
import { inspectManagedMembersBytes } from "../../../../src/dotnet/ManagedMemberInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "../../../../src/dotnet/ManagedPe.fixture.js";

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
    );

    expect(result.algorithm.name_matching).toBe("exact-signature-fallback");
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
      "Methods pair by exact CIL/signature, then declared type, name, and signature, then structural shape; names alone are never a matching basis.",
    );
    expect(
      managedMemberComparisonResultSchema.safeParse({
        ...result,
        limitations: Array.from({ length: 101 }, () => "x".repeat(4_097)),
      }).success,
    ).toBe(true);
  });

  it("compares changed CIL after pairing by exact signature", () => {
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
    );

    expect(result.matching.exact_il_signature).toBe(0);
    expect(result.matching.exact_signature).toBe(1);
    expect(result.methods[0]).toMatchObject({
      status: "changed",
      match: { status: "matched", basis: "exact-signature" },
      dimensions: ["cil"],
    });
  });

  it("rejects member states that disagree with their observed sides or match", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left.dll");
    const right = inspect(buildManagedPeFixture(), "/tmp/right.dll");
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: left.result },
      { evidenceId: right.evidenceId, result: right.result },
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
});

describe("managed member comparison uncertainty", () => {
  it("does not infer a structural method match from undecoded signature fields", () => {
    const left = inspect(
      buildManagedPeFixture({ methodSignature: Buffer.from([0xff]) }),
      "/tmp/unknown-left.dll",
    );
    const right = inspect(
      buildManagedPeFixture({ methodSignature: Buffer.from([0xfe]) }),
      "/tmp/unknown-right.dll",
    );
    expect(left.result.methods[0]?.signature.parse_status).not.toBe("decoded");
    expect(right.result.methods[0]?.signature.parse_status).not.toBe("decoded");
    const result = compareManagedMembers(
      {
        evidenceId: left.evidenceId,
        result: {
          ...left.result,
          coverage: { ...left.result.coverage, state: "partial" },
        },
      },
      {
        evidenceId: right.evidenceId,
        result: {
          ...right.result,
          coverage: { ...right.result.coverage, state: "partial" },
        },
      },
    );
    expect(result.matching.structural_method_shape).toBe(0);
    expect(result.methods).toHaveLength(2);
    expect(
      result.methods.every(
        ({ status, match }) =>
          status === "unknown" && match.status === "unmatched",
      ),
    ).toBe(true);
  });

  it("keeps unmatched members unknown when opposite metadata is incomplete", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left-partial.dll");
    const right = inspect(buildManagedPeFixture(), "/tmp/right-partial.dll");
    const leftPartial = {
      ...left.result,
      fields: [],
      coverage: { ...left.result.coverage, state: "partial" as const },
    };
    const rightPartial = {
      ...right.result,
      methods: [],
      coverage: { ...right.result.coverage, state: "partial" as const },
    };
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: leftPartial },
      { evidenceId: right.evidenceId, result: rightPartial },
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
      limitations: [
        expect.stringContaining("unknown-within-incomplete-metadata"),
      ],
    });
    expect(result.fields[0]).toMatchObject({
      status: "unknown",
      left: null,
      right: { token: "0x04000001" },
      limitations: [
        expect.stringContaining("unknown-within-incomplete-metadata"),
      ],
    });
    expect(result.coverage).toEqual({
      status: "partial",
      left_status: "partial",
      right_status: "partial",
    });
  });

  it("does not guess ambiguous field signature matches", () => {
    const left = inspect(buildManagedPeFixture(), "/tmp/left.dll");
    const leftField = left.result.fields[0];
    expect(leftField).toBeDefined();
    if (leftField === undefined) return;
    const duplicatedLeft = {
      ...left.result,
      fields: [
        leftField,
        {
          ...leftField,
          token: "0x04000002",
          name: "other",
        },
      ],
    };
    const right = inspect(buildManagedPeFixture(), "/tmp/right.dll");
    const rightField = right.result.fields[0];
    expect(rightField).toBeDefined();
    if (rightField === undefined) return;
    const duplicatedRight = {
      ...right.result,
      fields: [
        rightField,
        {
          ...rightField,
          token: "0x04000002",
          name: "renamed",
        },
      ],
    };
    const result = compareManagedMembers(
      { evidenceId: left.evidenceId, result: duplicatedLeft },
      { evidenceId: right.evidenceId, result: duplicatedRight },
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

const inspect = (bytes: Buffer, path: string) => {
  const target = managedPeFixtureTarget(bytes, path);
  const result = inspectManagedMembersBytes(bytes, target);
  return {
    result,
    evidenceId: `ev_${hash(Buffer.from(path))}`,
  };
};

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
