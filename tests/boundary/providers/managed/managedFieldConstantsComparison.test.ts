import { expect, it } from "vitest";

import { buildManagedPeFixture } from "../../../../scripts/fixtures/managed/pe.mjs";
import { managedPeFixtureTarget } from "../../../../src/dotnet/ManagedPe.fixture.js";
import { inspectManagedMembersBytes } from "../../../../src/dotnet/ManagedMemberInspector.js";
import { createEvidence } from "../../../../src/domain/evidence.js";
import { executeManagedMemberComparison } from "../../../../src/application/managed/ManagedMemberComparisonService.js";
import { managedMemberComparisonResultSchema } from "../../../../src/domain/managed/managedMemberComparison.js";

const observe = (
  hex: string | null,
  moduleByte: number,
  {
    typeCode = 8,
    signatureType = typeCode,
    flags = hex === null ? 0x56 : 0x8056,
  }: { typeCode?: number; signatureType?: number; flags?: number } = {},
) => {
  const bytes = buildManagedPeFixture({
    mvid: Buffer.alloc(16, moduleByte),
    fields: [
      { name: "Default", flags, signature: Buffer.from([6, signatureType]) },
    ],
    constants:
      hex === null ? [] : [{ typeCode, value: Buffer.from(hex, "hex") }],
  });
  return observation(bytes);
};

const observation = (bytes: Buffer) => {
  const target = managedPeFixtureTarget(bytes);
  const report = inspectManagedMembersBytes(bytes, target);
  return {
    report,
    evidence: createEvidence(
      target,
      { id: "constant-fixture", name: "Constant fixture", version: "1" },
      {
        operation: "inspect_managed_members",
        parameters: {},
        result: report,
        confidence: "observed",
        authority: "shipped-artifact",
      },
    ),
  };
};

const compare = (
  left: ReturnType<typeof observe>,
  right: ReturnType<typeof observe>,
) => {
  const result = executeManagedMemberComparison({
    left: left.evidence,
    right: right.evidence,
  });
  if (!result.ok) throw result.error;
  expect(result.value.sources).toEqual([left.evidence, right.evidence]);
  return managedMemberComparisonResultSchema.parse(
    result.value.evidence.normalized_result,
  );
};

it.each([
  ["i4", 8, "01000000", "02000000", 1, 2],
  [
    "wide i8",
    0x0a,
    "0000000000002000",
    "0100000000002000",
    "9007199254740992",
    "9007199254740993",
  ],
  ["signed zero", 0x0d, "0000000000000000", "0000000000000080", 0, "-0"],
  ["NaN payload", 0x0d, "000000000000f87f", "010000000000f87f", "NaN", "NaN"],
] as const)(
  "compares changed %s defaults without losing encoded distinctions",
  (_name, typeCode, leftHex, rightHex, leftValue, rightValue) => {
    const left = observe(leftHex, 1, { typeCode });
    const right = observe(rightHex, 2, { typeCode });
    expect(left.report.fields[0]?.constant).toMatchObject({
      state: "decoded",
      value: leftValue,
    });
    expect(right.report.fields[0]?.constant).toMatchObject({
      state: "decoded",
      value: rightValue,
    });
    const comparison = compare(left, right);
    expect(comparison.fields).toEqual([
      expect.objectContaining({
        status: "changed",
        match: expect.objectContaining({
          status: "matched",
          basis: "field-signature",
          confidence: "exact",
        }),
        evidence_links: [left.evidence.evidence_id, right.evidence.evidence_id],
        limitations: [],
      }),
    ]);
    expect(comparison.summary.changed).toBe(1);
  },
);

it("distinguishes class-null from a string with the same encoded bytes", () => {
  const left = observe("00000000", 1, {
    typeCode: 0x12,
    signatureType: 0x0e,
  });
  const right = observe("00000000", 2, { typeCode: 0x0e });
  expect(left.report.fields[0]?.constant).toMatchObject({
    state: "decoded",
    element_type: "class",
    value: null,
  });
  expect(right.report.fields[0]?.constant).toMatchObject({
    state: "decoded",
    element_type: "string",
    value: "\u0000\u0000",
  });
  expect(compare(left, right).fields[0]?.status).toBe("changed");
});

it.each(["01000000", null])(
  "keeps equal defaults unchanged across artifacts (%s)",
  (hex) => {
    const comparison = compare(observe(hex, 1), observe(hex, 2));
    expect(comparison.fields[0]).toMatchObject({
      status: "unchanged",
      limitations: [],
    });
    expect(comparison.summary.changed).toBe(0);
    expect(comparison.summary.unknown).toBe(0);
  },
);

it("ignores build-local Constant row offsets, blob indices and field tokens", () => {
  const inspect = (names: string[], moduleByte: number) =>
    observation(
      buildManagedPeFixture({
        mvid: Buffer.alloc(16, moduleByte),
        fields: names.map((name) => ({ name, flags: 0x8056 })),
        constants: names.map((name, index) => ({
          parentRaw: (index + 1) << 2,
          typeCode: 8,
          value: Buffer.from(
            name === "Default" ? "01000000" : "02000000",
            "hex",
          ),
        })),
      }),
    );
  const left = inspect(["Default", "Other"], 1);
  const right = inspect(["Other", "Default"], 2);
  const leftDefault = left.report.fields.find(({ name }) => name === "Default");
  const rightDefault = right.report.fields.find(
    ({ name }) => name === "Default",
  );
  expect(leftDefault?.constant?.declarations).not.toEqual(
    rightDefault?.constant?.declarations,
  );
  const comparison = compare(left, right);
  expect(comparison.fields.map(({ status }) => status)).toEqual([
    "unchanged",
    "unchanged",
  ]);
});

it.each(["left", "right", "both"] as const)(
  "keeps unavailable %s defaults unknown with their source side",
  (unavailable) => {
    const left = observe(unavailable === "right" ? "01000000" : "01", 1);
    const right = observe(unavailable === "left" ? "01000000" : "01", 2);
    const comparison = compare(left, right);
    expect(comparison.fields[0]?.status).toBe("unknown");
    expect(
      comparison.fields[0]?.limitations.map(({ code, side }) => ({
        code,
        side,
      })),
    ).toEqual(
      (unavailable === "both" ? ["left", "right"] : [unavailable]).map(
        (side) => ({
          code: "field-constant-unavailable",
          side,
        }),
      ),
    );
    expect(comparison.summary.unknown).toBe(1);
  },
);

it("retains a proven flag change beside an unavailable default", () => {
  const comparison = compare(
    observe("01", 1),
    observe("02000000", 2, { flags: 0x8051 }),
  );
  expect(comparison.fields[0]).toMatchObject({
    status: "changed",
    limitations: [{ code: "field-constant-unavailable", side: "left" }],
  });
});

it.each([true, false])(
  "compares addition and removal of defaults (%s)",
  (added) => {
    const absent = observe(null, 1);
    const present = observe("01000000", 2);
    const comparison = added
      ? compare(absent, present)
      : compare(present, absent);
    expect(comparison.fields[0]).toMatchObject({
      status: "changed",
      limitations: [],
    });
  },
);
