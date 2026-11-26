import { expect, it, vi } from "vitest";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import { createEvidenceBundle } from "../../domain/evidenceBundle.js";
import {
  createEvidence,
  type Evidence,
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
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
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
  createTestProviderRouter,
} from "../../../tests/fixtures/binarySession.js";

import { BinarySession } from "./BinarySession.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import {
  estimateJsonStorage,
  requireAuthenticationHeadroom,
} from "../JsonAuthenticationHeadroom.js";
import {
  admitInvestigationAuthentication,
  type RecoveryAdmission,
} from "../investigation/InvestigationRetention.js";

const fixture = (
  id: string,
  shared: readonly string[] = [],
  delivery: "inline" | "reference" = "inline",
  sources: readonly Evidence[] = [],
  records?: InvestigationRecords,
) => {
  const identity = { id, name: `${id} fixture`, version: "1" };
  const profile = createAnalysisProfile(identity, { fixture: true });
  const calls: string[] = [];
  const capability = (
    operation:
      | "address_name"
      | "read_bytes"
      | "list_names"
      | "xrefs"
      | "set_address_name",
  ): CapabilityDescriptor => ({
    provider: identity,
    operation,
    available: true,
    reason: null,
    effects: {
      mutatesArtifact: operation === "set_address_name",
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
      capability("set_address_name"),
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
        return ok(
          createAnalysisExecution(operation, identity, {
            ...(shared.length === 0
              ? {}
              : { limitations: shared, sessionLimitations: shared }),
            ...(sources.length === 0 ? {} : { sourceEvidence: sources }),
          }),
        );
      },
      close: async () => ok(null),
    }),
  };
  return {
    session: new BinarySession(
      createTestProviderRouter(provider),
      records,
      undefined,
      delivery,
    ),
    calls,
    provider,
  };
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

it.each([
  ["ghidra", "inline"],
  ["ghidra", "reference"],
  ["artifact-graph", "inline"],
  ["artifact-graph", "reference"],
] as const)(
  "preserves %s dispatch provenance through %s session limitations",
  async (id, delivery) => {
    const [path] = await createBinarySessionTargets();
    const historicalSources: Evidence[] = [];
    const { session, provider } = fixture(
      id,
      ["Shared provider limitation"],
      delivery,
      historicalSources,
    );
    try {
      const opened = await session.open(path, { providerId: id });
      if (!opened.ok) throw opened.error;
      const history = createEvidence(
        opened.value,
        provider.identity(),
        {
          operation: "health",
          parameters: { facet: "historical-project-analysis-reports" },
          result: { origin: "caller-project" },
        },
        { immutable: true },
      );
      historicalSources.push(history);
      const parameters = { address: "0x1000", document: "fixture" };
      const execution = await session.execute("address_name", parameters);
      if (!execution.ok) throw execution.error;
      const result = completedOperationEvidence(
        "address_name",
        parameters,
        execution.value,
        {
          target: opened.value,
          admitRecovery: session.admitRecoveryObservation.bind(session),
          evidenceById: session.evidenceForAnalysis.bind(session),
        },
      );
      if (!result.ok) throw result.error;
      expect(
        execution.value.sourceEvidence?.find(
          (source) => source.evidence_id === history.evidence_id,
        ),
      ).toBe(history);
      expect(history.provider_selection).toBeUndefined();
      expect(
        session.evidenceForAnalysis(history.evidence_id)?.provider_selection,
      ).toBeUndefined();
      const expected = id === "ghidra" ? "request" : undefined;
      expect(result.value.provider_selection?.selection_source).toBe(expected);
      const contexts = session
        .exportEvidenceBundle()
        .records.filter(
          (record) =>
            record.operation === "health" &&
            record.parameters.facet === "session-limitations",
        );
      expect(contexts).toHaveLength(delivery === "reference" ? 1 : 0);
      if (delivery === "reference") {
        const context = contexts[0]!;
        expect(context.provider_selection?.selection_source).toBe(expected);
        expect(context.normalized_result).toEqual({
          limitations: ["Shared provider limitation"],
        });
        expect(result.value.evidence_links).toContain(context.evidence_id);
      } else
        expect(result.value.limitations).toContain(
          "Shared provider limitation",
        );
    } finally {
      await session.dispose();
    }
  },
);

it.each(["ghidra", "artifact-graph"])(
  "keeps %s completed recovery provenance when source retention is full",
  async (id) => {
    const [path] = await createBinarySessionTargets();
    const records = new InvestigationRecords({ maximumRepresentationBytes: 0 });
    const sources: Evidence[] = [];
    const { session, provider } = fixture(id, [], "inline", sources, records);
    let charged: ReturnType<typeof estimateJsonStorage> | undefined;
    const admit = records.admitRecoveryObservation.bind(records);
    const admission = vi
      .spyOn(records, "admitRecoveryObservation")
      .mockImplementation((input, operation, additional) => {
        const base = estimateJsonStorage(input);
        charged = {
          valueBytes: base.valueBytes + additional.valueBytes,
          serializedUtf16Bytes:
            base.serializedUtf16Bytes + additional.serializedUtf16Bytes,
        };
        return admit(input, operation, additional);
      });
    try {
      const opened = await session.open(path, { providerId: id });
      if (!opened.ok) throw opened.error;
      const source = createEvidence(
        opened.value,
        provider.identity(),
        {
          operation: "health",
          parameters: { facet: "historical" },
          result: "existing source",
        },
        { immutable: true },
      );
      sources.push(source);
      const failed = await session.execute("read_bytes", {
        address: "0x1000",
        length: 1,
      });
      expect(failed.ok).toBe(false);
      if (failed.ok) throw new Error("Expected source capacity refusal");
      const completed = failed.error.sourcePublicationRecovery?.completed;
      expect(completed?.kind).toBe("unretained-evidence");
      if (completed?.kind !== "unretained-evidence")
        throw new Error("Expected completed Evidence");
      expect(completed.evidence.provider_selection?.selection_source).toBe(
        id === "ghidra" ? "request" : undefined,
      );
      expect(completed.evidence.evidence_links).toEqual([source.evidence_id]);
      expect(source.provider_selection).toBeUndefined();
      expect(session.exportEvidenceBundle().records).toHaveLength(0);
      const actual = estimateJsonStorage(completed.evidence);
      expect(charged?.valueBytes).toBeGreaterThanOrEqual(actual.valueBytes);
      expect(charged?.serializedUtf16Bytes).toBeGreaterThanOrEqual(
        actual.serializedUtf16Bytes,
      );
    } finally {
      admission.mockRestore();
      await session.dispose();
    }
  },
);

it("omits recovery before materialization when authentication headroom is exhausted", async () => {
  const [path] = await createBinarySessionTargets();
  const records = new InvestigationRecords({
    maximumRepresentationBytes: 0,
    availableAuthenticationBytes: () => 0,
  });
  const sources: Evidence[] = [];
  const { session, provider } = fixture(
    "ghidra",
    [],
    "inline",
    sources,
    records,
  );
  try {
    const opened = await session.open(path, { providerId: "ghidra" });
    if (!opened.ok) throw opened.error;
    sources.push(
      createEvidence(
        opened.value,
        provider.identity(),
        { operation: "health", parameters: {}, result: "existing source" },
        { immutable: true },
      ),
    );
    const failed = await session.execute("read_bytes", {
      address: "0x1000",
      length: 1,
    });
    if (failed.ok) throw new Error("Expected source capacity refusal");
    expect(failed.error.sourcePublicationRecovery?.completed).toMatchObject({
      kind: "omitted",
      reason: "insufficient-authentication-headroom",
    });
    expect(session.exportEvidenceBundle().records).toHaveLength(0);
  } finally {
    await session.dispose();
  }
});

/** Allow the existing payload, but no unaccounted-for selection copy. */
const admitPayloadOnly: RecoveryAdmission = (input, operation, additional) => {
  const payload = { ...(input as Record<string, unknown>) };
  delete payload.provider_selection;
  const baseline = requireAuthenticationHeadroom(payload, {
    operation,
    path: "fixture",
    description: "fixture budget",
    availableBytes: 0,
    additional,
  });
  if (baseline.ok) throw new Error("Expected the baseline cost report");
  const bytes = baseline.error.reportedLimits?.authentication_bytes;
  if (typeof bytes !== "number")
    throw new Error("Expected reported authentication cost");
  return requireAuthenticationHeadroom(input, {
    operation,
    path: "fixture",
    description: "fixture budget",
    availableBytes: bytes,
    additional,
  });
};

it("admits historical selection bytes before replay copies, while legacy absence fits", async () => {
  const [path] = await createBinarySessionTargets();
  const { session } = fixture("ghidra");
  try {
    const opened = await session.open(path, { providerId: "ghidra" });
    if (!opened.ok) throw opened.error;
    const parameters = { address: "0x1000", document: "fixture" };
    const issued = await session.execute("address_name", parameters);
    if (!issued.ok) throw issued.error;
    const fresh = completedOperationEvidence(
      "address_name",
      parameters,
      issued.value,
      {
        target: opened.value,
        evidenceById: session.evidenceForAnalysis.bind(session),
        admitRecovery: () => {
          throw new Error("Issued Evidence needs no new materialization");
        },
      },
    );
    if (!fresh.ok) throw fresh.error;
    const historical = withEvidenceProviderSelection(fresh.value, {
      ...fresh.value.provider_selection!,
      selection_source: "environment",
      candidates: [
        ...fresh.value.provider_selection!.candidates,
        {
          provider: {
            id: "unselected",
            name: "historical alternative",
            version: null,
          },
          selected: false,
          availability: "unavailable",
          target_support: "unknown",
          rejection_codes: ["recorded reason ".repeat(32)],
        },
      ],
    });
    expect(
      session.importEvidenceBundle(createEvidenceBundle([historical])).ok,
    ).toBe(true);
    const replay = await session.execute("address_name", parameters);
    if (!replay.ok) throw replay.error;
    const refused = completedOperationEvidence(
      "address_name",
      parameters,
      replay.value,
      { target: opened.value, admitRecovery: admitPayloadOnly },
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
    });
    const admitted = completedOperationEvidence(
      "address_name",
      parameters,
      replay.value,
      { target: opened.value },
    );
    if (!admitted.ok) throw admitted.error;
    expect(admitted.value.provider_selection).toEqual(
      historical.provider_selection,
    );
    const legacy = { ...historical };
    delete legacy.provider_selection;
    expect(
      session.importEvidenceBundle(createEvidenceBundle([legacy])).ok,
    ).toBe(true);
    const oldReplay = await session.execute("address_name", parameters);
    if (!oldReplay.ok) throw oldReplay.error;
    const plain = completedOperationEvidence(
      "address_name",
      parameters,
      oldReplay.value,
      { target: opened.value, admitRecovery: admitPayloadOnly },
    );
    if (!plain.ok) throw plain.error;
    expect(plain.value.provider_selection).toBeUndefined();
  } finally {
    await session.dispose();
  }
});

it("includes native selection in the session's first retained-record admission", async () => {
  const [path] = await createBinarySessionTargets();
  const records = new InvestigationRecords();
  const admission = vi
    .spyOn(records, "admitRecoveryObservation")
    .mockImplementation(admitPayloadOnly);
  const { session } = fixture("ghidra", [], "inline", [], records);
  try {
    const opened = await session.open(path, { providerId: "ghidra" });
    if (!opened.ok) throw opened.error;
    const refused = await session.execute("address_name", {
      address: "0x1000",
      document: "fixture",
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisResourceConstraintError", resource: "memory" },
    });
    expect(session.exportEvidenceBundle().records).toHaveLength(0);
  } finally {
    admission.mockRestore();
    await session.dispose();
  }
});

it.each(["recover", "omit", "normal"] as const)(
  "preserves a completed native mutation through context admission: %s",
  async (outcome) => {
    const [path] = await createBinarySessionTargets();
    const records = new InvestigationRecords();
    const originalAdmission = records.admitRecoveryObservation.bind(records);
    let attempts = 0;
    const operations: string[] = [];
    const admission = vi
      .spyOn(records, "admitRecoveryObservation")
      .mockImplementation((input, operation, additional) => {
        operations.push(operation);
        attempts += 1;
        return outcome === "normal" || (outcome === "recover" && attempts > 1)
          ? originalAdmission(input, operation, additional)
          : admitInvestigationAuthentication(
              input,
              operation,
              { availableAuthenticationBytes: () => 0 },
              additional,
            );
      });
    const { session, calls } = fixture(
      "ghidra",
      ["Shared provider limitation"],
      "reference",
      [],
      records,
    );
    try {
      const opened = await session.open(path, { providerId: "ghidra" });
      if (!opened.ok) throw opened.error;
      const parameters = { address: "0x1000", name: "renamed" };
      const result = await session.execute("set_address_name", parameters);
      expect(
        calls.filter((operation) => operation === "set_address_name"),
      ).toHaveLength(1);
      expect(
        operations.every((operation) => operation === "set_address_name"),
      ).toBe(true);
      if (outcome === "normal") {
        expect(result.ok).toBe(true);
        return;
      }
      if (result.ok) throw new Error("Expected context admission failure");
      expect(result.error).toMatchObject({
        _tag: "AnalysisResourceConstraintError",
        operation: "set_address_name",
      });
      const completed = result.error.sourcePublicationRecovery?.completed;
      const projected = projectAnalysisError(result.error);
      expect(projected).toMatchObject({
        code: "resource_constraint",
        details: { operation: "set_address_name" },
      });
      if (outcome === "omit") {
        expect(projected).toMatchObject({
          details: {
            completed_observation_omitted: {
              reason: "insufficient-authentication-headroom",
              source_closure: "not-established",
            },
          },
        });
        expect(completed).toMatchObject({
          kind: "omitted",
          reason: "insufficient-authentication-headroom",
        });
      } else {
        if (completed?.kind !== "unretained-evidence")
          throw new Error("Expected completed mutation Evidence");
        expect(completed.evidence).toMatchObject({
          operation: "set_address_name",
          parameters,
          normalized_result: "set_address_name",
          provider_selection: { selection_source: "request" },
          evidence_links: [],
        });
        expect(completed.evidence.limitations).toContain(
          "Shared provider limitation",
        );
        expect(projected).toMatchObject({
          details: {
            completed_observation: {
              kind: "unretained-evidence",
              evidence: {
                operation: "set_address_name",
                normalized_result: "set_address_name",
                provider_selection: { selection_source: "request" },
              },
            },
          },
        });
      }
      expect(session.exportEvidenceBundle().records).toHaveLength(0);
    } finally {
      admission.mockRestore();
      await session.dispose();
    }
  },
);
