import { fileIdentity } from "../../tests/fixtures/evidenceSubject.js";
import { describe, expect, it } from "vitest";

import {
  analysisSnapshotSchema,
  analysisQueryId,
  parseAnalysisSnapshot,
  immutableAnalysisSnapshot,
  snapshotBinding,
  snapshotEvidenceForQuery,
  sameSnapshotTarget,
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
import { createEvidenceBundle } from "./evidenceBundle.js";
import {
  RAW_ONLY_ARCHITECTURES,
  type BinaryTarget,
} from "./binaryTargetTypes.js";

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
    expect(parsed.target.identity.selection).toEqual({
      kind: "entry-point",
      entry_point: target.entryPoint,
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
});

describe("analysis snapshot dSYM companion identity", () => {
  it("hashes a bare target exactly like snapshots written before companions", () => {
    const base = {
      kind: "executable",
      identity: {
        kind: "file",
        sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
        format: "mach-o",
        architecture: "arm64",
        selection: null,
      },
    } as const;
    // A legacy file has no debug_companion key; parsing a bare target adds
    // null. Both must hash identically so legacy query IDs keep validating.
    const legacyShape = {
      ...base,
    } as unknown as Parameters<typeof analysisQueryId>[0];
    const binding = snapshotBinding(ANALYSIS_SNAPSHOT_PROFILE);
    const parsedShape = analysisSnapshotSchema.parse({
      target: legacyShape,
      binding,
      entries: [],
      workflow_entries: [],
      evidence_bundle: createEvidenceBundle([]),
    });
    expect(parsedShape.target.debug_companion).toBeNull();
    expect(
      analysisQueryId(parsedShape.target, binding, "list_procedures", {}),
    ).toBe(analysisQueryId(legacyShape, binding, "list_procedures", {}));
    // A present companion changes the identifier.
    const withCompanion = {
      ...base,
      debug_companion: {
        source_path: "/fixture/pair.dSYM",
        uuid: "A1B2C3D4-E5F6-0789-ABCD-EF0123456789",
        member_sha256: "a".repeat(64),
      },
    };
    expect(
      analysisQueryId(withCompanion, binding, "list_procedures", {}),
    ).not.toBe(analysisQueryId(legacyShape, binding, "list_procedures", {}));
    expect(sameSnapshotTarget(parsedShape.target, withCompanion)).toBe(false);
    expect(sameSnapshotTarget(withCompanion, withCompanion)).toBe(true);
  });

  it("partitions session and snapshot identity by the selected dSYM", () => {
    const base: BinaryTarget = {
      path: "/fixture/pair",
      sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
      kind: "executable",
      format: "mach-o",
      architecture: "arm64",
      availableArchitectures: ["arm64"],
    };
    const companion = {
      sourcePath: "/fixture/pair.dSYM",
      memberPath: "/fixture/pair.dSYM/Contents/Resources/DWARF/pair",
      memberSha256: "a".repeat(64),
      memberSizeBytes: 4096,
      uuid: "A1B2C3D4-E5F6-0789-ABCD-EF0123456789",
    };
    const withCompanion = { ...base, debugCompanion: companion };
    // A byte-identical companion copied to another path is a different
    // selection: the session must restage rather than report the old bundle.
    expect(
      snapshotMatchesTarget(snapshotTarget(withCompanion), {
        ...base,
        debugCompanion: { ...companion, sourcePath: "/elsewhere/pair.dSYM" },
      }),
    ).toBe(false);
    expect(snapshotMatchesTarget(snapshotTarget(base), base)).toBe(true);
    expect(
      snapshotMatchesTarget(snapshotTarget(withCompanion), withCompanion),
    ).toBe(true);
    // Omitting the companion after using one, or adding one after a bare open,
    // is a different analysis input and must not reuse the retained session.
    expect(snapshotMatchesTarget(snapshotTarget(withCompanion), base)).toBe(
      false,
    );
    expect(snapshotMatchesTarget(snapshotTarget(base), withCompanion)).toBe(
      false,
    );
    // A different companion is a different identity too.
    expect(
      snapshotMatchesTarget(snapshotTarget(withCompanion), {
        ...base,
        debugCompanion: {
          ...companion,
          uuid: "99999999-9999-9999-9999-999999999999",
        },
      }),
    ).toBe(false);
    // Snapshots persisted before companion admission carry no field and match
    // only a bare target.
    const legacy = snapshotTarget(base);
    delete (legacy as Record<string, unknown>).debug_companion;
    expect(snapshotMatchesTarget(legacy, base)).toBe(true);
    expect(snapshotMatchesTarget(legacy, withCompanion)).toBe(false);
  });
});

describe("analysis snapshot debug_companion schema contract", () => {
  it("restricts persisted non-null debug_companion commitments to Mach-O targets with validated fields", () => {
    const { snapshot } = snapshotWithHistoricalEvidence();
    const validCompanion = {
      source_path: "/fixture/pair.dSYM",
      uuid: "A1B2C3D4-E5F6-0789-ABCD-EF0123456789",
      member_sha256: "a".repeat(64),
    };
    const machoTarget = {
      kind: "executable",
      identity: {
        kind: "file",
        sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
        format: "mach-o",
        architecture: "arm64",
        selection: null,
      },
      debug_companion: validCompanion,
    };
    expect(
      analysisSnapshotSchema.safeParse({ ...snapshot, target: machoTarget })
        .success,
    ).toBe(true);
    expect(
      analysisSnapshotSchema.safeParse({
        ...snapshot,
        target: {
          ...machoTarget,
          identity: {
            ...machoTarget.identity,
            format: "mach-o-universal",
            selection: {
              kind: "universal-slice",
              offset: 0,
              size: 4096,
              cpu_type: null,
              cpu_subtype: null,
            },
          },
        },
      }).success,
    ).toBe(true);

    // Non-Mach-O targets must not carry a non-null debug_companion.
    for (const nonMachoTarget of [
      {
        ...machoTarget,
        identity: { ...machoTarget.identity, format: "elf" },
      },
      {
        ...machoTarget,
        identity: { ...machoTarget.identity, format: "pe" },
      },
      {
        kind: "executable",
        identity: {
          kind: "file",
          sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
          format: "raw-binary",
          architecture: "arm64",
          selection: { kind: "entry-point", entry_point: "0x1000" },
        },
        debug_companion: validCompanion,
      },
      {
        kind: "artifact",
        identity: {
          kind: "file",
          sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
          format: "plist",
          architecture: null,
          selection: null,
        },
        debug_companion: validCompanion,
      },
    ]) {
      expect(
        analysisSnapshotSchema.safeParse({
          ...snapshot,
          target: nonMachoTarget,
        }).success,
      ).toBe(false);
    }

    // Malformed companion fields or extra properties must be rejected.
    for (const badCompanion of [
      { ...validCompanion, source_path: "" },
      { ...validCompanion, source_path: "/fixture/bad\u0000.dSYM" },
      { ...validCompanion, uuid: validCompanion.uuid.toLowerCase() },
      { ...validCompanion, uuid: "not-a-uuid" },
      { ...validCompanion, member_sha256: "not-a-sha256" },
      { ...validCompanion, extra: true },
    ]) {
      expect(
        analysisSnapshotSchema.safeParse({
          ...snapshot,
          target: { ...machoTarget, debug_companion: badCompanion },
        }).success,
      ).toBe(false);
    }
  });
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
    entryPoint,
    entryPointSource: entryPoint,
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
