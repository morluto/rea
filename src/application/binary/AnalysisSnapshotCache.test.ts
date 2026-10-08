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
    if (!exported.ok) throw new Error("snapshot export failed");
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
