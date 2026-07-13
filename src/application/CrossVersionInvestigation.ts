import { compareArtifacts } from "../domain/artifactComparison.js";
import { findChangedBehavior } from "../domain/changedBehavior.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import {
  createEvidenceBundle,
  type EvidenceFilePolicy,
} from "../domain/evidenceBundle.js";
import {
  AnalysisInputError,
  EvidenceIntegrityError,
  InvestigationWorkspaceError,
  type AnalysisError,
} from "../domain/errors.js";
import {
  createInvestigationRunIdentity,
  createInvestigationWorkspace,
  crossVersionInvestigationInputSchema,
  investigationRunSchema,
  investigationRunSummarySchema,
  reviseInvestigationWorkspace,
  type CrossVersionInvestigationInput,
  type InvestigationRun,
  type InvestigationWorkspace,
} from "../domain/investigationWorkspace.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { BinarySessionPort } from "./BinarySession.js";
import {
  AUTOMATIC_RUN_LIMITATION,
  createInventoryEvidencePages,
  runLimitations,
  scanVersions,
  targetFor,
  type InventoryEvidencePages,
  type VersionSnapshots,
} from "./CrossVersionInventory.js";
import {
  readInvestigationWorkspace,
  writeInvestigationWorkspace,
} from "./InvestigationWorkspaceStore.js";
import {
  ARTIFACT_COMPARISON_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
} from "./InvestigationProviders.js";

export interface CrossVersionInvestigationOutcome {
  readonly evidence: Evidence;
  readonly workspace: InvestigationWorkspace;
  readonly reused: boolean;
}

/** Run or resume a deterministic cross-version artifact investigation. */
export const runCrossVersionInvestigation = async (
  input: CrossVersionInvestigationInput,
  policy: EvidenceFilePolicy,
  session?: BinarySessionPort,
  signal?: AbortSignal,
): Promise<Result<CrossVersionInvestigationOutcome, AnalysisError>> => {
  const parsed = crossVersionInvestigationInputSchema.safeParse(input);
  if (!parsed.success)
    return err(
      new AnalysisInputError("find_changed_behavior", {
        cause: parsed.error,
      }),
    );
  const initial = await readInvestigationWorkspace(
    parsed.data.workspace_path,
    policy,
  );
  if (!initial.ok) return initial;
  const preflight = validateWorkspaceRequest(initial.value, parsed.data);
  if (!preflight.ok) return preflight;

  const snapshots = await scanVersions(parsed.data, signal);
  if (!snapshots.ok) return snapshots;
  return continueInvestigation({
    input: parsed.data,
    initial: initial.value,
    snapshots: snapshots.value,
    policy,
    session,
  });
};

interface RunState {
  readonly workspace: InvestigationWorkspace;
  readonly run: InvestigationRun;
}

const continueInvestigation = async (context: {
  readonly input: CrossVersionInvestigationInput;
  readonly initial: InvestigationWorkspace | null;
  readonly snapshots: VersionSnapshots;
  readonly policy: EvidenceFilePolicy;
  readonly session: BinarySessionPort | undefined;
}): Promise<Result<CrossVersionInvestigationOutcome, AnalysisError>> => {
  const left = targetFor(context.snapshots.left);
  const right = targetFor(context.snapshots.right);
  const identity = createInvestigationRunIdentity({
    left,
    right,
    options: context.input.options,
  });
  const existing = context.initial?.runs.find(
    ({ run_id: id }) => id === identity.runId,
  );
  if (context.initial !== null && existing?.status === "complete")
    return completeOutcome(context.initial, existing, true, context.session);
  const pages = createInventoryEvidencePages(context.input, context.snapshots);
  if (!pages.ok) return pages;
  const inventoried = await ensureInventoryCheckpoint({
    input: context.input,
    current: context.initial,
    existing,
    pages: pages.value,
    snapshots: context.snapshots,
    policy: context.policy,
  });
  if (!inventoried.ok) return inventoried;
  const compared = await ensureComparisonCheckpoint(
    context.input,
    inventoried.value,
    context.policy,
  );
  if (!compared.ok) return compared;
  return finalizeInvestigation(
    context.input,
    compared.value,
    context.policy,
    context.session,
  );
};

const ensureInventoryCheckpoint = async (input: {
  readonly input: CrossVersionInvestigationInput;
  readonly current: InvestigationWorkspace | null;
  readonly existing: InvestigationRun | undefined;
  readonly pages: InventoryEvidencePages;
  readonly snapshots: VersionSnapshots;
  readonly policy: EvidenceFilePolicy;
}): Promise<Result<RunState, AnalysisError>> => {
  if (input.existing !== undefined) {
    const consistent = validateInventoryCheckpoint(input.existing, input.pages);
    if (!consistent.ok) return consistent;
    return input.current === null
      ? err(new EvidenceIntegrityError("Investigation workspace is missing"))
      : ok({ workspace: input.current, run: input.existing });
  }
  const left = targetFor(input.snapshots.left);
  const right = targetFor(input.snapshots.right);
  const identity = createInvestigationRunIdentity({
    left,
    right,
    options: input.input.options,
  });
  const run = investigationRunSchema.parse({
    schema_version: 1,
    run_id: identity.runId,
    request_sha256: identity.requestSha256,
    left,
    right,
    options: input.input.options,
    status: "running",
    completed_stages: ["inventory_left", "inventory_right"],
    left_inventory_evidence_ids: evidenceIds(input.pages.left),
    right_inventory_evidence_ids: evidenceIds(input.pages.right),
    comparison_evidence_id: null,
    result_evidence_id: null,
    limitations: runLimitations(input.snapshots),
  });
  const saved = await checkpoint({
    path: input.input.workspace_path,
    name: input.input.workspace_name,
    current: input.current,
    records: [...input.pages.left, ...input.pages.right],
    run,
    policy: input.policy,
  });
  return saved.ok ? ok({ workspace: saved.value, run }) : saved;
};

const ensureComparisonCheckpoint = async (
  input: CrossVersionInvestigationInput,
  state: RunState,
  policy: EvidenceFilePolicy,
): Promise<Result<RunState, AnalysisError>> => {
  if (state.run.comparison_evidence_id !== null) return ok(state);
  const inventory = inventoryEvidence(state.workspace, state.run);
  if (!inventory.ok) return inventory;
  const evidence = createArtifactComparisonEvidence(
    inventory.value,
    input.options.change_limit,
  );
  const run = investigationRunSchema.parse({
    ...state.run,
    completed_stages: [
      "inventory_left",
      "inventory_right",
      "compare_artifacts",
    ],
    comparison_evidence_id: evidence.evidence_id,
  });
  const saved = await checkpoint({
    path: input.workspace_path,
    name: input.workspace_name,
    current: state.workspace,
    records: [evidence],
    run,
    policy,
  });
  return saved.ok ? ok({ workspace: saved.value, run }) : saved;
};

const createArtifactComparisonEvidence = (
  inventory: {
    readonly left: readonly Evidence[];
    readonly right: readonly Evidence[];
  },
  limit: number,
): Evidence => {
  const comparison = compareArtifacts(
    inventory.left,
    inventory.right,
    0,
    limit,
  );
  const leftIds = evidenceIds(inventory.left);
  const rightIds = evidenceIds(inventory.right);
  return createEvidence(undefined, ARTIFACT_COMPARISON_PROVIDER, {
    predicateType: "rea.artifact-comparison/v1",
    operation: "compare_artifacts",
    parameters: {
      left_evidence_ids: leftIds,
      right_evidence_ids: rightIds,
      offset: 0,
      limit,
    },
    result: jsonValueSchema.parse(comparison),
    confidence: "derived",
    authority: "analyst-inference",
    limitations: comparison.limitations,
    evidenceLinks: [...leftIds, ...rightIds],
  });
};

const finalizeInvestigation = async (
  input: CrossVersionInvestigationInput,
  state: RunState,
  policy: EvidenceFilePolicy,
  session?: BinarySessionPort,
): Promise<Result<CrossVersionInvestigationOutcome, AnalysisError>> => {
  const comparison = comparisonEvidenceFor(state.workspace, state.run);
  if (!comparison.ok) return comparison;
  const evidence = createChangedBehaviorEvidence(state, comparison.value);
  const run = investigationRunSchema.parse({
    ...state.run,
    status: "complete",
    completed_stages: [
      "inventory_left",
      "inventory_right",
      "compare_artifacts",
      "find_changed_behavior",
    ],
    result_evidence_id: evidence.evidence_id,
  });
  const saved = await checkpoint({
    path: input.workspace_path,
    name: input.workspace_name,
    current: state.workspace,
    records: [evidence],
    run,
    policy,
  });
  return saved.ok ? completeOutcome(saved.value, run, false, session) : saved;
};

const createChangedBehaviorEvidence = (
  state: RunState,
  comparison: Evidence,
): Evidence => {
  const limit = Math.min(state.run.options.change_limit, 100);
  const changed = findChangedBehavior([comparison], 0, limit);
  const summary = investigationRunSummarySchema.parse({
    schema_version: 1,
    workspace_id: state.workspace.workspace_id,
    run_id: state.run.run_id,
    left_manifest_id: state.run.left.manifest_id,
    right_manifest_id: state.run.right.manifest_id,
    inventory_evidence_count:
      state.run.left_inventory_evidence_ids.length +
      state.run.right_inventory_evidence_ids.length,
    comparison_evidence_id: comparison.evidence_id,
    limitations: state.run.limitations,
  });
  return createEvidence(undefined, CHANGED_BEHAVIOR_PROVIDER, {
    predicateType: "rea.changed-behavior/v1",
    operation: "find_changed_behavior",
    parameters: {
      workspace_id: state.workspace.workspace_id,
      run_id: state.run.run_id,
      comparison_evidence_ids: [comparison.evidence_id],
      offset: 0,
      limit,
    },
    result: jsonValueSchema.parse({
      ...changed,
      investigation_run: summary,
    }),
    confidence: "derived",
    authority: "analyst-inference",
    limitations: [...changed.limitations, AUTOMATIC_RUN_LIMITATION],
    evidenceLinks: changed.evidence_links,
  });
};

const comparisonEvidenceFor = (
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
): Result<Evidence, EvidenceIntegrityError> => {
  const evidence = workspace.bundle.records.find(
    ({ evidence_id: id }) => id === run.comparison_evidence_id,
  );
  return evidence === undefined
    ? err(
        new EvidenceIntegrityError(
          "Investigation comparison checkpoint is missing Evidence",
        ),
      )
    : ok(evidence);
};

const checkpoint = async (input: {
  readonly path: string;
  readonly name: string;
  readonly current: InvestigationWorkspace | null;
  readonly records: readonly Evidence[];
  readonly run: InvestigationRun;
  readonly policy: EvidenceFilePolicy;
}): Promise<Result<InvestigationWorkspace, AnalysisError>> => {
  const records = mergeEvidence(
    input.current?.bundle.records ?? [],
    input.records,
  );
  const bundle = createEvidenceBundle(
    records,
    input.current?.bundle.unknowns ?? [],
  );
  const runs = replaceRun(input.current?.runs ?? [], input.run);
  const next =
    input.current === null
      ? createInvestigationWorkspace(input.name, bundle, runs)
      : reviseInvestigationWorkspace(input.current, bundle, runs);
  const written = await writeInvestigationWorkspace(
    next,
    input.path,
    input.current?.revision ?? null,
    input.policy,
  );
  return written.ok ? ok(next) : written;
};

const completeOutcome = (
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
  reused: boolean,
  session?: BinarySessionPort,
): Result<CrossVersionInvestigationOutcome, AnalysisError> => {
  if (run.result_evidence_id === null)
    return err(
      new EvidenceIntegrityError("Completed investigation has no result"),
    );
  const evidence = workspace.bundle.records.find(
    ({ evidence_id: id }) => id === run.result_evidence_id,
  );
  if (evidence === undefined)
    return err(
      new EvidenceIntegrityError(
        "Completed investigation result Evidence is missing",
      ),
    );
  if (session !== undefined) {
    const records = recordsForRun(workspace, run);
    const imported = session.importEvidenceBundle(
      createEvidenceBundle(records),
    );
    if (!imported.ok) return imported;
  }
  return ok({ evidence, workspace, reused });
};

const validateWorkspaceRequest = (
  workspace: InvestigationWorkspace | null,
  input: CrossVersionInvestigationInput,
): Result<null, InvestigationWorkspaceError> => {
  if (workspace !== null && workspace.name !== input.workspace_name)
    return err(new InvestigationWorkspaceError("update", "name-conflict"));
  if (
    input.expected_workspace_revision !== undefined &&
    workspace?.revision !== input.expected_workspace_revision
  )
    return err(new InvestigationWorkspaceError("update", "revision-conflict"));
  return ok(null);
};

const validateInventoryCheckpoint = (
  run: InvestigationRun,
  pages: {
    readonly left: readonly Evidence[];
    readonly right: readonly Evidence[];
  },
): Result<null, EvidenceIntegrityError> =>
  JSON.stringify(run.left_inventory_evidence_ids) ===
    JSON.stringify(evidenceIds(pages.left)) &&
  JSON.stringify(run.right_inventory_evidence_ids) ===
    JSON.stringify(evidenceIds(pages.right))
    ? ok(null)
    : err(
        new EvidenceIntegrityError(
          "Investigation inventory checkpoint disagrees with current content",
        ),
      );

const inventoryEvidence = (
  workspace: InvestigationWorkspace | null,
  run: InvestigationRun,
): Result<
  { readonly left: readonly Evidence[]; readonly right: readonly Evidence[] },
  EvidenceIntegrityError
> => {
  if (workspace === null)
    return err(
      new EvidenceIntegrityError("Investigation workspace is missing"),
    );
  const byId = new Map(
    workspace.bundle.records.map((record) => [record.evidence_id, record]),
  );
  const left = run.left_inventory_evidence_ids.flatMap((id) => {
    const evidence = byId.get(id);
    return evidence === undefined ? [] : [evidence];
  });
  const right = run.right_inventory_evidence_ids.flatMap((id) => {
    const evidence = byId.get(id);
    return evidence === undefined ? [] : [evidence];
  });
  return left.length === run.left_inventory_evidence_ids.length &&
    right.length === run.right_inventory_evidence_ids.length
    ? ok({ left, right })
    : err(
        new EvidenceIntegrityError(
          "Investigation inventory checkpoint is incomplete",
        ),
      );
};

const recordsForRun = (
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
): Evidence[] => {
  const ids = new Set([
    ...run.left_inventory_evidence_ids,
    ...run.right_inventory_evidence_ids,
    ...(run.comparison_evidence_id === null
      ? []
      : [run.comparison_evidence_id]),
    ...(run.result_evidence_id === null ? [] : [run.result_evidence_id]),
  ]);
  return workspace.bundle.records.filter(({ evidence_id: id }) => ids.has(id));
};

const mergeEvidence = (
  current: readonly Evidence[],
  additions: readonly Evidence[],
): Evidence[] => {
  const records = new Map(
    current.map((record) => [record.evidence_id, record]),
  );
  for (const record of additions)
    if (!records.has(record.evidence_id))
      records.set(record.evidence_id, record);
  return [...records.values()];
};

const replaceRun = (
  runs: readonly InvestigationRun[],
  replacement: InvestigationRun,
): InvestigationRun[] => [
  ...runs.filter(({ run_id: id }) => id !== replacement.run_id),
  replacement,
];

const evidenceIds = (records: readonly Evidence[]): string[] =>
  records.map(({ evidence_id: id }) => id);
