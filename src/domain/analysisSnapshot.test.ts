import { fileIdentity } from "../../tests/fixtures/evidenceSubject.js";
import { describe, expect, it } from "vitest";

import {
  analysisSnapshotSchema,
  analysisQueryId,
  parseAnalysisSnapshot,
  immutableAnalysisSnapshot,
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
import { createAnalysisProfile } from "./analysisProfile.js";
import { createEvidence, evidenceSubject } from "./evidence.js";
import { unknownTarget } from "./targetIdentity.js";
import {
  createEvidenceBundle,
  createImmutableEvidenceBundle,
} from "./evidenceBundle.js";
import { freezeJsonSnapshot } from "./immutableJson.js";
import {
  RAW_ONLY_ARCHITECTURES,
  type BinaryTarget,
} from "./binaryTargetTypes.js";
import {
  admittedRawLoad,
  rawLoadAtEntry,
  vectorTableWords,
} from "./rawBinary.fixture.js";

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
      subject: current.subject,
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

describe("analysis snapshot entry admission", () => {
  it("preserves provider entries without profiles and requires profiles on workflow entries", () => {
    const { snapshot } = snapshotWithHistoricalEvidence();
    const entry = snapshot.entries[0];
    if (entry === undefined) throw new Error("Missing fixture query");
    const providerSchema = analysisSnapshotSchema.shape.entries.element;
    const workflowSchema =
      analysisSnapshotSchema.shape.workflow_entries.element;
    expect(providerSchema.parse(entry)).toEqual(entry);
    expect(workflowSchema.safeParse(entry).success).toBe(false);
    const workflow = {
      ...entry,
      execution: {
        ...entry.execution,
        analysis_profile: snapshot.binding.analysis_profile,
      },
    };
    expect(workflowSchema.parse(workflow)).toEqual(workflow);
    for (const schema of [providerSchema, workflowSchema]) {
      expect(
        schema.safeParse({
          ...workflow,
          execution: { ...workflow.execution, provider: undefined },
        }).success,
      ).toBe(false);
    }
    expect(
      providerSchema.parse({
        ...workflow,
        unknown_entry: true,
        execution: { ...workflow.execution, unknown_execution: true },
      }),
    ).toEqual(entry);
    expect(
      workflowSchema.parse({
        ...workflow,
        unknown_entry: true,
        execution: { ...workflow.execution, unknown_execution: true },
      }),
    ).toEqual(workflow);
  });
});

describe("analysis snapshot target identity", () => {
  it.each(RAW_ONLY_ARCHITECTURES)(
    "keeps %s confined to executable raw snapshots",
    (architecture) => {
      const identity = {
        kind: "file",
        sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
        architecture,
      };
      expect(
        analysisSnapshotSchema.shape.target.safeParse({
          kind: "executable",
          identity: { ...identity, format: "pe", selection: null },
        }).success,
      ).toBe(false);
      expect(
        analysisSnapshotSchema.shape.target.safeParse({
          kind: "executable",
          identity: {
            ...identity,
            format: "raw-binary",
            selection: { kind: "entry-point", entry_point: "0x8000" },
          },
        }).success,
      ).toBe(true);
    },
  );

  it("partitions raw snapshots and query identities by the canonical entry", () => {
    const target: Extract<BinaryTarget, { format: "raw-binary" }> = {
      path: "/fixture/image.bin",
      sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
      kind: "executable",
      format: "raw-binary",
      architecture: "arm",
      availableArchitectures: ["arm"],
      rawLoad: {
        baseAddress: "0x8000000",
        entryPoint: "0x8000000",
        entrySource: { kind: "caller" },
      },
    };
    const snapshot = snapshotTarget(target);
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    // A load based at its caller-selected entry selects its entry only, as
    // before separate bases and variants existed.
    expect(snapshot).toStrictEqual({
      kind: "executable",
      identity: {
        kind: "file",
        sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
        format: "raw-binary",
        architecture: "arm",
        selection: { kind: "entry-point", entry_point: "0x8000000" },
      },
    });
    const changed: Extract<BinaryTarget, { format: "raw-binary" }> = {
      ...target,
      rawLoad: {
        baseAddress: "0x9000000",
        entryPoint: "0x9000000",
        entrySource: { kind: "caller" },
      },
    };
    // Another spelling of the same entry is the same load.
    expect(
      snapshotMatchesTarget(snapshot, {
        ...target,
        rawLoad: rawLoadAtEntry("0x08000000"),
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
    expect(parsed.target.identity.selection).toEqual({
      kind: "entry-point",
      entry_point: target.rawLoad.entryPoint,
    });
    // A raw target without its entry selection is not one REA can open.
    expect(
      analysisSnapshotSchema.safeParse({
        ...parsed,
        target: {
          ...parsed.target,
          identity: { ...parsed.target.identity, selection: null },
        },
      }).success,
    ).toBe(false);
    expect(snapshotTarget(ANALYSIS_SNAPSHOT_TARGET).identity.selection).toBe(
      null,
    );
  });
});

describe("analysis snapshot M-profile raw identity", () => {
  const target = (
    baseAddress: string,
  ): Extract<BinaryTarget, { format: "raw-binary" }> => ({
    path: "/fixture/flash.bin",
    sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
    kind: "executable",
    format: "raw-binary",
    architecture: "arm",
    availableArchitectures: ["arm"],
    rawLoad: admittedRawLoad(
      {
        architecture: "arm",
        architectureVariant: "armv7-m",
        entryPoint: undefined,
        baseAddress,
        fileBytes: 0x400,
      },
      vectorTableWords(0x20005000, 0x080001c5),
    ),
  });

  it("commits the resolved load and keeps spellings out of identity", () => {
    const snapshot = snapshotTarget(target("0x08000000"));
    expect(snapshot.identity.selection).toStrictEqual({
      kind: "entry-point",
      entry_point: "0x80001c4",
      raw_load: {
        version: 1,
        base_address: "0x8000000",
        architecture_variant: "armv7-m",
        vector_table_address: "0x8000000",
        entries: [
          {
            address: "0x80001c4",
            isa_mode: "thumb",
            role: "reset",
            basis: "vector-table",
          },
        ],
      },
    });
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    expect(
      analysisSnapshotSchema.parse({
        target: snapshot,
        binding,
        entries: [],
        workflow_entries: [],
        evidence_bundle: createEvidenceBundle([]),
      }).target,
    ).toStrictEqual(snapshot);
    expect(snapshotMatchesTarget(snapshot, target("0x8000000"))).toBe(true);
  });

  it("partitions by base and from a legacy load at the same entry", () => {
    const snapshot = snapshotTarget(target("0x08000000"));
    const moved = target("0x07ffff00");
    expect(moved.rawLoad.entryPoint).toBe("0x80001c4");
    expect(snapshotMatchesTarget(snapshot, moved)).toBe(false);
    const selection = snapshot.identity.selection;
    if (selection?.kind !== "entry-point") throw new Error("expected raw");
    const { raw_load: _identity, ...legacySelection } = selection;
    const legacy = {
      ...snapshot,
      identity: { ...snapshot.identity, selection: legacySelection },
    };
    expect(snapshotMatchesTarget(legacy, target("0x08000000"))).toBe(false);
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    expect(analysisQueryId(snapshot, binding, "list_procedures", {})).not.toBe(
      analysisQueryId(legacy, binding, "list_procedures", {}),
    );
  });
});

it("refuses a snapshot target whose kind its format cannot have", () => {
  const target = snapshotTarget(ANALYSIS_SNAPSHOT_TARGET);
  const snapshot = {
    target,
    binding: snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE),
    entries: [],
    workflow_entries: [],
    evidence_bundle: createEvidenceBundle([]),
  };
  expect(analysisSnapshotSchema.safeParse(snapshot).success).toBe(true);
  // Query IDs commit to the kind: such a header would import entries that no
  // lookup or export of the executable can reach.
  expect(
    analysisSnapshotSchema.safeParse({
      ...snapshot,
      target: { ...target, kind: "archive" },
    }).success,
  ).toBe(false);
});

describe("analysis snapshot nested subject contract", () => {
  it.each(RAW_ONLY_ARCHITECTURES)(
    "rejects raw-only %s in nested detected execution subjects",
    (architecture) => {
      const { snapshot } = snapshotWithHistoricalEvidence();
      const entry = snapshot.entries[0];
      if (entry === undefined) throw new Error("Fixture has no snapshot entry");
      const malformedSubject = {
        ...entry.execution.subject,
        identity: {
          ...entry.execution.subject.identity,
          format: "pe",
          architecture,
        },
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
    },
  );
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
              relationship_coverage: null,
              locations: [],
              subject: evidence.subject,
            },
          },
        ],
        workflow_entries: [],
        evidence_bundle: createEvidenceBundle([evidence]),
      });
      expect(parsed.target.identity).toMatchObject({
        format,
        architecture,
      });
      expect(fileIdentity(parsed.entries[0]?.execution.subject).format).toBe(
        format,
      );
      expect(
        fileIdentity(parsed.evidence_bundle.records[0]?.subject).format,
      ).toBe(format);
    },
  );

  it("rejects a snapshot subject path containing NUL", () => {
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    const entry = (localPath: string) => ({
      query_id: `query_${"0".repeat(64)}`,
      operation: "analyze_function",
      parameters: {},
      execution: {
        result: null,
        raw_result: null,
        provider: binding.provider,
        limitations: [],
        relationship_coverage: null,
        locations: [],
        subject: {
          identity: {
            kind: "file",
            sha256: "a".repeat(64),
            format: "elf",
            architecture: null,
            selection: null,
          },
          name: "b",
          local_path: localPath,
        },
      },
    });
    const parsed = (localPath: string) =>
      analysisSnapshotSchema.safeParse({
        target: snapshotTarget(ANALYSIS_SNAPSHOT_TARGET),
        binding,
        entries: [entry(localPath)],
        workflow_entries: [],
        evidence_bundle: createEvidenceBundle([]),
      }).success;
    expect(parsed("/fixture/ab")).toBe(true);
    expect(parsed("a\u0000b")).toBe(false);
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
        relationship_coverage: null,
        locations: [],
        subject: evidenceSubject(unknownTarget("not-observed")),
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
    ).toThrow(/unrelated to the selected target/u);
  });
});

it("retains linked foreign Evidence without treating it as selected-target replay", () => {
  const { current, snapshot } = snapshotWithHistoricalEvidence();
  const foreignTarget = { ...ANALYSIS_SNAPSHOT_TARGET, sha256: "b".repeat(64) };
  const foreign = createEvidence(foreignTarget, ANALYSIS_SNAPSHOT_PROVIDER, {
    operation: current.operation,
    parameters: current.parameters,
    result: current.normalized_result,
    analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
  });
  const linked = createEvidence(
    ANALYSIS_SNAPSHOT_TARGET,
    ANALYSIS_SNAPSHOT_PROVIDER,
    {
      operation: current.operation,
      parameters: current.parameters,
      result: current.normalized_result,
      analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
      evidenceLinks: [foreign.evidence_id],
    },
  );
  const bundle = createEvidenceBundle([
    ...snapshot.evidence_bundle.records.filter(
      (record) => record.evidence_id !== current.evidence_id,
    ),
    linked,
    foreign,
  ]);
  const admitted = parseAnalysisSnapshot({
    ...snapshot,
    evidence_bundle: bundle,
  });
  const query = {
    target: ANALYSIS_SNAPSHOT_TARGET,
    bindingProfile: ANALYSIS_SNAPSHOT_PROFILE,
    operation: linked.operation,
    parameters: linked.parameters,
    provider: ANALYSIS_SNAPSHOT_PROVIDER,
    evidenceProfile: ANALYSIS_SNAPSHOT_PROFILE,
  };
  expect(snapshotEvidenceForQuery(admitted, query)).toEqual(linked);
  const differentProfile = createAnalysisProfile(ANALYSIS_SNAPSHOT_PROVIDER, {
    fixture: "other",
  });
  expect(
    snapshotEvidenceForQuery(admitted, {
      ...query,
      evidenceProfile: differentProfile,
    }),
  ).toBeUndefined();
  expect(
    snapshotEvidenceForQuery(admitted, {
      ...query,
      bindingProfile: differentProfile,
    }),
  ).toBeUndefined();
  expect(
    snapshotEvidenceForQuery(admitted, {
      ...query,
      operation: "unprofiled_query",
      parameters: {},
    }),
  ).toBeUndefined();
  expect(snapshotMatchesTarget(admitted.target, foreignTarget)).toBe(false);
  const unrelated = createEvidence(foreignTarget, ANALYSIS_SNAPSHOT_PROVIDER, {
    operation: "unrelated",
    parameters: {},
    result: "foreign",
  });
  expect(() =>
    parseAnalysisSnapshot({
      ...snapshot,
      evidence_bundle: createEvidenceBundle([...bundle.records, unrelated]),
    }),
  ).toThrow("unrelated to the selected target and its linked sources");
});

it("binds raw Evidence only when its entry point matches the snapshot target", () => {
  const raw = (entryPoint: string): BinaryTarget => ({
    path: "/fixture/image.bin",
    sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
    kind: "executable",
    format: "raw-binary",
    architecture: "arm",
    availableArchitectures: ["arm"],
    rawLoad: rawLoadAtEntry(entryPoint),
  });
  const selected = raw("0x8000000");
  const target = snapshotTarget(selected);
  const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
  const parameters = { procedure: "main" };
  const observe = (observed: BinaryTarget) =>
    createEvidence(observed, ANALYSIS_SNAPSHOT_PROVIDER, {
      operation: "analyze_function",
      parameters,
      result: { summary: "cached" },
      analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
    });
  const snapshotWith = (evidence: ReturnType<typeof observe>) =>
    analysisSnapshotSchema.parse({
      target,
      binding,
      entries: [
        {
          query_id: analysisQueryId(
            target,
            binding,
            "analyze_function",
            parameters,
          ),
          operation: "analyze_function",
          parameters,
          execution: {
            result: { summary: "cached" },
            raw_result: null,
            provider: binding.provider,
            limitations: [],
            relationship_coverage: null,
            locations: [],
            subject: evidenceSubject(selected),
          },
        },
      ],
      workflow_entries: [],
      evidence_bundle: createEvidenceBundle([evidence]),
    });
  const query = {
    target: selected,
    bindingProfile: ANALYSIS_SNAPSHOT_PROFILE,
    operation: "analyze_function",
    parameters,
    provider: ANALYSIS_SNAPSHOT_PROVIDER,
    evidenceProfile: ANALYSIS_SNAPSHOT_PROFILE,
  };
  const matching = observe(selected);
  expect(snapshotEvidenceForQuery(snapshotWith(matching), query)).toEqual(
    matching,
  );
  expect(
    snapshotEvidenceForQuery(snapshotWith(observe(raw("0x9000000"))), query),
  ).toBeUndefined();
});

describe("analysis snapshot Evidence binding", () => {
  it("rejects cached execution data that differs from its bundled Evidence", () => {
    const target = snapshotTarget(ANALYSIS_SNAPSHOT_TARGET);
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    const parameters = { address: "0x1000", document: "main" };
    const result = { name: "main" };
    const rawResult = { name: "provider-main" };
    const subject = evidenceSubject(ANALYSIS_SNAPSHOT_TARGET);
    const entry = {
      query_id: analysisQueryId(target, binding, "address_name", parameters),
      operation: "address_name",
      parameters,
      execution: {
        result,
        raw_result: rawResult,
        provider: binding.provider,
        limitations: ["fixture limitation"],
        relationship_coverage: null,
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
    const parsedSnapshot = parseAnalysisSnapshot(snapshot);
    expect(
      parsedSnapshot.entries[0]?.execution.relationship_coverage,
    ).toBeNull();

    const missingCoverage = structuredClone(snapshot);
    const missingCoverageEntry = missingCoverage.entries[0];
    if (missingCoverageEntry === undefined)
      throw new Error("snapshot entry missing");
    Reflect.deleteProperty(
      missingCoverageEntry.execution,
      "relationship_coverage",
    );
    expect(() => parseAnalysisSnapshot(missingCoverage)).toThrow();

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
        if (subject === undefined) throw new TypeError("missing fixture entry");
        Reflect.set(subject, "local_path", "/different/path");
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

describe("analysis snapshot payload ownership", () => {
  it.each(["provider", "workflow"] as const)(
    "shares authenticated %s payloads only in immutable snapshots",
    (kind) => {
      const { snapshot } = snapshotWithHistoricalEvidence();
      const entry = snapshot.entries[0];
      if (entry === undefined) throw new Error("Missing fixture query");
      entry.execution.raw_result = { source: "raw" };
      const evidence = createEvidence(
        ANALYSIS_SNAPSHOT_TARGET,
        ANALYSIS_SNAPSHOT_PROVIDER,
        {
          operation: entry.operation,
          parameters: entry.parameters,
          result: entry.execution.result,
          rawResult: entry.execution.raw_result,
          analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
          confidence: kind === "provider" ? "observed" : "derived",
        },
      );
      const input = {
        ...snapshot,
        entries: kind === "provider" ? [entry] : [],
        workflow_entries:
          kind === "workflow"
            ? [
                {
                  ...entry,
                  execution: {
                    ...entry.execution,
                    analysis_profile: ANALYSIS_SNAPSHOT_PROFILE,
                  },
                },
              ]
            : [],
        evidence_bundle: createEvidenceBundle([evidence]),
      };
      const original = structuredClone(input);
      const immutable = immutableAnalysisSnapshot(input);
      const immutableEntry = (
        kind === "provider" ? immutable.entries : immutable.workflow_entries
      )[0];
      const immutableEvidence = immutable.evidence_bundle.records[0];
      if (immutableEntry === undefined || immutableEvidence === undefined)
        throw new Error("Missing immutable payload");
      expect(immutableEntry.execution.result).toBe(
        immutableEvidence.normalized_result,
      );
      expect(immutableEntry.execution.raw_result).toBe(
        immutableEvidence.raw_result,
      );
      expect(Object.isFrozen(immutableEntry.execution.result)).toBe(true);
      expect(Object.isFrozen(immutableEntry.execution.raw_result)).toBe(true);
      expect(Object.isFrozen(immutable)).toBe(true);
      expect(immutableAnalysisSnapshot(immutable)).toBe(immutable);
      expect(parseAnalysisSnapshot(immutable)).toBe(immutable);
      expect(input).toEqual(original);
      expect(Object.isFrozen(entry.execution.result)).toBe(false);
      expect(Object.isFrozen(entry.execution.raw_result)).toBe(false);
      const mutable = parseAnalysisSnapshot(input);
      const mutableEntry = (
        kind === "provider" ? mutable.entries : mutable.workflow_entries
      )[0];
      const mutableEvidence = mutable.evidence_bundle.records[0];
      if (mutableEntry === undefined || mutableEvidence === undefined)
        throw new Error("Missing mutable payload");
      expect(mutableEntry.execution.result).not.toBe(
        mutableEvidence.normalized_result,
      );
      expect(mutableEntry.execution.raw_result).not.toBe(
        mutableEvidence.raw_result,
      );
      mutableEntry.execution.result = { changed: true };
      mutableEntry.execution.raw_result = { changed: true };
      expect(mutableEvidence).toEqual(evidence);
      expect(input).toEqual(original);
      const tampered = structuredClone(input);
      const tamperedEntry = (
        kind === "provider" ? tampered.entries : tampered.workflow_entries
      )[0];
      if (tamperedEntry === undefined) throw new Error("Missing tamper query");
      tamperedEntry.execution.result = { changed: true };
      expect(() => immutableAnalysisSnapshot(tampered)).toThrow(
        /differs from its Evidence/u,
      );
      expect(Object.isFrozen(tamperedEntry.execution.result)).toBe(false);
    },
  );
});

describe("detached snapshot exports", () => {
  it("detaches sealed nested JSON payloads while keeping immutable snapshots shared", () => {
    const { snapshot } = snapshotWithHistoricalEvidence();
    const entry = snapshot.entries[0];
    if (entry === undefined) throw new Error("Missing fixture entry");
    const frozenResult = freezeJsonSnapshot({ summary: "cached", items: [1] });
    const frozenRaw = freezeJsonSnapshot({ source: ["raw"] });
    const frozenParams = freezeJsonSnapshot({ procedure: "main" });
    const evidence = createEvidence(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        operation: entry.operation,
        parameters: frozenParams,
        result: frozenResult,
        rawResult: frozenRaw,
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
      },
    );
    const sealedBundle = createImmutableEvidenceBundle([evidence]);
    const input = {
      ...snapshot,
      entries: [
        {
          ...entry,
          parameters: frozenParams,
          execution: {
            ...entry.execution,
            result: frozenResult,
            raw_result: frozenRaw,
          },
        },
      ],
      evidence_bundle: sealedBundle,
    };
    const detached = parseAnalysisSnapshot(input);
    const detachedEntry = detached.entries[0]!;
    const detachedRecord = detached.evidence_bundle.records[0]!;
    expect(Object.isFrozen(detachedEntry.execution.result)).toBe(false);
    expect(Object.isFrozen(detachedEntry.execution.raw_result)).toBe(false);
    expect(Object.isFrozen(detachedEntry.parameters)).toBe(false);
    expect(Object.isFrozen(detachedRecord.normalized_result)).toBe(false);
    expect(Object.isFrozen(detachedRecord.raw_result)).toBe(false);
    expect(Object.isFrozen(detachedRecord.parameters)).toBe(false);
    (detachedRecord.normalized_result as { items: number[] }).items.push(2);
    expect(sealedBundle.records[0]?.normalized_result).toEqual({
      summary: "cached",
      items: [1],
    });
    expect(Object.isFrozen(sealedBundle.records[0]?.normalized_result)).toBe(
      true,
    );
  });
});
