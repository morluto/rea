import { describe, expect, it } from "vitest";

import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import {
  ANALYSIS_SNAPSHOT_PROFILE,
  ANALYSIS_SNAPSHOT_PROVIDER,
  ANALYSIS_SNAPSHOT_TARGET,
} from "../../domain/analysisSnapshot.fixture.js";
import { createEvidence } from "../../domain/evidence.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import { ok } from "../../domain/result.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import {
  createAnalysisSnapshotWorkflowEntry,
  parseAnalysisSnapshot,
  serializeAnalysisSnapshot,
  snapshotEvidenceForQuery,
  snapshotBinding,
  snapshotTarget,
} from "../../domain/analysisSnapshot.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "../InvestigationProviders.js";
import type {
  AnalysisOperation,
  CapabilityDescriptor,
} from "../AnalysisProvider.js";
import {
  AnalysisSnapshotCache,
  SNAPSHOT_CACHE_ENTRY_CEILING,
  isSnapshotCacheable,
} from "./AnalysisSnapshotCache.js";
import { enhancedOutputSchemas } from "../../contracts/toolOutputSchemaGroups.js";

it("exports independent nested query, workflow and Evidence payloads", () => {
  const cache = new AnalysisSnapshotCache();
  const target = ANALYSIS_SNAPSHOT_TARGET;
  const profile = ANALYSIS_SNAPSHOT_PROFILE;
  const result = { nested: [{ text: "ret" }], name: "main" };
  const parameters = { address: "0x1000", document: "fixture" };
  const workflowProfile = workflowAnalysisProfile(profile);
  cache.record({
    target,
    profile,
    operation: "procedure_info",
    parameters,
    execution: createAnalysisExecution(result, ANALYSIS_SNAPSHOT_PROVIDER, {
      subject: target,
      analysisProfile: profile,
      rawResult: result,
    }),
  });
  cache.recordWorkflow({
    target,
    profile,
    operation: "analyze_function",
    parameters,
    execution: {
      ...createAnalysisExecution(result, REA_WORKFLOW_PROVIDER, {
        subject: target,
        rawResult: result,
      }),
      analysisProfile: workflowProfile,
    },
  });
  const bundle = createEvidenceBundle([
    createEvidence(target, ANALYSIS_SNAPSHOT_PROVIDER, {
      operation: "procedure_info",
      parameters,
      result,
      rawResult: result,
      analysisProfile: profile,
    }),
    createEvidence(target, REA_WORKFLOW_PROVIDER, {
      operation: "analyze_function",
      confidence: "derived",
      parameters,
      result,
      rawResult: result,
      analysisProfile: workflowProfile,
    }),
  ]);
  const exported = cache.export(target, profile, bundle);
  if (!exported.ok) throw exported.error;
  const expected = serializeAnalysisSnapshot(exported.value);
  const changed = JSON.stringify(exported.value).replaceAll(
    '"ret"',
    '"changed"',
  );
  // Mutate the returned graph itself, including every duplicated JSON result.
  for (const payload of [
    ...exported.value.entries.flatMap(({ execution }) => [
      execution.result,
      execution.raw_result,
    ]),
    ...exported.value.workflow_entries.flatMap(({ execution }) => [
      execution.result,
      execution.raw_result,
    ]),
    ...exported.value.evidence_bundle.records.flatMap((record) => [
      record.normalized_result,
      record.raw_result,
    ]),
  ]) {
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    )
      throw new Error("Expected nested fixture result");
    Reflect.set(payload, "nested", [{ text: "changed" }]);
  }
  expect(JSON.stringify(exported.value)).toBe(changed);
  const fresh = cache.export(target, profile, bundle);
  if (!fresh.ok) throw fresh.error;
  expect(serializeAnalysisSnapshot(fresh.value)).toBe(expected);
});

it("rebinds replayed target subjects while preserving child artifact subjects", () => {
  const cache = new AnalysisSnapshotCache();
  const target = ANALYSIS_SNAPSHOT_TARGET;
  const profile = ANALYSIS_SNAPSHOT_PROFILE;
  const relocatedTarget = { ...target, path: "/tmp/relocated-app" };
  const parameters = { address: "0x1000" };
  const locations = [{ kind: "address" as const, address: "0x1000" }];
  cache.record({
    target,
    profile,
    operation: "procedure_info",
    parameters,
    execution: createAnalysisExecution(
      { name: "main" },
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        subject: target,
        rawResult: { provider: "raw" },
        locations,
        analysisProfile: profile,
      },
    ),
  });

  const replayedTarget = cache.lookup(
    relocatedTarget,
    profile,
    "procedure_info",
    parameters,
  );
  expect(replayedTarget?.subject?.path).toBe(relocatedTarget.path);
  expect(replayedTarget?.rawResult).toEqual({ provider: "raw" });
  expect(replayedTarget?.locations).toEqual(locations);

  const childSubject = {
    path: "/tmp/child.zip",
    sha256: "b".repeat(64),
    format: "zip" as const,
  };
  const childParameters = { address: "0x2000" };
  cache.record({
    target,
    profile,
    operation: "procedure_info",
    parameters: childParameters,
    execution: createAnalysisExecution(
      { name: "child" },
      ANALYSIS_SNAPSHOT_PROVIDER,
      { subject: childSubject, analysisProfile: profile },
    ),
  });
  expect(
    cache.lookup(relocatedTarget, profile, "procedure_info", childParameters)
      ?.subject,
  ).toMatchObject(childSubject);
});

describe("analysis snapshot cache capacity", () => {
  it("shares capacity across query kinds while allowing replacements and fresh partitions", () => {
    const cache = new AnalysisSnapshotCache();
    const target = ANALYSIS_SNAPSHOT_TARGET;
    const profile = ANALYSIS_SNAPSHOT_PROFILE;
    const execution = {
      ...createAnalysisExecution("workflow", REA_WORKFLOW_PROVIDER, {
        subject: target,
      }),
      analysisProfile: workflowAnalysisProfile(profile),
    };
    const workflowInput = {
      target,
      profile,
      operation: "trace_feature",
      parameters: { query: "existing" },
      execution,
    };
    for (let index = 0; index < SNAPSHOT_CACHE_ENTRY_CEILING - 1; index += 1)
      cache.recordWorkflow({
        ...workflowInput,
        parameters: { query: String(index) },
      });
    // Staging and recording both spend the same budget; an existing query can
    // still be refreshed when no space remains for a new binding.
    const directInput = {
      target,
      profile,
      operation: "address_name" as const,
      parameters: { address: "0x1000", document: "fixture" },
      execution: createAnalysisExecution(
        "initial",
        ANALYSIS_SNAPSHOT_PROVIDER,
        { subject: target, analysisProfile: profile },
      ),
    };
    cache.record(directInput);
    cache.record({
      ...directInput,
      parameters: { address: "0x2000", document: "fixture" },
    });
    cache.recordWorkflow(workflowInput);
    expect(cache.entries()).toHaveLength(1);
    expect(cache.workflowEntries()).toHaveLength(
      SNAPSHOT_CACHE_ENTRY_CEILING - 1,
    );

    cache.record({
      ...directInput,
      execution: { ...directInput.execution, result: "updated" },
    });
    cache.recordWorkflow({
      ...workflowInput,
      parameters: { query: "0" },
      execution: { ...execution, result: "updated" },
    });
    expect(
      cache.lookup(target, profile, "address_name", directInput.parameters)
        ?.result,
    ).toBe("updated");
    expect(
      cache.workflowEntries().find(({ parameters }) => parameters.query === "0")
        ?.execution.result,
    ).toBe("updated");

    const incoming = createAnalysisSnapshotWorkflowEntry({
      ...workflowInput,
      target: snapshotTarget(target),
      binding: snapshotBinding(profile),
    });
    const evidence = createEvidence(target, REA_WORKFLOW_PROVIDER, {
      operation: workflowInput.operation,
      confidence: "derived",
      parameters: workflowInput.parameters,
      result: execution.result,
      rawResult: execution.rawResult,
      analysisProfile: execution.analysisProfile,
      limitations: execution.limitations,
      locations: execution.locations,
    });
    cache.stage(
      parseAnalysisSnapshot({
        target: snapshotTarget(target),
        binding: snapshotBinding(profile),
        entries: [],
        workflow_entries: [incoming],
        evidence_bundle: createEvidenceBundle([evidence]),
      }),
    );
    expect(cache.workflowEntries()).toHaveLength(
      SNAPSHOT_CACHE_ENTRY_CEILING - 1,
    );

    const otherTarget = { ...target, sha256: "b".repeat(64) };
    cache.recordWorkflow({
      ...workflowInput,
      target: otherTarget,
      execution: { ...execution, subject: otherTarget },
    });
    expect(cache.entries()).toEqual([]);
    expect(cache.workflowEntries()).toHaveLength(1);
    cache.clear();
    cache.record({
      ...directInput,
      target: otherTarget,
      execution: { ...directInput.execution, subject: otherTarget },
    });
    expect(cache.entries()).toHaveLength(1);
    expect(cache.workflowEntries()).toEqual([]);
  });
});

describe("analysis snapshot cache policy", () => {
  it.each<{
    policy?: CapabilityDescriptor["cachePolicy"];
    operation?: CapabilityDescriptor["operation"];
    effects?: Partial<CapabilityDescriptor["effects"]>;
    parameters?: Record<string, string>;
    cacheable: boolean;
  }>([
    { cacheable: false },
    { policy: "snapshot", cacheable: true },
    { policy: "live", cacheable: false },
    {
      policy: "live",
      effects: { mayWriteFilesystem: false },
      cacheable: false,
    },
    {
      policy: "snapshot",
      effects: { mutatesArtifact: true },
      cacheable: false,
    },
    {
      policy: "snapshot",
      effects: { changesPermissions: true },
      cacheable: false,
    },
    { policy: "snapshot", operation: "list_documents", cacheable: false },
    { policy: "snapshot", operation: "list_strings", cacheable: false },
    {
      policy: "snapshot",
      operation: "address_name",
      parameters: { document: "fixture" },
      cacheable: false,
    },
  ])(
    "keeps explicit cache policy within immutable and state-independent boundaries: %j",
    ({
      policy,
      operation = "analyze_function",
      effects,
      parameters = {},
      cacheable,
    }) => {
      const descriptor: CapabilityDescriptor = {
        provider: ANALYSIS_SNAPSHOT_PROVIDER,
        operation,
        available: true,
        reason: null,
        ...(policy === undefined ? {} : { cachePolicy: policy }),
        effects: {
          mutatesArtifact: false,
          launchesProcess: true,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: true,
          changesPermissions: false,
          requiresRoot: false,
          ...effects,
        },
        limitations: [],
      };
      expect(isSnapshotCacheable(operation, descriptor, parameters)).toBe(
        cacheable,
      );
    },
  );
});

describe("analysis snapshot cache partitioning", () => {
  it.each<{
    operation: Exclude<AnalysisOperation, "health">;
    parameters: Record<string, string>;
    cacheable: boolean;
  }>([
    { operation: "list_strings", parameters: {}, cacheable: false },
    {
      operation: "list_strings",
      parameters: { document: "fixture" },
      cacheable: true,
    },
    {
      operation: "address_name",
      parameters: { document: "fixture" },
      cacheable: false,
    },
    {
      operation: "address_name",
      parameters: { document: "fixture", address: "0x1000" },
      cacheable: true,
    },
    { operation: "binary_overview", parameters: {}, cacheable: true },
  ])(
    "retains explicit document and cursor requirements for $operation",
    ({ operation, parameters, cacheable }) => {
      const descriptor: CapabilityDescriptor = {
        operation,
        provider: ANALYSIS_SNAPSHOT_PROVIDER,
        available: true,
        reason: null,
        effects: {
          mutatesArtifact: false,
          launchesProcess: false,
          mayShowUi: false,
          mayAccessNetwork: false,
          mayWriteFilesystem: false,
          changesPermissions: false,
          requiresRoot: false,
        },
        limitations: [],
      };
      expect(isSnapshotCacheable(operation, descriptor, parameters)).toBe(
        cacheable,
      );
    },
  );

  it("returns detached data only from the exact provider/profile partition", () => {
    const cache = new AnalysisSnapshotCache();
    const execution = createAnalysisExecution(
      "main",
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
        rawResult: "main",
        subject: {
          path: ANALYSIS_SNAPSHOT_TARGET.path,
          sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
          format: ANALYSIS_SNAPSHOT_TARGET.format,
          ...(ANALYSIS_SNAPSHOT_TARGET.architecture === undefined
            ? {}
            : { architecture: ANALYSIS_SNAPSHOT_TARGET.architecture }),
        },
      },
    );
    cache.record({
      target: ANALYSIS_SNAPSHOT_TARGET,
      profile: ANALYSIS_SNAPSHOT_PROFILE,
      operation: "address_name",
      parameters: { address: "0x1000", document: "fixture" },
      execution,
    });
    const evidence = createEvidence(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        operation: "address_name",
        parameters: { address: "0x1000", document: "fixture" },
        result: "main",
        rawResult: "main",
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
      },
    );
    const exported = cache.export(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROFILE,
      createEvidenceBundle([evidence]),
    );
    if (!exported.ok) throw exported.error;
    const tampered = structuredClone(exported.value);
    const tamperedEntry = tampered.entries[0];
    if (tamperedEntry === undefined)
      throw new Error("exported snapshot entry missing");
    tamperedEntry.execution.result = "changed without Evidence";
    let mergedEvidence = false;
    expect(
      new AnalysisSnapshotCache().import(tampered, undefined, () => {
        mergedEvidence = true;
        return ok(0);
      }).ok,
    ).toBe(false);
    expect(mergedEvidence).toBe(false);
    const entry = exported.value.entries[0];
    if (entry === undefined) throw new Error("exported snapshot entry missing");
    Reflect.set(entry.execution, "provider", {
      id: "forged",
      name: "Forged",
      version: "9",
    });
    entry.execution.limitations.push("forged");

    expect(
      cache.lookup(
        ANALYSIS_SNAPSHOT_TARGET,
        ANALYSIS_SNAPSHOT_PROFILE,
        "address_name",
        { address: "0x1000", document: "fixture" },
      ),
    ).toMatchObject({
      provider: ANALYSIS_SNAPSHOT_PROVIDER,
      analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
      limitations: [expect.stringContaining("local REA analysis snapshot")],
    });
    const changedProfile = createAnalysisProfile(ANALYSIS_SNAPSHOT_PROVIDER, {
      loader: "configured-override",
    });
    expect(
      cache.lookup(ANALYSIS_SNAPSHOT_TARGET, changedProfile, "address_name", {
        address: "0x1000",
        document: "fixture",
      }),
    ).toBeUndefined();
    const changedProviderProfile = createAnalysisProfile(
      { id: "other", name: "Other", version: "1" },
      { loader: "mach-o-arm64" },
    );
    expect(
      cache.lookup(
        ANALYSIS_SNAPSHOT_TARGET,
        changedProviderProfile,
        "address_name",
        { address: "0x1000", document: "fixture" },
      ),
    ).toBeUndefined();
  });
});

describe("relationship coverage snapshot replay", () => {
  it("authenticates relationship coverage and replays legacy reads as unknown", () => {
    const cache = new AnalysisSnapshotCache();
    const operation = "procedure_callees" as const;
    const parameters = { procedure: "0x1000", document: "fixture" };
    const coverage = {
      status: "complete" as const,
      diagnostics: ["The provider retained an unresolved call target."],
    };
    const execution = createAnalysisExecution(
      ["0x2000"],
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
        rawResult: ["0x2000"],
        relationshipCoverage: coverage,
        subject: {
          path: ANALYSIS_SNAPSHOT_TARGET.path,
          sha256: ANALYSIS_SNAPSHOT_TARGET.sha256,
          format: ANALYSIS_SNAPSHOT_TARGET.format,
          ...(ANALYSIS_SNAPSHOT_TARGET.architecture === undefined
            ? {}
            : { architecture: ANALYSIS_SNAPSHOT_TARGET.architecture }),
        },
      },
    );
    cache.record({
      target: ANALYSIS_SNAPSHOT_TARGET,
      profile: ANALYSIS_SNAPSHOT_PROFILE,
      operation,
      parameters,
      execution,
    });
    const evidence = createEvidence(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        operation,
        parameters,
        result: ["0x2000"],
        rawResult: ["0x2000"],
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
        relationshipCoverage: coverage,
      },
    );
    const exported = cache.export(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROFILE,
      createEvidenceBundle([evidence]),
    );
    if (!exported.ok) throw exported.error;
    expect(
      cache.lookup(
        ANALYSIS_SNAPSHOT_TARGET,
        ANALYSIS_SNAPSHOT_PROFILE,
        operation,
        parameters,
      )?.relationshipCoverage,
    ).toEqual(coverage);

    const tampered = structuredClone(exported.value);
    const tamperedEntry = tampered.entries[0];
    if (tamperedEntry === undefined) throw new Error("snapshot entry missing");
    tamperedEntry.execution.relationship_coverage = {
      status: "complete",
      diagnostics: ["forged coverage"],
    };
    expect(
      new AnalysisSnapshotCache().import(tampered, undefined, () => ok(0)).ok,
    ).toBe(false);

    const legacy = structuredClone(exported.value);
    const legacyEntry = legacy.entries[0];
    if (legacyEntry === undefined) throw new Error("snapshot entry missing");
    Reflect.deleteProperty(legacyEntry.execution, "relationship_coverage");
    const legacyEvidence = createEvidence(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROVIDER,
      {
        operation,
        parameters,
        result: ["0x2000"],
        rawResult: ["0x2000"],
        analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
      },
    );
    Reflect.deleteProperty(legacyEvidence, "relationship_coverage");
    legacy.evidence_bundle = createEvidenceBundle([legacyEvidence]);
    parseAnalysisSnapshot(legacy);
    const replayCache = new AnalysisSnapshotCache();
    expect(replayCache.import(legacy, undefined, () => ok(0)).ok).toBe(true);
    expect(
      replayCache.lookup(
        ANALYSIS_SNAPSHOT_TARGET,
        ANALYSIS_SNAPSHOT_PROFILE,
        operation,
        parameters,
      )?.relationshipCoverage,
    ).toEqual({
      status: "unknown",
      reason: "Snapshot entry does not report relationship coverage.",
    });
  });
});

it("does not replay pre-envelope call graphs under the revised workflow profile", () => {
  const cache = new AnalysisSnapshotCache();
  const target = ANALYSIS_SNAPSHOT_TARGET;
  const profile = ANALYSIS_SNAPSHOT_PROFILE;
  const operation = "get_call_graph" as const;
  const parameters = { address: "0x1000", direction: "forward" };
  const oldProfile = workflowAnalysisProfile(profile);
  const revisedProfile = workflowAnalysisProfile(profile, operation);
  const oldResult = { "0": [] };
  cache.recordWorkflow({
    target,
    profile,
    operation,
    parameters,
    execution: {
      ...createAnalysisExecution(oldResult, REA_WORKFLOW_PROVIDER, {
        subject: target,
        rawResult: oldResult,
      }),
      analysisProfile: oldProfile,
    },
  });
  const evidence = createEvidence(target, REA_WORKFLOW_PROVIDER, {
    operation,
    confidence: "derived",
    parameters,
    result: oldResult,
    rawResult: oldResult,
    analysisProfile: oldProfile,
  });
  const exported = cache.export(
    target,
    profile,
    createEvidenceBundle([evidence]),
  );
  if (!exported.ok) throw exported.error;
  const snapshot = parseAnalysisSnapshot(exported.value);

  expect(
    snapshotEvidenceForQuery(snapshot, {
      target,
      bindingProfile: profile,
      operation,
      parameters,
      provider: REA_WORKFLOW_PROVIDER,
      evidenceProfile: revisedProfile,
    }),
  ).toBeUndefined();
  expect(
    enhancedOutputSchemas.get_call_graph?.safeParse({
      normalized_result: oldResult,
    }).success,
  ).toBe(false);
});

describe("executions that report truncated references", () => {
  const record = (referencesTruncated: boolean | undefined) => {
    const cache = new AnalysisSnapshotCache();
    const parameters = { address: "0x1000", document: "fixture" };
    cache.record({
      target: ANALYSIS_SNAPSHOT_TARGET,
      profile: ANALYSIS_SNAPSHOT_PROFILE,
      operation: "xrefs",
      parameters,
      execution: createAnalysisExecution(
        ["0x2000"],
        ANALYSIS_SNAPSHOT_PROVIDER,
        {
          subject: ANALYSIS_SNAPSHOT_TARGET,
          analysisProfile: ANALYSIS_SNAPSHOT_PROFILE,
          ...(referencesTruncated === undefined ? {} : { referencesTruncated }),
        },
      ),
    });
    return cache.lookup(
      ANALYSIS_SNAPSHOT_TARGET,
      ANALYSIS_SNAPSHOT_PROFILE,
      "xrefs",
      parameters,
    );
  };

  it("are not replayed, because a replay would lose the truncation", () => {
    expect(record(true)).toBeUndefined();
  });

  it("do not stop an execution that is complete or silent from being replayed", () => {
    expect(record(false)?.result).toEqual(["0x2000"]);
    expect(record(undefined)?.result).toEqual(["0x2000"]);
  });
});

it("revises the trace_feature workflow profile so earlier results are not replayed", () => {
  const profile = ANALYSIS_SNAPSHOT_PROFILE;

  expect(workflowAnalysisProfile(profile, "trace_feature")).not.toEqual(
    workflowAnalysisProfile(profile),
  );
  expect(
    workflowAnalysisProfile(profile, "trace_call_path"),
    "other workflows keep their profile",
  ).toEqual(workflowAnalysisProfile(profile));
});
