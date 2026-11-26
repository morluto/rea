import { expect, it } from "vitest";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import {
  createEvidence,
  withEvidenceProviderSelection,
} from "../../domain/evidence.js";
import {
  createAnalysisExecution,
  type AnalysisProvider,
  type AnalysisExecution,
  type CapabilityDescriptor,
} from "../../ports/AnalysisProvider.js";
import { ok, err } from "../../domain/result.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { executeWithNativeSymbolSelection } from "../NativeSymbolSelection.js";
import { parseConfig } from "../../config/parseConfig.js";
import {
  executeComposedWorkflow,
  createWorkflowEvidence,
} from "../WorkflowEvidence.js";
import { runDirectAnalysis } from "../DirectAnalysis.js";
import {
  summarizeOverBudgetEvidence,
  summarizeRetainedAnalysis,
} from "../analysisView/AnalysisViewService.js";
import { executeFunctionAnalysisEvidence } from "../FunctionAnalysisEvidence.js";
import { ghidraFunctionDossier } from "../../domain/ghidraValues.fixture.js";
import {
  completedOperationEvidence,
  bindFreshNativeExecution,
} from "./SessionEvidenceReuse.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
  createTestProviderRouter,
} from "../../../tests/fixtures/binarySession.js";

const fixture = (id: string) => {
  const identity = { id, name: `${id} fixture`, version: "1" };
  const profile = createAnalysisProfile(identity, { fixture: true });
  const calls: string[] = [];
  const capability = (
    operation: "address_name" | "read_bytes" | "list_names" | "xrefs",
  ): CapabilityDescriptor => ({
    provider: identity,
    operation,
    available: true,
    reason: null,
    effects: {
      mutatesArtifact: false,
      launchesProcess: false,
      mayShowUi: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: operation === "read_bytes",
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: [],
  });
  const provider: AnalysisProvider = {
    identity: () => identity,
    resolveAnalysisProfile: async () => ok({ profile }),
    capabilities: () => [
      capability("address_name"),
      capability("read_bytes"),
      capability("list_names"),
      capability("xrefs"),
    ],
    createClient: () => ({
      execute: async (operation, parameters) => {
        calls.push(operation);
        if (operation === "list_names")
          return ok(
            createAnalysisExecution(
              [{ address: "0x1000", value: "entry" }],
              identity,
            ),
          );
        if (operation === "xrefs")
          return parameters.address === "0x1000"
            ? ok(createAnalysisExecution([], identity))
            : err(
                new AnalysisInputError(
                  operation,
                  { conformsToInputContract: true },
                  [{ path: ["address"], reason: "invalid_value" }],
                ),
              );
        return ok(createAnalysisExecution(operation, identity));
      },
      close: async () => ok(null),
    }),
  };
  return { session: createTestBinarySession(provider), calls, provider };
};

it.each(["hopper", "ghidra", "ida", "kuna"])(
  "attributes fresh %s materializations and preserves historical replay",
  async (id) => {
    const [path] = await createBinarySessionTargets();
    const { session, calls } = fixture(id);
    try {
      const opened = await session.open(path, { providerId: id });
      if (!opened.ok) throw opened.error;
      const unselectedSource = createEvidence(
        opened.value,
        { id: "rea", name: "REA", version: null },
        {
          operation: "derived_fixture",
          parameters: {},
          result: "historical source",
        },
      );
      expect(session.recordEvidence(unselectedSource).ok).toBe(true);
      expect(
        session.evidenceForAnalysis(unselectedSource.evidence_id)
          ?.provider_selection,
      ).toBeUndefined();
      const parameters = { address: "0x1000", document: "fixture" };
      const executed = await session.execute("address_name", parameters);
      if (!executed.ok) throw executed.error;
      const materialize = (execution: AnalysisExecution) =>
        completedOperationEvidence("address_name", parameters, execution, {
          target: opened.value,
          admitRecovery: session.admitRecoveryObservation.bind(session),
          evidenceById: (evidenceId) => session.evidenceForAnalysis(evidenceId),
        });
      const fresh = materialize(executed.value);
      if (!fresh.ok) throw fresh.error;
      expect(fresh.value.provider_selection).toMatchObject({
        selection_source: "request",
        candidates: [
          expect.objectContaining({
            provider: expect.objectContaining({ id }),
            selected: true,
          }),
        ],
      });
      expect(fresh.value.evidence_id).toBe(executed.value.evidenceId);
      const historical = withEvidenceProviderSelection(fresh.value, {
        ...fresh.value.provider_selection!,
        selection_source: "environment",
      });
      expect(
        session.importEvidenceBundle(createEvidenceBundle([historical])).ok,
      ).toBe(true);
      const replay = await session.execute("address_name", parameters);
      if (!replay.ok) throw replay.error;
      const restored = materialize(replay.value);
      if (!restored.ok) throw restored.error;
      expect(restored.value.evidence_id).not.toBe(fresh.value.evidence_id);
      expect(restored.value.evidence_links).toContain(fresh.value.evidence_id);
      expect(restored.value.normalized_result).toEqual(
        fresh.value.normalized_result,
      );
      expect(restored.value.provider_selection).toEqual(
        historical.provider_selection,
      );
      expect(
        calls.filter((operation) => operation === "address_name"),
      ).toHaveLength(1);
      const generic = { ...historical };
      delete generic.provider_selection;
      expect(session.recordEvidence(generic).ok).toBe(true);
      expect(
        session.evidenceForAnalysis(generic.evidence_id)?.provider_selection,
      ).toEqual(historical.provider_selection);
      const legacy = { ...historical };
      delete legacy.provider_selection;
      expect(
        session.importEvidenceBundle(createEvidenceBundle([legacy])).ok,
      ).toBe(true);
      const oldReplay = await session.execute("address_name", parameters);
      if (!oldReplay.ok) throw oldReplay.error;
      const absent = materialize(oldReplay.value);
      if (!absent.ok) throw absent.error;
      expect(absent.value.provider_selection).toBeUndefined();
    } finally {
      await session.dispose();
    }
  },
);

it("tags nonretainable native output only when it is materialized, without extra retention", async () => {
  const [path] = await createBinarySessionTargets();
  const { session } = fixture("ghidra");
  try {
    const opened = await session.open(path, { providerId: "ghidra" });
    if (!opened.ok) throw opened.error;
    const parameters = { address: "0x1000" };
    const executed = await session.execute("read_bytes", parameters);
    if (!executed.ok) throw executed.error;
    expect(executed.value.evidenceId).toBeUndefined();
    expect(session.exportEvidenceBundle().records).toHaveLength(0);
    // Materialize after the active route is gone: provenance belongs to the dispatch.
    expect((await session.close()).ok).toBe(true);
    const materialized = completedOperationEvidence(
      "read_bytes",
      parameters,
      executed.value,
      {
        target: opened.value,
        admitRecovery: session.admitRecoveryObservation.bind(session),
      },
    );
    if (!materialized.ok) throw materialized.error;
    expect(materialized.value.provider_selection?.selection_source).toBe(
      "request",
    );
    expect(session.exportEvidenceBundle().records).toHaveLength(0);
  } finally {
    await session.dispose();
  }
});

it.each([
  "artifact-graph",
  "browser",
  "managed-static",
  "rea-composed-workflow",
])(
  "does not infer native selection for %s output or generic source retention",
  async (id) => {
    const [path] = await createBinarySessionTargets();
    const { session } = fixture(id);
    try {
      const opened = await session.open(path, { providerId: id });
      if (!opened.ok) throw opened.error;
      const executed = await session.execute("address_name", {
        address: "0x1000",
        document: "fixture",
      });
      if (!executed.ok) throw executed.error;
      for (const record of session.exportEvidenceBundle().records)
        expect(record.provider_selection).toBeUndefined();
    } finally {
      await session.dispose();
    }
  },
);

it("carries native proof through function materialization but not arbitrary execution copies", async () => {
  const [path] = await createBinarySessionTargets();
  const { session, provider } = fixture("ghidra");
  try {
    const opened = await session.open(path, { providerId: "ghidra" });
    if (!opened.ok) throw opened.error;
    const route = await createTestProviderRouter(provider).resolve(
      opened.value,
      "ghidra",
    );
    if (!route.ok) throw route.error;
    const raw = createAnalysisExecution(
      ghidraFunctionDossier(),
      provider.identity(),
      {
        subject: opened.value,
        ...(route.value.profile === null
          ? {}
          : { analysisProfile: route.value.profile }),
      },
    );
    const captured = bindFreshNativeExecution(raw, route.value);
    const result = await executeFunctionAnalysisEvidence(
      { execute: async () => ok(captured) },
      { procedure: "fixture_main" },
      opened.value,
      undefined,
      { admitRecovery: session.admitRecoveryObservation.bind(session) },
    );
    if (!result.ok) throw result.error;
    expect(result.value.provider_selection?.selection_source).toBe("request");
    const summary = summarizeOverBudgetEvidence(result.value);
    if (!summary.ok) throw summary.error;
    expect(summary.value.provider_selection).toBeUndefined();
    expect(summary.value.evidence_links).toContain(result.value.evidence_id);
    const retainedSummary = summarizeRetainedAnalysis(result.value, {
      recordEvidence: session.recordEvidence.bind(session),
      evidenceById: session.evidenceForAnalysis.bind(session),
    });
    if (!retainedSummary.ok) throw retainedSummary.error;
    expect(retainedSummary.value.provider_selection).toBeUndefined();
    expect(retainedSummary.value.evidence_links).toContain(
      result.value.evidence_id,
    );
    const copy = completedOperationEvidence(
      "analyze_function",
      { procedure: "fixture_main" },
      { ...captured },
      { target: opened.value },
    );
    if (!copy.ok) throw copy.error;
    expect(copy.value.provider_selection).toBeUndefined();
    const unknownVersion = bindFreshNativeExecution(
      createAnalysisExecution(
        "native value",
        { ...provider.identity(), version: null },
        { subject: opened.value },
      ),
      route.value,
    );
    const unknown = completedOperationEvidence(
      "read_bytes",
      {},
      unknownVersion,
      { target: opened.value },
    );
    if (!unknown.ok) throw unknown.error;
    expect(unknown.value.provider.version).toBeNull();
    expect(unknown.value.provider_selection?.selection_source).toBe("request");
  } finally {
    await session.dispose();
  }
});

it("keeps native CLI materialization provenance and the exact caller path", async () => {
  const [path] = await createBinarySessionTargets();
  const { session } = fixture("ghidra");
  const createSession = () => session;
  const result = await runDirectAnalysis(
    {
      readConfiguration: () => parseConfig({}),
      createBinarySession: createSession,
      createArtifactBinarySession: createSession,
      createNativeDispatchBinarySession: createSession,
      createNativeBinarySession: createSession,
      createManagedBinarySession: createSession,
    },
    path,
    "read_bytes",
    { address: "0x1000", length: 1 },
    { providerId: "ghidra" },
  );
  if (!result.ok) throw result.error;
  expect(result.value.provider_selection?.selection_source).toBe("request");
  expect(result.value.caller_input_path).toBe(path);
  expect(session.activeTarget()).toBeUndefined();
});

it.each(["ghidra", "managed-static"])(
  "preserves %s provenance when a workflow materializes a noncacheable source",
  async (id) => {
    const [path] = await createBinarySessionTargets();
    const { session } = fixture(id);
    try {
      const opened = await session.open(path, { providerId: id });
      if (!opened.ok) throw opened.error;
      const parameters = { address: "0x1000", length: 1 };
      let issued: AnalysisExecution | undefined;
      const composed = await executeComposedWorkflow(
        session,
        async (observed) => {
          const result = await observed.execute("read_bytes", parameters, {
            retainEvidence: true,
          });
          if (!result.ok) return result;
          issued = result.value;
          return ok({ source: result.value.evidenceId ?? null });
        },
      );
      if (!composed.ok) throw composed.error;
      expect(composed.sourceEvidence).toHaveLength(1);
      const source = composed.sourceEvidence![0]!;
      expect(source.operation).toBe("read_bytes");
      expect(source.provider_selection?.selection_source).toBe(
        id === "ghidra" ? "request" : undefined,
      );
      expect(composed.value.evidenceLinks).toContain(source.evidence_id);
      expect(session.exportEvidenceBundle().records).toHaveLength(0);
      if (issued === undefined)
        throw new Error("Expected the workflow's completed execution");
      const rematerialized = completedOperationEvidence(
        "read_bytes",
        parameters,
        issued,
        { target: opened.value },
      );
      if (!rematerialized.ok) throw rematerialized.error;
      expect(rematerialized.value.provider_selection).toEqual(
        source.provider_selection,
      );
      expect(rematerialized.value.evidence_id).toBe(source.evidence_id);
      expect(session.recordEvidence(source).ok).toBe(true);
      const derived = createWorkflowEvidence({
        target: opened.value,
        operation: "trace_call_path",
        parameters: {},
        result: composed.value.result,
        upstreamProfile: session.analysisProfile() ?? undefined,
        upstreamEvidenceLinks: composed.value.evidenceLinks ?? [],
        upstreamLimitations: composed.value.limitations,
      });
      expect(derived.provider_selection).toBeUndefined();
      expect(derived.evidence_links).toContain(source.evidence_id);
      expect(session.recordEvidence(derived).ok).toBe(true);
      expect(
        session
          .exportEvidenceBundle()
          .records.find((record) => record.evidence_id === source.evidence_id)
          ?.provider_selection,
      ).toEqual(source.provider_selection);
    } finally {
      await session.dispose();
    }
  },
);

it("preserves native selection when a named query is rebound without reusing the address record", async () => {
  const [path] = await createBinarySessionTargets();
  const { session } = fixture("ghidra");
  try {
    const opened = await session.open(path, { providerId: "ghidra" });
    if (!opened.ok) throw opened.error;
    const parameters = { address: "entry", document: "fixture" };
    const executed = await executeWithNativeSymbolSelection(
      session,
      "xrefs",
      parameters,
      (resolved) => session.execute("xrefs", resolved),
    );
    if (!executed.ok) throw executed.error;
    const materialized = completedOperationEvidence(
      "xrefs",
      parameters,
      executed.value,
      {
        target: opened.value,
        admitRecovery: session.admitRecoveryObservation.bind(session),
        evidenceById: session.evidenceForAnalysis.bind(session),
      },
    );
    if (!materialized.ok) throw materialized.error;
    expect(materialized.value.parameters).toEqual(parameters);
    expect(materialized.value.provider_selection?.selection_source).toBe(
      "request",
    );
    expect(
      materialized.value.limitations.some((text) =>
        text.includes('REA resolved "entry"'),
      ),
    ).toBe(true);
    const addressRecord = session
      .exportEvidenceBundle()
      .records.find(
        (record) =>
          record.operation === "xrefs" &&
          record.parameters.address === "0x1000",
      );
    expect(addressRecord).toBeDefined();
    expect(materialized.value.evidence_id).not.toBe(addressRecord?.evidence_id);
    expect(materialized.value.evidence_id).toBe(executed.value.evidenceId);
  } finally {
    await session.dispose();
  }
});
