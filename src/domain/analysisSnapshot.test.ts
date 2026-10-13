import { describe, expect, it } from "vitest";

import {
  type AnalysisSnapshot,
  analysisSnapshotSchema,
  analysisQueryId,
  parseAnalysisSnapshot,
  snapshotBinding,
  snapshotEvidenceForQuery,
  snapshotTarget,
  snapshotMatchesTarget,
} from "./analysisSnapshot.js";
import {
  ANALYSIS_SNAPSHOT_PROFILE,
  ANALYSIS_SNAPSHOT_PROVIDER,
  ANALYSIS_SNAPSHOT_TARGET,
} from "./analysisSnapshot.fixture.js";
import { createEvidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import type { BinaryTarget } from "./binaryTargetTypes.js";

const snapshotWithHistoricalEvidence = () => {
  const target = snapshotTarget(ANALYSIS_SNAPSHOT_TARGET);
  const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
  const parameters = { procedure: "main" };
  const makeEvidence = (result: string) =>
    createEvidence(ANALYSIS_SNAPSHOT_TARGET, ANALYSIS_SNAPSHOT_PROVIDER, {
      operation: "analyze_function",
      parameters,
      result: { summary: result },
      analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
    });
  const current = makeEvidence("cached");
  const entry = {
    query_id: analysisQueryId(target, binding, "analyze_function", parameters),
    operation: "analyze_function",
    parameters,
    execution: {
      result: { summary: "cached" },
      raw_result: null,
      provider: binding.provider,
      limitations: [],
      relationship_coverage: null,
      locations: [],
      subject: {
        path: ANALYSIS_SNAPSHOT_TARGET.path,
        sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
        format: ANALYSIS_SNAPSHOT_TARGET.format,
        architecture: ANALYSIS_SNAPSHOT_TARGET.architecture ?? null,
      },
    },
  };
  return {
    current,
    snapshot: analysisSnapshotSchema.parse({
      target,
      binding,
      entries: [entry],
      workflow_entries: [],
      evidence_bundle: createEvidenceBundle([
        makeEvidence("older"),
        current,
        createEvidence(ANALYSIS_SNAPSHOT_TARGET, ANALYSIS_SNAPSHOT_PROVIDER, {
          operation: "unprofiled_query",
          parameters: {},
          result: { summary: "unprofiled" },
        }),
      ]),
    }),
  };
};

describe("analysis snapshot target identity", () => {
  it("keeps 6502 confined to executable raw snapshots", () => {
    const target = {
      sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
      kind: "executable",
      architecture: "6502",
    };
    expect(
      analysisSnapshotSchema.shape.target.safeParse({
        ...target,
        format: "pe",
      }).success,
    ).toBe(false);
    expect(
      analysisSnapshotSchema.shape.target.safeParse({
        ...target,
        format: "raw-binary",
        entry_point: "0x8001",
      }).success,
    ).toBe(true);
  });

  it("partitions raw snapshots and query identities by the canonical entry", () => {
    const target: BinaryTarget = {
      path: "/fixture/image.bin",
      sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
      kind: "executable",
      format: "raw-binary",
      architecture: "arm",
      availableArchitectures: ["arm"],
      entryPoint: "0x8000000",
      entryPointSource: "0x08000000",
    };
    const snapshot = snapshotTarget(target);
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    const changed = {
      ...target,
      entryPoint: "0x9000000",
      entryPointSource: "0x09000000",
    };
    expect(
      snapshotMatchesTarget(snapshot, {
        ...target,
        entryPointSource: "0x8000000",
      }),
    ).toBe(true);
    expect(snapshotMatchesTarget(snapshot, changed)).toBe(false);
    expect(analysisQueryId(snapshot, binding, "list_procedures", {})).not.toBe(
      analysisQueryId(snapshotTarget(changed), binding, "list_procedures", {}),
    );
    const parsed = analysisSnapshotSchema.parse({
      target: snapshot,
      binding,
      entries: [],
      workflow_entries: [],
      evidence_bundle: createEvidenceBundle([]),
    });
    expect(parsed.target).toHaveProperty("entry_point", target.entryPoint);
    const { entry_point: _entry, ...legacy } = {
      ...snapshot,
      entry_point: target.entryPoint,
    };
    expect(
      analysisSnapshotSchema.safeParse({ ...parsed, target: legacy }).success,
    ).toBe(false);
    expect(snapshotTarget(ANALYSIS_SNAPSHOT_TARGET)).not.toHaveProperty(
      "entry_point",
    );
  });
});

describe("analysis snapshot nested subject contract", () => {
  it("rejects raw-only 6502 in nested detected execution subjects", () => {
    const { snapshot } = snapshotWithHistoricalEvidence();
    const entry = snapshot.entries[0];
    if (entry === undefined) throw new Error("Fixture has no snapshot entry");
    const malformedSubject = {
      ...entry.execution.subject,
      format: "pe",
      architecture: "6502",
    };
    expect(
      analysisSnapshotSchema.safeParse({
        ...snapshot,
        entries: [
          {
            ...entry,
            execution: {
              ...entry.execution,
              subject: malformedSubject,
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      analysisSnapshotSchema.safeParse({
        ...snapshot,
        workflow_entries: [
          {
            ...entry,
            execution: {
              ...entry.execution,
              analysis_profile: snapshot.binding.analysis_profile,
              subject: malformedSubject,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("analysis snapshot contract", () => {
  it.each([
    ["dos-mz", "x86"],
    ["mach-o-universal", "arm64"],
  ] as const)(
    "preserves %s target and subject formats",
    (format, architecture) => {
      const target: BinaryTarget =
        format === "mach-o-universal"
          ? {
              path: ANALYSIS_SNAPSHOT_TARGET.path,
              sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
              kind: "executable",
              format,
              architecture,
              availableArchitectures: [architecture],
              universalSlice: { offset: 0, size: 32 },
            }
          : {
              path: ANALYSIS_SNAPSHOT_TARGET.path,
              sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
              kind: "executable",
              format,
              architecture,
              availableArchitectures: [architecture],
            };
      const evidence = createEvidence(target, ANALYSIS_SNAPSHOT_PROVIDER, {
        operation: "analyze_function",
        parameters: {},
        result: null,
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
      });
      const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
      const parsed = parseAnalysisSnapshot({
        target: snapshotTarget(target),
        binding,
        entries: [
          {
            query_id: analysisQueryId(
              snapshotTarget(target),
              binding,
              "analyze_function",
              {},
            ),
            operation: "analyze_function",
            parameters: {},
            execution: {
              result: null,
              raw_result: null,
              provider: binding.provider,
              limitations: [],
              locations: [],
              subject: target,
            },
          },
        ],
        workflow_entries: [],
        evidence_bundle: createEvidenceBundle([evidence]),
      });
      expect(parsed.target).toMatchObject({
        format,
        architecture,
      });
      expect(parsed.entries[0]?.execution.subject?.format).toBe(format);
      expect(parsed.evidence_bundle.records[0]?.subject?.format).toBe(format);
    },
  );

  it("rejects a snapshot subject path containing NUL", () => {
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    const entry = {
      query_id: `query_${"0".repeat(64)}`,
      operation: "analyze_function",
      parameters: {},
      execution: {
        result: null,
        raw_result: null,
        provider: binding.provider,
        limitations: [],
        locations: [],
        subject: {
          path: "a\u0000b",
          sha256: "a".repeat(64),
          format: "elf" as const,
          architecture: null,
        },
      },
    };
    expect(
      analysisSnapshotSchema.safeParse({
        target: snapshotTarget(ANALYSIS_SNAPSHOT_TARGET),
        binding,
        entries: [entry],
        workflow_entries: [],
        evidence_bundle: createEvidenceBundle([]),
      }).success,
    ).toBe(false);
  });

  it("accepts snapshots with more than ten thousand analysis entries", () => {
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    const entry = {
      query_id: `query_${"0".repeat(64)}`,
      operation: "analyze_function",
      parameters: {},
      execution: {
        result: null,
        raw_result: null,
        provider: binding.provider,
        limitations: [],
        locations: [],
        subject: null,
      },
    };

    const parsed = analysisSnapshotSchema.parse({
      target: snapshotTarget(ANALYSIS_SNAPSHOT_TARGET),
      binding,
      entries: Array.from({ length: 10_001 }, () => entry),
      workflow_entries: [],
      evidence_bundle: createEvidenceBundle([]),
    });

    expect(parsed.entries).toHaveLength(10_001);
  });
});

describe("analysis snapshot canonical ordering and scope", () => {
  it("rejects reordered queries and foreign-target records while preserving unprofiled observations", () => {
    const { snapshot } = snapshotWithHistoricalEvidence();
    const first = snapshot.entries[0];
    if (first === undefined) throw new Error("Missing fixture query");
    const parameters = { procedure: "other" };
    const second = {
      ...first,
      parameters,
      query_id: analysisQueryId(
        snapshot.target,
        snapshot.binding,
        first.operation,
        parameters,
      ),
    };
    const entries = [first, second].sort((left, right) =>
      left.query_id.localeCompare(right.query_id),
    );
    const secondEvidence = createEvidence(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        operation: second.operation,
        parameters,
        result: second.execution.result,
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
      },
    );
    const canonical = {
      ...snapshot,
      entries,
      evidence_bundle: createEvidenceBundle([
        ...snapshot.evidence_bundle.records,
        secondEvidence,
      ]),
    };
    expect(parseAnalysisSnapshot(canonical).entries).toEqual(entries);
    expect(() =>
      parseAnalysisSnapshot({ ...canonical, entries: [...entries].reverse() }),
    ).toThrow(/entries are not canonical/u);
    const workflows = entries.map((entry) => ({
      ...entry,
      execution: {
        ...entry.execution,
        analysis_profile: ANALYSIS_SNAPSHOT_PROFILE,
      },
    }));
    const workflowEvidence = workflows.map((entry) =>
      createEvidence(ANALYSIS_SNAPSHOT_TARGET, ANALYSIS_SNAPSHOT_PROVIDER, {
        operation: entry.operation,
        parameters: entry.parameters,
        result: entry.execution.result,
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
        confidence: "derived",
      }),
    );
    expect(
      parseAnalysisSnapshot({
        ...snapshot,
        entries: [],
        workflow_entries: workflows,
        evidence_bundle: createEvidenceBundle(workflowEvidence),
      }).workflow_entries,
    ).toEqual(workflows);
    expect(() =>
      parseAnalysisSnapshot({
        ...snapshot,
        entries: [],
        workflow_entries: workflows,
      }),
    ).toThrow(/no profile-bound Evidence/u);
    expect(() =>
      parseAnalysisSnapshot({
        ...snapshot,
        entries: [],
        workflow_entries: [...workflows].reverse(),
      }),
    ).toThrow(/workflow entries are not canonical/u);
    const foreign = createEvidence(
      { ...ANALYSIS_SNAPSHOT_TARGET, sha256: "b".repeat(64) },
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        operation: "unprofiled_query",
        parameters: {},
        result: null,
      },
    );
    expect(() =>
      parseAnalysisSnapshot({
        ...snapshot,
        evidence_bundle: createEvidenceBundle([
          ...snapshot.evidence_bundle.records,
          foreign,
        ]),
      }),
    ).toThrow(/another target/u);
  });
});

describe("analysis snapshot Evidence binding", () => {
  it("finds only Evidence committed to the exact binding and profile", () => {
    const { current, snapshot } = snapshotWithHistoricalEvidence();
    expect(
      snapshotEvidenceForQuery(snapshot, {
        target: ANALYSIS_SNAPSHOT_TARGET,
        bindingProfile: ANALYSIS_SNAPSHOT_PROFILE,
        operation: "analyze_function",
        parameters: { procedure: "main" },
        provider: ANALYSIS_SNAPSHOT_PROVIDER,
        evidenceProfile: ANALYSIS_SNAPSHOT_PROFILE,
      }),
    ).toEqual(current);
    expect(
      snapshotEvidenceForQuery(snapshot, {
        target: ANALYSIS_SNAPSHOT_TARGET,
        bindingProfile: ANALYSIS_SNAPSHOT_PROFILE,
        operation: "unprofiled_query",
        parameters: {},
        provider: ANALYSIS_SNAPSHOT_PROVIDER,
        evidenceProfile: ANALYSIS_SNAPSHOT_PROFILE,
      }),
    ).toBeUndefined();
  });

  it("rejects cached execution data that differs from its bundled Evidence", () => {
    const target = snapshotTarget(ANALYSIS_SNAPSHOT_TARGET);
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    const parameters = { address: "0x1000", document: "main" };
    const result = { name: "main" };
    const rawResult = { name: "provider-main" };
    const subject = {
      path: ANALYSIS_SNAPSHOT_TARGET.path,
      sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
      format: ANALYSIS_SNAPSHOT_TARGET.format,
      architecture: ANALYSIS_SNAPSHOT_TARGET.architecture ?? null,
    };
    const entry = {
      query_id: analysisQueryId(target, binding, "address_name", parameters),
      operation: "address_name",
      parameters,
      execution: {
        result,
        raw_result: rawResult,
        provider: binding.provider,
        limitations: ["fixture limitation"],
        locations: [{ kind: "address" as const, address: "0x1000" }],
        subject,
      },
    };
    const evidence = createEvidence(
      ANALYSIS_SNAPSHOT_TARGET,
      binding.provider,
      {
        operation: entry.operation,
        parameters,
        result,
        rawResult,
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
        limitations: entry.execution.limitations,
        locations: entry.execution.locations,
      },
    );
    const snapshot = {
      target,
      binding,
      entries: [entry],
      workflow_entries: [],
      evidence_bundle: createEvidenceBundle([evidence]),
    };
    const parsedLegacySnapshot = parseAnalysisSnapshot(snapshot);
    expect(
      parsedLegacySnapshot.entries[0]?.execution.relationship_coverage,
    ).toBeNull();

    expect(() =>
      parseAnalysisSnapshot({
        ...snapshot,
        evidence_bundle: createEvidenceBundle([]),
      }),
    ).toThrow(/no profile-bound Evidence/u);
    const { workflow_entries: _workflows, ...missingWorkflowEntries } =
      snapshot;
    expect(() => parseAnalysisSnapshot(missingWorkflowEntries)).toThrow();

    const alterations = [
      (altered: typeof snapshot) => {
        const entry = altered.entries[0];
        if (entry === undefined) throw new TypeError("missing fixture entry");
        entry.execution.result = { name: "tampered" };
      },
      (altered: typeof snapshot) => {
        const entry = altered.entries[0];
        if (entry === undefined) throw new TypeError("missing fixture entry");
        entry.execution.raw_result = { name: "tampered" };
      },
      (altered: typeof snapshot) => {
        const subject = altered.entries[0]?.execution.subject;
        if (subject !== null && subject !== undefined)
          subject.path = "/different/path";
      },
      (altered: typeof snapshot) => {
        const entry = altered.entries[0];
        if (entry === undefined) throw new TypeError("missing fixture entry");
        Reflect.set(entry.execution, "relationship_coverage", {
          status: "complete",
        });
      },
    ];
    for (const alter of alterations) {
      const altered = structuredClone(snapshot);
      alter(altered);
      expect(() => parseAnalysisSnapshot(altered)).toThrow(
        /differs from its Evidence record/u,
      );
    }
  });
});
