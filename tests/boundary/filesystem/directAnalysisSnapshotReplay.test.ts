import { parseConfig } from "../../../src/config/parseConfig.js";
import { symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import type {
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderIdentity,
} from "../../../src/application/AnalysisProvider.js";
import type { DirectAnalysisDependencies } from "../../../src/application/DirectAnalysisDependencies.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { err, ok } from "../../../src/domain/result.js";
import {
  readAnalysisSnapshot,
  writeAnalysisSnapshot,
} from "../../../src/application/binary/AnalysisSnapshotFiles.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import {
  REA_WORKFLOW_PROVIDER,
  workflowAnalysisProfile,
} from "../../../src/application/InvestigationProviders.js";
import {
  createAnalysisSnapshotWorkflowEntry,
  type AnalysisSnapshot,
} from "../../../src/domain/analysisSnapshot.js";
import { withArtifactResourceScope } from "../../fixtures/artifactInventory.js";
import {
  createTestBinarySession,
  createTestProviderRouter,
} from "../../fixtures/binarySession.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { OwnedStagedOutput } from "../../../src/filesystem/OwnedStagedOutput.js";
import { ProviderAdapterError } from "../../../src/domain/providerAdapterError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  CAPABILITIES as GHIDRA_CAPABILITIES,
  GHIDRA_PROVIDER_IDENTITY,
} from "../../../src/ghidra/GhidraProviderCapabilities.js";

const IDENTITY = {
  id: "snapshot-fixture",
  name: "Snapshot Fixture Provider",
  version: "1",
} as const;

const operations = [
  "list_segments",
  "list_documents",
  "list_procedures",
  "list_strings",
] as const;

const workflowProviderOperations = [
  ...operations,
  "analyze_function",
  "list_names",
  "search_strings",
  "search_procedures",
  "xrefs",
  "resolve_containing_procedure",
] as const;

const functionDossier = {
  procedure: {
    address: "0x1000",
    name: "fixture",
    classification: null,
    body: {
      available: false,
      reason: "The provider did not report complete function body ranges.",
    },
    signature: null,
    locals: [],
  },
  pseudocode: "return 0;",
  assembly: ["ret"],
  comments: [],
  callers: [],
  callees: [],
  incoming_references: [],
  outgoing_references: [],
  referenced_strings: [],
  referenced_names: [],
  basic_blocks: [],
  native_api: null,
  native_value_flow: null,
  limitations: [],
};

const expectWorkflowQuestionsRetained = (
  snapshot: AnalysisSnapshot,
  operation: string,
): void => {
  const evidence = snapshot.evidence_bundle.records.find(
    (record) => record.operation === operation,
  );
  const result = evidence?.normalized_result;
  if (
    evidence === undefined ||
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    !Array.isArray(result.residual_unknowns)
  )
    throw new Error("Fixture workflow did not return residual questions");
  expect(result.residual_unknowns.length).toBeGreaterThan(0);
  expect(snapshot.evidence_bundle.unknowns).toEqual(
    expect.arrayContaining(
      result.residual_unknowns.map((question) =>
        expect.objectContaining({
          question,
          supporting_evidence_ids: [evidence.evidence_id],
        }),
      ),
    ),
  );
};

interface SnapshotProviderTrace {
  readonly starts: string[];
  readonly calls: string[];
  readonly resolutions: string[];
}

interface SnapshotProviderOptions {
  readonly profile?: ReturnType<typeof createAnalysisProfile>;
  readonly identity?: ProviderIdentity;
  readonly supportedOperations?: readonly CapabilityDescriptor["operation"][];
}

const makeProvider = (
  trace: SnapshotProviderTrace,
  options: SnapshotProviderOptions = {},
): AnalysisProvider => {
  const profile =
    options.profile ?? createAnalysisProfile(IDENTITY, { fixture: true });
  const identity = options.identity ?? profile.provider;
  const supportedOperations = options.supportedOperations ?? operations;
  const capabilities: CapabilityDescriptor[] = supportedOperations.map(
    (operation) => ({
      operation,
      provider: identity,
      available: true,
      reason: null,
      cachePolicy: "snapshot",
      effects: {
        mutatesArtifact: false,
        launchesProcess: true,
        mayShowUi: false,
        mayAccessNetwork: false,
        mayWriteFilesystem: false,
        changesPermissions: false,
        requiresRoot: false,
      },
      limitations: [],
    }),
  );
  return {
    identity: () => identity,
    capabilities: () => capabilities,
    resolveAnalysisProfile: async () => {
      trace.resolutions.push(profile.digest);
      return ok({ profile });
    },
    createClient: () => {
      trace.starts.push("start");
      return {
        execute: async (operation) => {
          trace.calls.push(operation);
          const results: Readonly<Record<string, unknown>> = {
            health: null,
            list_segments: [
              {
                name: "__TEXT",
                start: "0x1000",
                end: "0x2000",
                readable: null,
                writable: null,
                executable: null,
              },
            ],
            list_documents: ["fixture"],
            list_procedures: ["0x1000"],
            list_strings: { "0x1000": "fixture" },
            analyze_function: functionDossier,
            list_names: [{ address: "0x1000", name: "fixture" }],
            search_strings: [{ address: "0x1000", value: "fixture" }],
            search_procedures: [{ address: "0x1000", value: "fixture" }],
            xrefs: [],
            resolve_containing_procedure: null,
            procedure_pseudo_code: "return 0;",
          };
          if (!Object.hasOwn(results, operation))
            throw new Error(
              `Unmodeled snapshot provider operation: ${operation}`,
            );
          const result = results[operation];
          return ok(
            createAnalysisExecution(result, profile.provider, {
              analysisProfile: profile,
              rawResult: result,
            }),
          );
        },
        close: async () => ok(null),
      };
    },
  };
};

const createSnapshotReplayFixture = async (
  directoryPrefix: string,
  snapshotRelativePath = "snapshot.json",
) => {
  const directory = await createTestTempDirectory(directoryPrefix);
  const path = join(directory, "fixture.hop");
  const snapshotPath = join(directory, snapshotRelativePath);
  await writeFile(path, "fixture");
  const starts: string[] = [];
  const calls: string[] = [];
  const resolutions: string[] = [];

  return {
    path,
    snapshotPath,
    starts,
    calls,
    resolutions,
    createProvider(options: SnapshotProviderOptions = {}): AnalysisProvider {
      return makeProvider({ starts, calls, resolutions }, options);
    },
    dependencies(provider: AnalysisProvider): DirectAnalysisDependencies {
      return {
        readConfiguration: () => parseConfig({}),
        createBinarySession: () => createTestBinarySession(provider),
        createManagedBinarySession: () => createTestBinarySession(provider),
      };
    },
  };
};

const withAlternateWorkflowProfile = (
  snapshot: AnalysisSnapshot,
  path: string,
  current: Evidence,
): AnalysisSnapshot => {
  const alternateProfile = createAnalysisProfile(REA_WORKFLOW_PROVIDER, {
    workflow: "binary_overview",
    fixture: "alternate-profile",
  });
  if (
    typeof current.normalized_result !== "object" ||
    current.normalized_result === null ||
    Array.isArray(current.normalized_result)
  )
    throw new Error("Expected overview object");
  const result = current.normalized_result;
  const subject = {
    path,
    sha256: snapshot.target.sha256,
    format: snapshot.target.format,
    ...(snapshot.target.architecture === null
      ? {}
      : { architecture: snapshot.target.architecture }),
  };
  const alternateEvidence = createEvidence(subject, REA_WORKFLOW_PROVIDER, {
    operation: current.operation,
    parameters: current.parameters,
    result,
    rawResult: current.raw_result,
    analysisProfile: alternateProfile,
    confidence: "derived",
    limitations: current.limitations,
    locations: current.locations,
  });
  const alternateEntry = createAnalysisSnapshotWorkflowEntry({
    target: snapshot.target,
    binding: snapshot.binding,
    operation: current.operation,
    parameters: current.parameters,
    execution: {
      result,
      rawResult: current.raw_result,
      provider: REA_WORKFLOW_PROVIDER,
      analysisProfile: alternateProfile,
      limitations: current.limitations,
      locations: current.locations,
      subject,
    },
  });
  return {
    ...snapshot,
    workflow_entries: [alternateEntry],
    evidence_bundle: createEvidenceBundle([
      ...snapshot.evidence_bundle.records,
      alternateEvidence,
    ]),
  };
};

const withEarlierHistoricalEvidence = (
  snapshot: AnalysisSnapshot,
  path: string,
  current: Evidence,
): AnalysisSnapshot => {
  const older = Array.from({ length: 64 }, (_, index) =>
    createEvidence(
      {
        path,
        sha256: snapshot.target.sha256,
        format: "analysis-database",
      },
      REA_WORKFLOW_PROVIDER,
      {
        operation: "binary_overview",
        parameters: {},
        result: `historical-${index}`,
        analysisProfile: workflowAnalysisProfile(
          snapshot.binding.analysis_profile,
          "binary_overview",
        ),
        confidence: "derived",
        limitations: ["Derived by an REA composed workflow."],
      },
    ),
  ).find((record) => record.evidence_id < current.evidence_id);
  if (older === undefined)
    throw new Error("fixture could not construct earlier historical Evidence");
  return {
    ...snapshot,
    evidence_bundle: createEvidenceBundle([
      ...snapshot.evidence_bundle.records,
      older,
    ]),
  };
};

describe("snapshot output cleanup lifecycle", () => {
  it("returns completed analysis after retrying cleanup of a published snapshot", async () => {
    const fixture = await createSnapshotReplayFixture(
      "rea-snapshot-cleanup-retry-",
    );
    const cleanup = vi
      .spyOn(OwnedStagedOutput.prototype, "close")
      .mockRejectedValueOnce(new Error("transient staging cleanup failure"));
    try {
      const output = await runDirectAnalysis(
        fixture.dependencies(fixture.createProvider()),
        fixture.path,
        "binary_overview",
        {},
        { snapshotPath: fixture.snapshotPath },
      );
      expect(parseEvidence(output).operation).toBe("binary_overview");
      const saved = await readAnalysisSnapshot(fixture.snapshotPath);
      if (!saved.ok) throw saved.error;
      expect(saved.value.workflow_entries).toHaveLength(1);
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally {
      cleanup.mockRestore();
    }
  });

  it("saves snapshots after closing and reopening the same session", async () => {
    const fixture = await createSnapshotReplayFixture("rea-snapshot-reopen-");
    const session = createTestBinarySession(fixture.createProvider());
    try {
      for (const index of [1, 2]) {
        const opened = await session.open(fixture.path);
        if (!opened.ok) throw opened.error;
        const analyzed = await session.execute("list_segments", {});
        if (!analyzed.ok) throw analyzed.error;
        const path = join(
          dirname(fixture.snapshotPath),
          `snapshot-${index}.json`,
        );
        const saved = await session.closeWithSnapshot(path, false);
        if (!saved.ok) throw saved.error;
        const loaded = await readAnalysisSnapshot(path);
        if (!loaded.ok) throw loaded.error;
        expect(loaded.value.target.sha256).toBe(opened.value.sha256);
      }
    } finally {
      const closed = await session.close();
      if (!closed.ok) throw closed.error;
    }
  });
});

const verifyWindowsSnapshotAdmission = async (
  selectedPath: "direct" | "junction",
): Promise<void> => {
  const fixture = await createSnapshotReplayFixture(
    "rea-direct-snapshot-junction-",
  );
  const rawPath = join(dirname(fixture.path), "image.bin");
  await writeFile(rawPath, Buffer.from("a92a60", "hex"));
  const linked = join(dirname(fixture.path), "linked");
  const linkedPath = join(linked, basename(rawPath));
  const identity = { ...GHIDRA_PROVIDER_IDENTITY, version: "12.1.4" };
  const profile = createAnalysisProfile(identity, {
    fixture: true,
  });
  const baseProvider = fixture.createProvider({
    identity,
    profile,
    supportedOperations: ["search_strings"],
  });
  let rejectAdmission = false;
  const provider: AnalysisProvider = {
    ...baseProvider,
    createClient: (target, profile, context) => {
      const client = baseProvider.createClient(target, profile, context);
      return {
        ...client,
        execute: (operation, parameters, options) =>
          rejectAdmission && operation === "search_strings"
            ? Promise.resolve(
                err(new ProviderAdapterError("ghidra", operation)),
              )
            : client.execute(operation, parameters, options),
      };
    },
  };
  const dependencies = fixture.dependencies(provider);
  const arguments_ = { pattern: "fixture", document: "fixture" };
  const options = {
    snapshotPath: fixture.snapshotPath,
    formatHint: "raw-binary" as const,
    architecture: "6502" as const,
    entryPoint: "0x8001",
  };
  const first = await runDirectAnalysis(
    dependencies,
    rawPath,
    "search_strings",
    arguments_,
    options,
  );
  expect(first).toMatchObject({ operation: "search_strings" });
  expect(fixture.starts).toHaveLength(1);
  if (selectedPath === "junction")
    await symlink(dirname(fixture.path), linked, "junction");
  rejectAdmission = true;
  const second = await runDirectAnalysis(
    dependencies,
    selectedPath === "junction" ? linkedPath : rawPath,
    "search_strings",
    arguments_,
    options,
  );
  expect(second).toMatchObject({ error: "Analysis failed" });
  expect(fixture.starts).toHaveLength(2);
  expect(
    fixture.calls.filter((call) => call === "search_strings"),
  ).toHaveLength(1);
};

describe("direct analysis composed snapshot replay", () => {
  it.skipIf(process.platform !== "win32")(
    "does not replay a CLI snapshot through a Windows junction",
    () => verifyWindowsSnapshotAdmission("junction"),
  );
  it.skipIf(process.platform !== "win32")(
    "does not replay a CLI snapshot before native admission on a canonical path",
    () => verifyWindowsSnapshotAdmission("direct"),
  );

  it.each([
    {
      tool: "search_strings",
      arguments: { pattern: "uncached", document: "fixture" },
    },
    { tool: "inspect_native_api", arguments: { procedure: "0x2000" } },
  ] as const)(
    "reuses the previewed profile on a $tool snapshot miss",
    async (scenario) => {
      const fixture = await createSnapshotReplayFixture(
        "rea-snapshot-miss-route-",
      );
      const profile = createAnalysisProfile(IDENTITY, { fixture: true });
      const provider = fixture.createProvider({
        profile,
        identity: IDENTITY,
        supportedOperations: workflowProviderOperations,
      });
      const dependencies = fixture.dependencies(provider);
      await runDirectAnalysis(
        dependencies,
        fixture.path,
        "binary_overview",
        {},
        { snapshotPath: fixture.snapshotPath },
      );
      expect(fixture.resolutions).toHaveLength(1);

      const first = await runDirectAnalysis(
        dependencies,
        fixture.path,
        scenario.tool,
        scenario.arguments,
        { snapshotPath: fixture.snapshotPath },
      );
      expect(first).toMatchObject({ operation: scenario.tool });
      expect(fixture.resolutions).toHaveLength(2);
      expect(fixture.starts).toHaveLength(2);
      const callsAfterMiss = [...fixture.calls];

      const replay = await runDirectAnalysis(
        dependencies,
        fixture.path,
        scenario.tool,
        scenario.arguments,
        { snapshotPath: fixture.snapshotPath },
      );
      expect(replay).toEqual(first);
      expect(fixture.resolutions).toHaveLength(3);
      expect(fixture.starts).toHaveLength(2);
      expect(fixture.calls).toEqual(callsAfterMiss);
    },
  );

  for (const scenario of [
    {
      tool: "inspect_native_api",
      arguments: { procedure: "0x1000" },
    },
    {
      tool: "inspect_native_dispatch_metadata",
      arguments: {},
    },
    {
      tool: "trace_feature",
      arguments: { query: "fixture" },
    },
    {
      tool: "trace_native_values",
      arguments: { procedure: "0x1000" },
    },
  ] as const) {
    it(`persists and replays ${scenario.tool} without provider startup`, async () => {
      const fixture = await createSnapshotReplayFixture(
        "rea-workflow-command-",
      );
      const provider = fixture.createProvider({
        identity: IDENTITY,
        supportedOperations: workflowProviderOperations,
      });
      const dependencies = fixture.dependencies(provider);
      const first = await runDirectAnalysis(
        dependencies,
        fixture.path,
        scenario.tool,
        scenario.arguments,
        { snapshotPath: fixture.snapshotPath },
      );
      const callsAfterFirst = [...fixture.calls];
      const startsAfterFirst = [...fixture.starts];
      const loaded = await readAnalysisSnapshot(fixture.snapshotPath);
      if (!loaded.ok) throw loaded.error;
      expect(
        loaded.value.workflow_entries.map(({ operation }) => operation),
      ).toContain(scenario.tool);
      if (scenario.tool === "inspect_native_api")
        expectWorkflowQuestionsRetained(loaded.value, scenario.tool);

      const second = await runDirectAnalysis(
        dependencies,
        fixture.path,
        scenario.tool,
        scenario.arguments,
        { snapshotPath: fixture.snapshotPath },
      );

      expect(second).toEqual(first);
      expect(fixture.calls).toEqual(callsAfterFirst);
      expect(fixture.starts).toEqual(startsAfterFirst);
    });
  }
});

describe("Ghidra composed workflow snapshot replay", () => {
  it.each([
    { tool: "binary_overview", arguments: {} },
    { tool: "inspect_native_api", arguments: { procedure: "0x1000" } },
    { tool: "trace_feature", arguments: { query: "fixture" } },
  ] as const)(
    "persists $tool with production Ghidra capability policies",
    async ({ tool, arguments: parameters }) => {
      const fixture = await createSnapshotReplayFixture("rea-ghidra-workflow-");
      const profile = createAnalysisProfile(
        { ...GHIDRA_PROVIDER_IDENTITY, version: "12.1.4" },
        { fixture: true },
      );
      const provider: AnalysisProvider = {
        ...fixture.createProvider({
          profile,
          identity: GHIDRA_PROVIDER_IDENTITY,
        }),
        capabilities: () => GHIDRA_CAPABILITIES,
      };
      const dependencies = fixture.dependencies(provider);
      const first = await runDirectAnalysis(
        dependencies,
        fixture.path,
        tool,
        parameters,
        { snapshotPath: fixture.snapshotPath },
      );
      expect(first).toMatchObject({ operation: tool });
      const snapshot = await readAnalysisSnapshot(fixture.snapshotPath);
      if (!snapshot.ok) throw snapshot.error;
      expect(snapshot.value.workflow_entries).toEqual([
        expect.objectContaining({ operation: tool }),
      ]);
      const initialCalls = [...fixture.calls];

      const replay = await runDirectAnalysis(
        dependencies,
        fixture.path,
        tool,
        parameters,
        { snapshotPath: fixture.snapshotPath },
      );
      expect(replay).toEqual(first);
      if (process.platform === "win32") {
        // The first provider call in a new CLI session admits its source.
        expect(fixture.starts).toHaveLength(2);
        expect(fixture.calls.length).toBeGreaterThan(initialCalls.length);
      } else {
        expect(fixture.starts).toHaveLength(1);
        expect(fixture.calls).toEqual(initialCalls);
      }
    },
  );
});

describe("binary overview snapshot replay", () => {
  it("replays the identical binary overview without provider startup or calls", async () => {
    const fixture = await createSnapshotReplayFixture("rea-workflow-snapshot-");
    const provider = fixture.createProvider();
    const dependencies = fixture.dependencies(provider);

    const first = await runDirectAnalysis(
      dependencies,
      fixture.path,
      "binary_overview",
      {},
      { snapshotPath: fixture.snapshotPath },
    );
    expect(fixture.calls.toSorted()).toEqual(operations.toSorted());
    expect(fixture.starts).toHaveLength(1);

    const loaded = await readAnalysisSnapshot(fixture.snapshotPath);
    if (!loaded.ok) throw loaded.error;
    expect(loaded.value.workflow_entries).toHaveLength(1);
    const current = loaded.value.evidence_bundle.records.find(
      (record) => record.operation === "binary_overview",
    );
    if (current === undefined)
      throw new Error("composed Evidence was not saved");
    const written = await withArtifactResourceScope((resources) =>
      writeAnalysisSnapshot(
        withEarlierHistoricalEvidence(loaded.value, fixture.path, current),
        fixture.snapshotPath,
        true,
        resources,
      ),
    );
    if (!written.ok) throw written.error;

    const second = await runDirectAnalysis(
      dependencies,
      fixture.path,
      "binary_overview",
      {},
      { snapshotPath: fixture.snapshotPath },
    );
    expect(second).toEqual(first);
    expect(fixture.calls.toSorted()).toEqual(operations.toSorted());
    expect(fixture.starts).toHaveLength(1);

    const relocatedPath = join(dirname(fixture.path), "relocated.hop");
    await writeFile(relocatedPath, "fixture");
    const relocated = await runDirectAnalysis(
      dependencies,
      relocatedPath,
      "binary_overview",
      {},
      { snapshotPath: fixture.snapshotPath },
    );
    const firstEvidence = parseEvidence(first);
    const relocatedEvidence = parseEvidence(relocated);
    expect(relocatedEvidence).toMatchObject({
      evidence_id: firstEvidence.evidence_id,
      subject: {
        local_path: relocatedPath,
        name: basename(relocatedPath),
      },
    });
    expect(relocatedEvidence.normalized_result).toEqual(
      firstEvidence.normalized_result,
    );
    expect(relocatedEvidence.raw_result).toEqual(firstEvidence.raw_result);
    expect(relocatedEvidence.locations).toEqual(firstEvidence.locations);
    expect(fixture.calls.toSorted()).toEqual(operations.toSorted());
    expect(fixture.starts).toHaveLength(1);

    const persisted = await readAnalysisSnapshot(fixture.snapshotPath);
    if (!persisted.ok) throw persisted.error;
    expect(
      persisted.value.evidence_bundle.records.find(
        (record) => record.evidence_id === firstEvidence.evidence_id,
      )?.subject?.local_path,
    ).toBe(fixture.path);
  });
});

describe("snapshot replay provider identity", () => {
  it("uses the resolved provider version when capability metadata omits it", async () => {
    const fixture = await createSnapshotReplayFixture("rea-profile-version-");
    const unresolvedIdentity = { ...IDENTITY, version: null };
    const resolvedProfile = createAnalysisProfile(
      { ...IDENTITY, version: "launcher-sha256:fixture" },
      { fixture: true },
    );
    const provider = fixture.createProvider({
      profile: resolvedProfile,
      identity: unresolvedIdentity,
      supportedOperations: ["search_strings"],
    });
    const dependencies = fixture.dependencies(provider);
    const first = await runDirectAnalysis(
      dependencies,
      fixture.path,
      "search_strings",
      { pattern: "fixture", document: "fixture" },
      { snapshotPath: fixture.snapshotPath },
    );
    const callsAfterFirst = [...fixture.calls];
    const startsAfterFirst = [...fixture.starts];
    const firstSnapshot = await readAnalysisSnapshot(fixture.snapshotPath);
    if (!firstSnapshot.ok) throw firstSnapshot.error;
    expect(firstSnapshot.value.entries[0]?.execution.provider.version).toBe(
      "launcher-sha256:fixture",
    );

    const second = await runDirectAnalysis(
      dependencies,
      fixture.path,
      "search_strings",
      { pattern: "fixture", document: "fixture" },
      { snapshotPath: fixture.snapshotPath },
    );
    expect(fixture.calls).toEqual(callsAfterFirst);
    expect(fixture.starts).toEqual(startsAfterFirst);
    expect(second).toEqual(first);

    const changedProfileProvider = fixture.createProvider({
      profile: createAnalysisProfile(
        { ...IDENTITY, version: "launcher-sha256:changed" },
        { fixture: true },
      ),
      identity: unresolvedIdentity,
      supportedOperations: ["search_strings"],
    });
    const changedProfileResult = await runDirectAnalysis(
      fixture.dependencies(changedProfileProvider),
      fixture.path,
      "search_strings",
      { pattern: "fixture", document: "fixture" },
      { snapshotPath: fixture.snapshotPath },
    );
    expect(changedProfileResult).not.toEqual(first);
    expect(changedProfileResult).toMatchObject({
      code: "evidence_integrity_mismatch",
    });
    expect(fixture.starts).toEqual(startsAfterFirst);
    expect(fixture.calls).toEqual(callsAfterFirst);

    const changedProviderIdentity = {
      id: "other-provider",
      name: "Other Provider",
      version: null,
    };
    const changedProvider = fixture.createProvider({
      profile: createAnalysisProfile(
        { ...changedProviderIdentity, version: "other-version" },
        { fixture: true },
      ),
      identity: changedProviderIdentity,
      supportedOperations: ["search_strings"],
    });
    const changedProviderResult = await runDirectAnalysis(
      fixture.dependencies(changedProvider),
      fixture.path,
      "search_strings",
      { pattern: "fixture", document: "fixture" },
      { snapshotPath: fixture.snapshotPath },
    );
    expect(changedProviderResult).not.toEqual(first);
    expect(changedProviderResult).toMatchObject({
      code: "evidence_integrity_mismatch",
    });
    expect(fixture.starts).toEqual(startsAfterFirst);
    expect(fixture.calls).toEqual(callsAfterFirst);
  });
});

const assertEvidenceSurvivesSnapshotSaveFailure = async (): Promise<void> => {
  const fixture = await createSnapshotReplayFixture(
    "rea-workflow-save-error-",
    join("missing", "snapshot.json"),
  );
  const provider = fixture.createProvider();
  const dependencies = fixture.dependencies(provider);

  const result = await runDirectAnalysis(
    dependencies,
    fixture.path,
    "binary_overview",
    {},
    { snapshotPath: fixture.snapshotPath },
  );

  expect(result).toMatchObject({
    code: "invalid_request",
    details: {
      partial_observation: {
        operation: "binary_overview",
        subject: { local_path: fixture.path },
      },
    },
  });
  const partial = z
    .object({
      details: z.object({ partial_observation: z.unknown() }),
    })
    .parse(result).details.partial_observation;
  expect(parseEvidence(partial).operation).toBe("binary_overview");
  expect(fixture.calls.toSorted()).toEqual(operations.toSorted());
};

describe("workflow snapshot profile and cancellation binding", () => {
  it(
    "preserves completed Evidence when CLI snapshot persistence fails",
    assertEvidenceSurvivesSnapshotSaveFailure,
  );
  it("does not replay a valid entry from a different workflow profile", async () => {
    const fixture = await createSnapshotReplayFixture("rea-workflow-profile-");
    const provider = fixture.createProvider();
    const dependencies = fixture.dependencies(provider);
    await runDirectAnalysis(
      dependencies,
      fixture.path,
      "binary_overview",
      {},
      { snapshotPath: fixture.snapshotPath },
    );
    const loaded = await readAnalysisSnapshot(fixture.snapshotPath);
    if (!loaded.ok) throw loaded.error;
    const current = loaded.value.evidence_bundle.records.find(
      (record) => record.operation === "binary_overview",
    );
    if (current === undefined)
      throw new Error("composed Evidence was not saved");
    const written = await withArtifactResourceScope((resources) =>
      writeAnalysisSnapshot(
        withAlternateWorkflowProfile(loaded.value, fixture.path, current),
        fixture.snapshotPath,
        true,
        resources,
      ),
    );
    if (!written.ok) throw written.error;

    const refreshed = await runDirectAnalysis(
      dependencies,
      fixture.path,
      "binary_overview",
      {},
      { snapshotPath: fixture.snapshotPath },
    );
    expect(refreshed).toMatchObject({
      normalized_result: { document: "fixture" },
    });
    expect(fixture.calls.toSorted()).toEqual(
      [...operations, ...operations].toSorted(),
    );
    expect(fixture.starts).toHaveLength(2);
  });

  it("does not return a cached result when cancelled during route resolution", async () => {
    const fixture = await createSnapshotReplayFixture("rea-workflow-cancel-");
    const provider = fixture.createProvider();
    const initialDependencies = fixture.dependencies(provider);
    await runDirectAnalysis(
      initialDependencies,
      fixture.path,
      "binary_overview",
      {},
      { snapshotPath: fixture.snapshotPath },
    );

    const controller = new AbortController();
    const router = createTestProviderRouter(provider);
    const resolve = router.resolve.bind(router);
    router.resolve = async (...arguments_) => {
      const resolved = await resolve(...arguments_);
      controller.abort();
      return resolved;
    };
    const session = new BinarySession(router);
    const dependencies: DirectAnalysisDependencies = {
      readConfiguration: () => parseConfig({}),
      createBinarySession: () => session,
      createManagedBinarySession: () => session,
    };
    const result = await runDirectAnalysis(
      dependencies,
      fixture.path,
      "binary_overview",
      {},
      { snapshotPath: fixture.snapshotPath, signal: controller.signal },
    );

    expect(result).toMatchObject({
      error: "Analysis failed",
      code: "cancelled",
    });
    expect(fixture.calls.toSorted()).toEqual(operations.toSorted());
    expect(fixture.starts).toHaveLength(1);
  });
});
