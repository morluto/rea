import { unknownTarget } from "../../../../src/domain/targetIdentity.js";
import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { OwnedFileHandle } from "../../../../src/filesystem/OwnedFileHandle.js";

import { executeManagedMemberComparison } from "../../../../src/application/managed/ManagedMemberComparisonService.js";
import { RetainedRegularFileCleanupFailure } from "../../../../src/process/RegularFileRead.js";
import { createDirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import { managedMemberComparisonResultSchema } from "../../../../src/domain/managed/managedMemberComparison.js";
import { readManagedMemberEvidence } from "../../../../src/domain/managed/managedMemberComparisonMatch.js";
import { comparisonLimitations } from "../../../../src/domain/managed/managedMemberComparisonCoverage.js";
import {
  createEvidence,
  parseEvidence,
} from "../../../../src/domain/evidence.js";

import { inspectManagedMembersBytes } from "../../../../src/dotnet/ManagedMemberInspector.js";
import {
  managedPeFixtureTarget,
  buildManagedNestedTypeFixture,
  buildManagedPeFixture,
} from "../../../../src/dotnet/ManagedPe.fixture.js";
import * as boundedFileBytes from "../../../../src/process/BoundedFileBytes.js";
import {
  primaryAnalysisError,
  type AnalysisError,
} from "../../../../src/domain/analysisErrorBase.js";
import { buildManagedMemberCapacityFixture } from "../../../fixtures/managedMemberCapacity.js";
import { managedComparisonCommand } from "../../../fixtures/managedComparisonCommand.js";

it("keeps missing members unknown when the opposite inspection retains only types", async () => {
  const directory = await createTestTempDirectory(
    "rea-managed-type-recovery-comparison-",
  );
  const completePath = join(directory, "complete.dll");
  const limitedPath = join(directory, "limited.dll");
  const completeBytes = buildManagedPeFixture({ additionalEmptyTypes: 2 });
  const limitedBytes = buildManagedMemberCapacityFixture();
  await writeFile(completePath, completeBytes);
  await writeFile(limitedPath, limitedBytes);
  const complete = inspectManagedMembersBytes(
    completeBytes,
    managedPeFixtureTarget(completeBytes, completePath),
    { userStrings: false },
  );
  const limited = inspectManagedMembersBytes(
    limitedBytes,
    managedPeFixtureTarget(limitedBytes, limitedPath),
    { userStrings: false },
  );
  expect(limited.coverage.issues).toContainEqual(
    expect.objectContaining({
      code: "resource-limit",
      scope: "metadata.representation",
      offset: expect.any(Number),
    }),
  );
  for (const [leftPath, rightPath] of [
    [completePath, limitedPath],
    [limitedPath, completePath],
  ]) {
    const evidence = parseEvidence(
      await managedComparisonCommand()(leftPath!, rightPath!),
    );
    const report = managedMemberComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    expect(report.coverage.status).toBe("partial");
    expect(report.methods).toHaveLength(1);
    expect(report.fields).toHaveLength(1);
    expect(report.methods[0]?.status).toBe("unknown");
    expect(report.fields[0]?.status).toBe("unknown");
    const sources =
      leftPath === completePath
        ? ([complete, limited] as const)
        : ([limited, complete] as const);
    for (const [side, source] of [
      [report.left, sources[0]],
      [report.right, sources[1]],
    ] as const)
      expect(side.resource_limits).toEqual(
        source.coverage.issues.filter(({ code }) => code === "resource-limit"),
      );
    expect(report.limitations).toEqual(comparisonLimitations(...sources));
    const limitedSide = leftPath === limitedPath ? "left" : "right";
    expect(report.limitations).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `${limitedSide}.*metadata\\.representation.*do not establish absence`,
          "i",
        ),
      ),
    );
    expect(report.limitations).toContainEqual(
      expect.stringMatching(/smaller selection.*type_names.*--type/i),
    );
  }
});

it.each([
  ["accessibility", 6, 0x0011],
  ["synchronized implementation", 4, 0x0020],
])(
  "reports changed observed method %s despite identical CIL",
  async (_name, flagOffset, flags) => {
    const directory = await createTestTempDirectory("rea-managed-flags-");
    const leftPath = join(directory, "left.dll");
    const rightPath = join(directory, "right.dll");
    const left = buildManagedPeFixture();
    const inspection = inspectManagedMembersBytes(
      left,
      managedPeFixtureTarget(left, leftPath),
    );
    const method = inspection.methods[0];
    if (method === undefined) throw new Error("missing method fixture");
    const right = Buffer.from(left);
    right.writeUInt16LE(flags, method.row_offset + flagOffset);
    await writeFile(leftPath, left);
    await writeFile(rightPath, right);
    const evidence = parseEvidence(
      await managedComparisonCommand()(leftPath, rightPath),
    );
    const comparison = managedMemberComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    expect(comparison.methods[0]).toMatchObject({
      status: "changed",
      dimensions: ["metadata"],
    });
    expect(comparison.methods[0]?.left?.normalized_il_sha256).toBe(
      comparison.methods[0]?.right?.normalized_il_sha256,
    );
  },
);

type Inspection = ReturnType<typeof inspectManagedMembersBytes>;
const nestedInspection = (
  options: Parameters<typeof buildManagedNestedTypeFixture>[0] = {},
  typeNames?: readonly string[],
) => {
  const bytes = buildManagedNestedTypeFixture(options);
  const target = managedPeFixtureTarget(
    bytes,
    `/fixture/nested-${JSON.stringify(options)}.dll`,
  );
  return {
    target,
    inspection: inspectManagedMembersBytes(
      bytes,
      target,
      typeNames === undefined ? {} : { typeNames },
    ),
  };
};
// Historical Evidence has neither nesting facts nor declared-name digests.
const compare = (
  left: ReturnType<typeof nestedInspection>,
  right: ReturnType<typeof nestedInspection>,
  edit: {
    readonly left?: (inspection: Inspection) => unknown;
    readonly right?: (inspection: Inspection) => unknown;
  } = {},
) => {
  const observe = (
    { target, inspection }: ReturnType<typeof nestedInspection>,
    change: ((inspection: Inspection) => unknown) | undefined,
  ) =>
    createEvidence(
      target,
      { id: "nested-fixture", name: "Nested fixture", version: "1" },
      {
        operation: "inspect_managed_members",
        parameters: {},
        result: change?.(inspection) ?? inspection,
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
  const result = executeManagedMemberComparison({
    left: observe(left, edit.left),
    right: observe(right, edit.right),
  });
  if (!result.ok) throw result.error;
  return managedMemberComparisonResultSchema.parse(
    result.value.evidence.normalized_result,
  );
};

describe("managed member comparison request envelope", () => {
  it("rejects missing and extra fields before reading source Evidence", () => {
    const missing = executeManagedMemberComparison({ left: null });
    expect(missing).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [{ path: ["right"], reason: "missing_argument" }],
      },
    });

    const extra = executeManagedMemberComparison({
      left: null,
      right: null,
      ignored: true,
    });
    expect(extra).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: [{ path: ["ignored"], reason: "unknown_argument" }],
      },
    });
  });
});

const withCilDigests =
  (byToken: Readonly<Record<string, string>>) => (inspection: Inspection) => ({
    ...inspection,
    methods: inspection.methods.map((method) => {
      const digest = byToken[method.token];
      return digest === undefined || method.body.status !== "present"
        ? method
        : {
            ...method,
            body: {
              ...method.body,
              il_sha256: digest,
              normalized_il_sha256: digest,
            },
          };
    }),
  });

const pairs = (comparison: ReturnType<typeof compare>) => {
  const of = (
    items: readonly {
      readonly left: { readonly token: string } | null;
      readonly right: { readonly token: string } | null;
      readonly status: string;
      readonly match: { readonly basis: string; readonly confidence: string };
    }[],
  ) =>
    items.map(({ left, right, status, match }) => [
      left?.token ?? null,
      right?.token ?? null,
      status,
      match.basis,
      match.confidence,
    ]);
  return { methods: of(comparison.methods), fields: of(comparison.fields) };
};
const original = nestedInspection();
const swapped = nestedInspection({ swapEnclosing: true });

it("refuses comparison manifests without resource-limit facts", () => {
  const current = compare(original, swapped);
  expect(current.left.resource_limits).toEqual([]);
  expect(current.right.resource_limits).toEqual([]);
  const { resource_limits: _limits, ...left } = current.left;
  expect(
    managedMemberComparisonResultSchema.safeParse({ ...current, left }).error
      ?.issues[0]?.path,
  ).toEqual(["left", "resource_limits"]);
});

it("does not equate missing nested parents with genuinely top-level types", () => {
  const missing = nestedInspection({ nestedClassRows: [] });
  const topLevel = nestedInspection({ topLevelTypes: true });
  const result = compare(missing, topLevel);
  expect(result.summary.unchanged).toBe(0);
  expect(
    [...result.methods, ...result.fields].every(
      ({ status }) => status === "unknown",
    ),
  ).toBe(true);
});

describe("managed member comparison of nested types", () => {
  it("uses owned type identity while preserving omitted display labels", () => {
    const result = compare(original, swapped, {
      left: (inspection) => ({
        ...inspection,
        methods: inspection.methods.map((method) => ({
          ...method,
          declaring_type: null,
        })),
        fields: inspection.fields.map((field) => ({
          ...field,
          declaring_type: null,
        })),
      }),
    });
    expect(pairs(result)).toEqual(pairs(compare(original, swapped)));
    expect(
      [...result.methods, ...result.fields].every(
        (item) => item.left?.declaring_type === null,
      ),
    ).toBe(true);
  });
  it("retains nested identity when selected inventories omit enclosing types", () => {
    const left = nestedInspection({}, ["Inner"]);
    const right = nestedInspection({ swapEnclosing: true }, ["Inner"]);
    expect(left.inspection.types.map(({ full_name }) => full_name)).toEqual([
      "Inner",
      "Inner",
    ]);
    expect(pairs(compare(left, right))).toEqual({
      methods: pairs(compare(original, swapped)).methods.slice(0, 2),
      fields: pairs(compare(original, swapped)).fields,
    });
  });

  it("withholds unchanged claims when current nesting rows are malformed", () => {
    const malformed = nestedInspection({
      swapEnclosing: true,
      nestedClassRows: [
        [4, 3],
        [5, 2],
        [6, 4],
        [6, 5],
      ],
    });
    const comparison = compare(original, malformed);
    expect(comparison.methods.every(({ status }) => status === "unknown")).toBe(
      true,
    );
    expect(comparison.fields.every(({ status }) => status === "unknown")).toBe(
      true,
    );
  });

  it("withholds unchanged claims for a current enclosing cycle", () => {
    const cyclic = nestedInspection({
      nestedClassRows: [
        [4, 5],
        [5, 4],
        [6, 4],
      ],
    });
    const comparison = compare(original, cyclic);
    expect(comparison.methods.every(({ status }) => status === "unknown")).toBe(
      true,
    );
    expect(comparison.fields.every(({ status }) => status === "unknown")).toBe(
      true,
    );
  });

  it("pairs members of same-named nested types by their enclosing types", () => {
    // Moving each Inner under the other top-level type turns Fixture.A+Inner
    // from TypeDef 4 on the left into TypeDef 5 on the right.
    expect(pairs(compare(original, swapped))).toEqual({
      methods: [
        ["0x06000001", "0x06000002", "changed", "exact-il-signature", "exact"],
        ["0x06000002", "0x06000001", "changed", "exact-il-signature", "exact"],
        ["0x06000003", "0x06000003", "changed", "exact-il-signature", "exact"],
      ],
      fields: [
        ["0x04000001", "0x04000002", "unchanged", "field-signature", "exact"],
        ["0x04000002", "0x04000001", "unchanged", "field-signature", "exact"],
      ],
    });
  });

  it("reports bodies swapped between same-named nested types as changed", () => {
    // Give each Inner.M its own CIL, then swap the bodies between A and B.
    // Fixture.A+Inner.M is MethodDef 1 on the left and MethodDef 2 on the right.
    const comparison = compare(original, swapped, {
      left: withCilDigests({
        "0x06000001": "a".repeat(64),
        "0x06000002": "b".repeat(64),
      }),
      right: withCilDigests({
        "0x06000002": "b".repeat(64),
        "0x06000001": "a".repeat(64),
      }),
    });

    expect(pairs(comparison).methods.slice(0, 2)).toEqual([
      ["0x06000001", "0x06000002", "changed", "exact-signature", "exact"],
      ["0x06000002", "0x06000001", "changed", "exact-signature", "exact"],
    ]);
    expect(
      comparison.methods.slice(0, 2).map(({ dimensions }) => dimensions),
    ).toEqual([
      ["field-target", "cil", "availability"],
      ["field-target", "cil", "availability"],
    ]);
    expect(comparison.summary).toMatchObject({ changed: 3 });
  });

  it("does not pair a nested type with a top-level type of the same name", () => {
    const topLevel = nestedInspection({ topLevelTypes: true });

    expect(
      topLevel.inspection.types.find((type) => type.token === "0x02000004")
        ?.name_sha256,
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      pairs(compare(original, topLevel)).methods.filter(
        ([left, right]) => left !== null && right !== null,
      ),
    ).toEqual([]);
  });
});

describe("managed nested type names", () => {
  it("keeps a top-level name containing the separator apart from nesting", () => {
    // Produce the literal plus sign in PE metadata, which C# identifiers disallow.
    const literal = nestedInspection({
      literalTopLevelName: "Fixture.A+Inner",
    });
    const spelled = compare(original, literal);
    expect(
      literal.inspection.types.find((type) => type.token === "0x02000005"),
    ).toMatchObject({
      full_name: "Fixture.A+Inner",
      enclosing_type_token: null,
    });

    // Joined names would make both sides' Fixture.A+Inner one ambiguous group.
    expect(pairs(spelled).methods).toEqual([
      ["0x06000001", "0x06000001", "unknown", "exact-il-signature", "exact"],
      ["0x06000003", "0x06000003", "unknown", "exact-il-signature", "exact"],
      ["0x06000002", "0x06000002", "unknown", "exact-il-signature", "exact"],
    ]);
  });

  it("warns of an undecoded counterpart only for the same enclosing type", () => {
    // Keep only Fixture.B+Inner.M on the right, with an undecoded signature.
    const comparison = compare(original, original, {
      right: (inspection) => ({
        ...inspection,
        methods: inspection.methods
          .filter(({ token }) => token === "0x06000002")
          .map((method) => ({
            ...method,
            signature: {
              ...method.signature,
              raw_sha256: "c".repeat(64),
              resolved_sha256: null,
              parse_status: "malformed",
            },
          })),
      }),
    });
    const warned = comparison.methods.map(({ left, right, limitations }) => [
      left?.token ?? null,
      right?.token ?? null,
      limitations.some(
        ({ code }) => code === "counterpart-signature-not-decoded",
      ),
    ]);

    expect(warned).toContainEqual(["0x06000001", null, false]);
    expect(warned).toContainEqual(["0x06000002", null, true]);
  });
});

describe("managed member comparison subject identity", () => {
  it("rejects authenticated member Evidence whose subject digest differs from its artifact", () => {
    const bytes = buildManagedPeFixture();
    const target = managedPeFixtureTarget(bytes, "/fixture/mismatch.dll");
    const inspection = inspectManagedMembersBytes(bytes, target);
    const otherDigest = "b".repeat(64);
    const mismatched = createEvidence(
      target,
      {
        id: "partial-fixture",
        name: "Partial fixture",
        version: "1",
      },
      {
        operation: "inspect_managed_members",
        parameters: {},
        result: {
          ...inspection,
          artifact: { ...inspection.artifact, sha256: otherDigest },
          identity_scope: {
            ...inspection.identity_scope,
            requires_artifact_sha256: otherDigest,
          },
        },
      },
    );
    const aligned = createEvidence(
      target,
      {
        id: "partial-fixture",
        name: "Partial fixture",
        version: "1",
      },
      {
        operation: "inspect_managed_members",
        parameters: {},
        result: inspection,
      },
    );
    const unavailableSubject = createEvidence(
      unknownTarget("not-observed"),
      {
        id: "partial-fixture",
        name: "Partial fixture",
        version: "1",
      },
      {
        operation: "inspect_managed_members",
        parameters: {},
        result: inspection,
      },
    );

    const rejected = readManagedMemberEvidence(mismatched, "left");
    expect(rejected).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });
    if (!rejected.ok)
      expect(rejected.error.message).toContain(
        `Managed Evidence inspect_managed_members (${mismatched.evidence_id}) subject SHA-256 ${target.sha256} does not match normalized artifact SHA-256 ${otherDigest}`,
      );
    const parsedAligned = readManagedMemberEvidence(aligned, "left");
    const parsedWithoutSubject = readManagedMemberEvidence(
      unavailableSubject,
      "right",
    );
    if (!parsedAligned.ok) throw parsedAligned.error;
    if (!parsedWithoutSubject.ok) throw parsedWithoutSubject.error;
    expect(parsedAligned.value.result.artifact.sha256).toBe(target.sha256);
    expect(parsedAligned.value.evidence.evidence_id).toBe(aligned.evidence_id);
    expect(parsedWithoutSubject.value.result.artifact.sha256).toBe(
      target.sha256,
    );
  });
});

describe("managed call-target comparison", () => {
  it("keeps changed call targets visible when another target fact is unavailable", () => {
    const il = Buffer.from([0x28, 1, 0, 0, 0x0a, 0x28, 1, 0, 0, 0x0a, 0x2a]);
    const observe = (
      name: string,
      path: string,
      alterEdges?: (
        edges: Inspection["call_edges"],
      ) => Inspection["call_edges"],
    ) => {
      const bytes = buildManagedPeFixture({
        targetFramework: null,
        memberRefName: name,
        ilBody: Buffer.concat([Buffer.from([(il.length << 2) | 2]), il]),
      });
      const target = managedPeFixtureTarget(bytes, path);
      const inspection = inspectManagedMembersBytes(bytes, target);
      return createEvidence(
        target,
        {
          id: "call-target-fixture",
          name: "Call target fixture",
          version: "1",
        },
        {
          operation: "inspect_managed_members",
          parameters: {},
          result: {
            ...inspection,
            call_edges:
              alterEdges?.(inspection.call_edges) ?? inspection.call_edges,
          },
          confidence: "observed",
          authority: "shipped-artifact",
        },
      );
    };
    const left = observe("Clear", "/fixture/left.dll");
    const rightWithOneUnknownTarget = observe(
      "WriteLine",
      "/fixture/right.dll",
      (edges) =>
        edges.map((edge, index) =>
          index === 1
            ? {
                ...edge,
                target_name: null,
                target_declaring_type: null,
                target_identity_sha256: null,
              }
            : edge,
        ),
    );
    const result = executeManagedMemberComparison({
      left,
      right: rightWithOneUnknownTarget,
    });
    if (!result.ok) throw result.error;
    const report = managedMemberComparisonResultSchema.parse(
      result.value.evidence.normalized_result,
    );
    expect(report.methods[0]).toMatchObject({
      status: "changed",
      dimensions: expect.arrayContaining(["call-target", "availability"]),
      limitations: [
        expect.objectContaining({ code: "call-target-unavailable" }),
      ],
    });

    const unavailableEdges = observe(
      "Clear",
      "/fixture/no-edges.dll",
      () => [],
    );
    const unknown = executeManagedMemberComparison({
      left,
      right: unavailableEdges,
    });
    if (!unknown.ok) throw unknown.error;
    expect(
      managedMemberComparisonResultSchema.parse(
        unknown.value.evidence.normalized_result,
      ).methods[0],
    ).toMatchObject({ status: "unknown", dimensions: ["availability"] });
  });
});

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
          result: {
            ...inspection,
            coverage: { ...inspection.coverage, state: "partial" },
          },
          confidence: "observed",
          authority: "shipped-artifact",
        },
      );
    };
    const input = {
      left: observe(0xff, "/tmp/partial-left.dll"),
      right: observe(0xfe, "/tmp/partial-right.dll"),
    };
    const result = executeManagedMemberComparison(input);
    if (!result.ok) throw result.error;
    const comparison = managedMemberComparisonResultSchema.parse(
      result.value.evidence.normalized_result,
    );
    expect(result.value.summary).toEqual(comparison.summary);
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
});

/** Each typed failure the composed command's managed runner returned. */
const observedComparison = () => {
  const runner = createDirectAnalysis({}).runManagedProviderEvidence;
  const targets: string[] = [];
  const failures: AnalysisError[] = [];
  const compare = managedComparisonCommand(async (...args) => {
    targets.push(args[0]);
    const result = await runner(...args);
    if (!result.ok) failures.push(result.error);
    return result;
  });
  return { compare, targets, failures };
};

/** Close owners a failed test left open, before its directory is removed. */
const releaseOwners = async (
  owners: Iterable<OwnedFileHandle>,
): Promise<void> => {
  for (const owner of owners)
    if (owner.handle.fd >= 0) await owner.close().catch(() => undefined);
};

/** Release every file owner a typed cleanup failure retained. */
const releaseRetainedOwners = async (cause: unknown): Promise<void> => {
  if (cause instanceof RetainedRegularFileCleanupFailure)
    await cause.cleanupLease.release();
  else if (cause instanceof AggregateError)
    for (const nested of cause.errors) await releaseRetainedOwners(nested);
  else if (cause instanceof Error) await releaseRetainedOwners(cause.cause);
};

describe("compare-managed-members composed from inspect_managed_members", () => {
  it("compares two local paths and records the caller's selection", async () => {
    const directory = await createTestTempDirectory("rea-managed-compare-");
    const leftPath = join(directory, "left.dll");
    const rightPath = join(directory, "right.dll");
    const left = buildManagedPeFixture();
    await writeFile(leftPath, left);
    await writeFile(
      rightPath,
      buildManagedPeFixture({ methodName: "Renamed" }),
    );

    const evidence = parseEvidence(
      await managedComparisonCommand()(leftPath, rightPath, {
        maxSnapshotBytes: left.length * 2,
      }),
    );

    expect(evidence).toMatchObject({
      operation: "compare_managed_members",
      confidence: "inferred",
      authority: "analyst-inference",
      parameters: {
        left_path: leftPath,
        right_path: rightPath,
        max_snapshot_bytes: left.length * 2,
      },
    });
    expect(evidence.locations).toEqual([
      { kind: "artifact-path", path: leftPath },
      { kind: "artifact-path", path: rightPath },
    ]);
    expect(
      managedMemberComparisonResultSchema.parse(evidence.normalized_result)
        .matching.exact_il_signature,
    ).toBe(1);
  });

  it("refuses the same Evidence on both sides with the CLI key", async () => {
    const directory = await createTestTempDirectory("rea-managed-same-");
    const path = join(directory, "same.dll");
    await writeFile(path, buildManagedPeFixture());

    const result = await managedComparisonCommand()(path, path);

    expect(result).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["rightPath"],
            message: "Managed member Evidence must be distinct",
          },
        ],
        argument_observations: [
          { argument: "left", observation: { subject: { local_path: path } } },
          {
            argument: "right",
            observation: { subject: { local_path: path } },
          },
        ],
      },
    });
    expect(result).not.toHaveProperty("details.partial_observation");
  });

  it("reports an unopenable left path without opening the right", async () => {
    const directory = await createTestTempDirectory("rea-managed-missing-");
    const leftPath = join(directory, "missing.dll");
    const rightPath = join(directory, "right.dll");
    await writeFile(rightPath, buildManagedPeFixture());
    const { compare, targets } = observedComparison();

    const result = await compare(leftPath, rightPath);

    expect(result).toMatchObject({
      code: "target_unavailable",
      details: { path: leftPath },
    });
    expect(result).not.toHaveProperty("details.partial_observation");
    expect(result).not.toHaveProperty("details.argument_observations");
    expect(targets).toEqual([leftPath]);
  });
});

describe("compare-managed-members source failures", () => {
  // Root and Windows can still read a 0o000 file.
  const deniesUnreadableFiles =
    process.platform !== "win32" && process.getuid?.() !== 0;
  it.each([
    ["left", "disappearance", "ENOENT"],
    ["right", "disappearance", "ENOENT"],
    ...(deniesUnreadableFiles
      ? [
          ["left", "permission denial", "EACCES"],
          ["right", "permission denial", "EACCES"],
        ]
      : []),
  ])(
    "classifies a %s-side %s and retains only earlier Evidence",
    async (side, _name, code) => {
      const directory = await createTestTempDirectory(
        "rea-managed-read-failure-",
      );
      const leftPath = join(directory, "left.dll");
      const rightPath = join(directory, "right.dll");
      await writeFile(leftPath, buildManagedPeFixture());
      await writeFile(rightPath, buildManagedPeFixture({ methodName: "B" }));
      const failed = side === "left" ? leftPath : rightPath;
      if (code === "ENOENT") await rm(failed);
      else await chmod(failed, 0o000);

      const result = await managedComparisonCommand()(leftPath, rightPath);

      expect(result).toMatchObject({
        code: code === "EACCES" ? "access_denied" : "target_unavailable",
        details: { path: failed },
      });
      if (side === "right")
        expect(result).toMatchObject({
          details: {
            argument_observations: [
              {
                argument: "left",
                observation: {
                  operation: "inspect_managed_members",
                  subject: {
                    local_path: leftPath,
                    identity: {
                      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
                    },
                  },
                },
              },
            ],
          },
        });
      else expect(result).not.toHaveProperty("details.argument_observations");
      expect(result).not.toHaveProperty("details.partial_observation");
    },
  );

  it("applies the selected snapshot limit to each side before reading it", async () => {
    const directory = await createTestTempDirectory(
      "rea-managed-snapshot-limit-",
    );
    const leftPath = join(directory, "left.dll");
    const rightPath = join(directory, "right.dll");
    const fixture = buildManagedPeFixture();
    await writeFile(leftPath, fixture);
    await writeFile(rightPath, fixture);
    const read = vi.spyOn(boundedFileBytes, "readBoundedFileBytes");
    try {
      const result = await managedComparisonCommand()(leftPath, rightPath, {
        maxSnapshotBytes: fixture.length - 1,
      });

      expect(result).toMatchObject({
        code: "resource_constraint",
        details: {
          operation: "inspect_managed_members",
          reported_limits: { max_snapshot_bytes: fixture.length - 1 },
        },
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it.each(["left", "right"] as const)(
    "rejects a %s artifact that changes while its snapshot is read",
    async (side) => {
      const directory = await createTestTempDirectory(
        "rea-managed-compare-race-",
      );
      const leftPath = join(directory, "left.dll");
      const rightPath = join(directory, "right.dll");
      await writeFile(leftPath, buildManagedPeFixture());
      await writeFile(rightPath, buildManagedPeFixture({ methodName: "B" }));
      const changed = side === "left" ? leftPath : rightPath;
      const changedIdentity = (await stat(changed)).ino;
      const original = boundedFileBytes.readBoundedFileBytes;
      let wrote = false;
      const read = vi
        .spyOn(boundedFileBytes, "readBoundedFileBytes")
        .mockImplementation(async (...args) => {
          const observed = await original(...args);
          if (!wrote && (await args[0].stat()).ino === changedIdentity) {
            wrote = true;
            await writeFile(
              changed,
              buildManagedPeFixture({ methodName: "ChangedAfterRead" }),
            );
          }
          return observed;
        });
      try {
        const result = await managedComparisonCommand()(leftPath, rightPath);

        expect(wrote).toBe(true);
        expect(result).toMatchObject({
          code: "artifact_changed",
          retryable: true,
        });
        expect(JSON.stringify(result)).toContain(changed);
        if (side === "right")
          expect(result).toMatchObject({
            details: {
              argument_observations: [
                {
                  argument: "left",
                  observation: { subject: { local_path: leftPath } },
                },
              ],
            },
          });
        else expect(result).not.toHaveProperty("details.argument_observations");
      } finally {
        read.mockRestore();
      }
    },
  );
});

describe("compare-managed-members source cleanup", () => {
  it("keeps a changed source's failed file owner until its cleanup is retried", async () => {
    const root = await createTestTempDirectory(
      "rea-managed-comparison-identity-close-",
    );
    const leftPath = join(root, "left.dll");
    const rightPath = join(root, "right.dll");
    const bytes = buildManagedPeFixture();
    await Promise.all([
      writeFile(leftPath, bytes),
      writeFile(rightPath, buildManagedPeFixture({ methodName: "B" })),
    ]);
    const { compare, targets, failures } = observedComparison();
    const leftIdentity = (await stat(leftPath)).ino;
    let blocked = false;
    const original = boundedFileBytes.readBoundedFileBytes;
    const read = vi
      .spyOn(boundedFileBytes, "readBoundedFileBytes")
      .mockImplementation(async (...args) => {
        const observed = await original(...args);
        if (!blocked && (await args[0].stat()).ino === leftIdentity) {
          const changed = Buffer.from(bytes);
          changed[changed.length - 1] =
            changed.readUInt8(changed.length - 1) ^ 1;
          await writeFile(leftPath, changed);
          blocked = true;
        }
        return observed;
      });
    const nativeClose = OwnedFileHandle.prototype.close;
    const owners = new Set<OwnedFileHandle>();
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        if (blocked) {
          owners.add(this);
          throw new Error("comparison descriptor close denied");
        }
        await nativeClose.call(this);
      });
    try {
      const result = await compare(leftPath, rightPath);

      expect(result).toMatchObject({
        code: "cleanup_incomplete",
        details: { resources: [leftPath] },
      });
      expect(JSON.stringify(result)).toContain("artifact_changed");
      expect(targets).toEqual([leftPath]);
      const [failure] = failures;
      expect(failure?.cleanupIncomplete).toBe(true);
      expect(primaryAnalysisError(failure!)._tag).toBe(
        "AnalysisArtifactChangedError",
      );
      expect(owners.size).toBe(1);
      expect([...owners].every((owner) => owner.handle.fd >= 0)).toBe(true);

      blocked = false;
      read.mockRestore();
      close.mockRestore();
      await releaseRetainedOwners(failure);
      expect(failure?.cleanupIncomplete).toBe(false);
      expect([...owners].every((owner) => owner.handle.fd < 0)).toBe(true);
    } finally {
      blocked = false;
      read.mockRestore();
      close.mockRestore();
      await releaseOwners(owners);
    }
  });

  it("retries a transient snapshot close failure through the same owner", async () => {
    const directory = await createTestTempDirectory(
      "rea-managed-compare-close-",
    );
    const leftPath = join(directory, "left.dll");
    const rightPath = join(directory, "right.dll");
    await writeFile(leftPath, buildManagedPeFixture());
    await writeFile(rightPath, buildManagedPeFixture({ methodName: "B" }));
    const originalClose = OwnedFileHandle.prototype.close;
    const owners: OwnedFileHandle[] = [];
    let failed = false;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        owners.push(this);
        if (!failed) {
          failed = true;
          throw new Error("injected transient close failure");
        }
        await originalClose.call(this);
      });
    try {
      const result = await managedComparisonCommand()(leftPath, rightPath);

      expect(result).toMatchObject({ operation: "compare_managed_members" });
      expect(owners[1]).toBe(owners[0]);
      expect(owners.every((owner) => owner.handle.fd === -1)).toBe(true);
    } finally {
      close.mockRestore();
    }
  });

  it("stops at a left cleanup failure and retains its exact owner", async () => {
    const directory = await createTestTempDirectory(
      "rea-managed-compare-cleanup-",
    );
    const leftPath = join(directory, "left.dll");
    const rightPath = join(directory, "right.dll");
    await writeFile(leftPath, buildManagedPeFixture());
    await writeFile(rightPath, buildManagedPeFixture({ methodName: "B" }));
    const { compare, targets, failures } = observedComparison();
    const owners = new Set<OwnedFileHandle>();
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementation(async function (this: OwnedFileHandle) {
        owners.add(this);
        throw new Error("injected persistent close failure");
      });
    try {
      const result = await compare(leftPath, rightPath);

      expect(result).toMatchObject({
        code: "cleanup_incomplete",
        details: { cleanup: "incomplete", resources: [leftPath] },
      });
      expect(targets).toEqual([leftPath]);
      const [failure] = failures;
      expect(failure?.cleanupResources).toEqual([leftPath]);
      expect(owners.size).toBe(1);
      expect([...owners][0]?.handle.fd).toBeGreaterThanOrEqual(0);

      close.mockRestore();
      await releaseRetainedOwners(failure);
      expect(failure?.cleanupIncomplete).toBe(false);
      expect([...owners][0]?.handle.fd).toBe(-1);
    } finally {
      close.mockRestore();
      await releaseOwners(owners);
    }
  });
});
