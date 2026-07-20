import { type Evidence } from "../domain/evidence.js";
import {
  createEvidenceBundle,
  type EvidenceFilePolicy,
} from "../domain/evidenceBundle.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  EvidenceIntegrityError,
  InvestigationWorkspaceError,
  type AnalysisError,
} from "../domain/errors.js";
import {
  createLegacyInvestigationRunIdentity,
  createInvestigationRunIdentity,
  createInvestigationWorkspace,
  crossVersionInvestigationInputSchema,
  investigationRunSchema,
  reviseInvestigationWorkspace,
  type CrossVersionInvestigationInput,
  type InvestigationRun,
  type InvestigationWorkspace,
} from "../domain/investigationWorkspace.js";
import { err, ok, type Result } from "../domain/result.js";
import type { BinarySessionPort } from "./BinarySession.js";
import type { ProgressReporter } from "./ProgressReporter.js";
import {
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
  createArtifactComparisonEvidence,
  createChangedBehaviorEvidence,
} from "./CrossVersionInvestigationEvidence.js";
import { selectCompletedInvestigationReplay } from "./CrossVersionInvestigationReplay.js";

export interface CrossVersionInvestigationOutcome {
  readonly evidence: Evidence;
  readonly workspace: InvestigationWorkspace;
  readonly reused: boolean;
}

/** Runtime authority and cancellation capabilities for one investigation. */
export interface CrossVersionInvestigationExecution {
  readonly inputRoots: readonly string[];
  readonly session?: BinarySessionPort;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
  readonly integrityContinueEnabled?: boolean;
  readonly authorizeInputRead?: () => Promise<Result<null, AnalysisError>>;
  readonly authorizeWorkspaceWrite?: () => Promise<Result<null, AnalysisError>>;
}

/** Run or resume a deterministic cross-version artifact investigation. */
export const runCrossVersionInvestigation = async (
  input: CrossVersionInvestigationInput,
  policy: EvidenceFilePolicy,
  execution: CrossVersionInvestigationExecution,
): Promise<Result<CrossVersionInvestigationOutcome, AnalysisError>> => {
  const parsed = crossVersionInvestigationInputSchema.safeParse(input);
  if (!parsed.success)
    return err(
      new AnalysisInputError("find_changed_behavior", {
        cause: parsed.error,
      }),
    );
  return runCrossVersionInvestigationValidated(parsed.data, policy, execution);
};

/** Run input already parsed by a trusted adapter boundary. */
export const runCrossVersionInvestigationValidated = async (
  input: CrossVersionInvestigationInput,
  policy: EvidenceFilePolicy,
  execution: CrossVersionInvestigationExecution,
): Promise<Result<CrossVersionInvestigationOutcome, AnalysisError>> => {
  const initial = await readInvestigationWorkspace(
    input.workspace_path,
    policy,
  );
  if (!initial.ok) return initial;
  const preflight = validateWorkspaceRequest(initial.value, input);
  if (!preflight.ok) return preflight;
  if (isCancelled(execution.signal))
    return err(new AnalysisCancelledError("find_changed_behavior"));
  if (input.replay_run_id !== undefined) {
    const replay = selectCompletedInvestigationReplay(initial.value, input);
    if (!replay.ok) return replay;
    return completeOutcome(
      replay.value.workspace,
      replay.value.run,
      true,
      execution.session,
    );
  }
  if (execution.authorizeInputRead !== undefined) {
    const authorized = await execution.authorizeInputRead();
    if (!authorized.ok) return authorized;
  }
  await execution.progress?.report({
    phase: "scan_versions",
    completed: 0,
    total: 4,
    message: "Scanning both version inputs",
  });

  const snapshots = await scanVersions(
    input,
    execution.inputRoots,
    execution.signal,
    execution.integrityContinueEnabled,
  );
  if (!snapshots.ok) return snapshots;
  await execution.progress?.report({
    phase: "scan_versions",
    completed: 1,
    total: 4,
    message: "Version inputs scanned",
  });
  return continueInvestigation({
    input,
    initial: initial.value,
    snapshots: snapshots.value,
    policy,
    session: execution.session,
    signal: execution.signal,
    progress: execution.progress,
    authorizeWorkspaceWrite: execution.authorizeWorkspaceWrite,
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
  readonly signal: AbortSignal | undefined;
  readonly progress: ProgressReporter | undefined;
  readonly authorizeWorkspaceWrite:
    | (() => Promise<Result<null, AnalysisError>>)
    | undefined;
}): Promise<Result<CrossVersionInvestigationOutcome, AnalysisError>> => {
  const left = targetFor(context.snapshots.left);
  const right = targetFor(context.snapshots.right);
  const identity = createInvestigationRunIdentity({
    left,
    right,
    options: context.input.options,
    integrity_policy: context.input.integrity_policy,
    integrity_continue_approved: context.input.integrity_continue_approved,
    max_integrity_mismatches: context.input.max_integrity_mismatches,
  });
  const legacyIdentity = createLegacyInvestigationRunIdentity({
    left,
    right,
    options: context.input.options,
  });
  const existing = context.initial?.runs.find(
    (run) =>
      run.run_id === identity.runId ||
      (context.input.integrity_policy === "fail" &&
        !context.input.integrity_continue_approved &&
        context.input.max_integrity_mismatches === 10 &&
        "legacy_request_identity" in run &&
        run.max_integrity_mismatches === 10 &&
        run.run_id === legacyIdentity.runId),
  );
  if (context.initial !== null && existing?.status === "complete")
    return completeOutcome(context.initial, existing, true, context.session);
  if (context.authorizeWorkspaceWrite !== undefined) {
    const authorized = await context.authorizeWorkspaceWrite();
    if (!authorized.ok) return authorized;
  }
  const pages = createInventoryEvidencePages(context.input, context.snapshots);
  if (!pages.ok) return pages;
  if (isCancelled(context.signal))
    return err(new AnalysisCancelledError("find_changed_behavior"));
  const inventoried = await ensureInventoryCheckpoint({
    input: context.input,
    current: context.initial,
    existing,
    pages: pages.value,
    snapshots: context.snapshots,
    policy: context.policy,
  });
  if (!inventoried.ok) return inventoried;
  await context.progress?.report({
    phase: "inventory_versions",
    completed: 2,
    total: 4,
    message: "Both artifact inventories checkpointed",
  });
  if (isCancelled(context.signal))
    return err(new AnalysisCancelledError("find_changed_behavior"));
  const compared = await ensureComparisonCheckpoint(
    context.input,
    inventoried.value,
    context.policy,
  );
  if (!compared.ok) return compared;
  await context.progress?.report({
    phase: "compare_artifacts",
    completed: 3,
    total: 4,
    message: "Artifact comparison checkpointed",
  });
  if (isCancelled(context.signal))
    return err(new AnalysisCancelledError("find_changed_behavior"));
  const finalized = await finalizeInvestigation(
    context.input,
    compared.value,
    context.policy,
    context.session,
  );
  await context.progress?.report({
    phase: "changed_behavior",
    completed: 4,
    total: 4,
    message: finalized.ok ? "Investigation completed" : "Investigation failed",
    terminal: true,
  });
  return finalized;
};

const isCancelled = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

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
    integrity_policy: input.input.integrity_policy,
    integrity_continue_approved: input.input.integrity_continue_approved,
    max_integrity_mismatches: input.input.max_integrity_mismatches,
  });
  const run = investigationRunSchema.parse({
    schema_version: 1,
    run_id: identity.runId,
    request_sha256: identity.requestSha256,
    left,
    right,
    options: input.input.options,
    integrity_policy: input.input.integrity_policy,
    integrity_continue_approved: input.input.integrity_continue_approved,
    max_integrity_mismatches: input.input.max_integrity_mismatches,
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
  return checkpointRunEvidence({
    input,
    workspace: state.workspace,
    evidence,
    run,
    policy,
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
  const evidence = createChangedBehaviorEvidence(
    state.workspace,
    state.run,
    comparison.value,
  );
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
  const saved = await checkpointRunEvidence({
    input,
    workspace: state.workspace,
    evidence,
    run,
    policy,
  });
  return saved.ok
    ? completeOutcome(saved.value.workspace, saved.value.run, false, session)
    : saved;
};

interface RunEvidenceCheckpoint {
  readonly input: CrossVersionInvestigationInput;
  readonly workspace: InvestigationWorkspace;
  readonly evidence: Evidence;
  readonly run: InvestigationRun;
  readonly policy: EvidenceFilePolicy;
}

const checkpointRunEvidence = async ({
  input,
  workspace,
  evidence,
  run,
  policy,
}: RunEvidenceCheckpoint): Promise<Result<RunState, AnalysisError>> => {
  const saved = await checkpoint({
    path: input.workspace_path,
    name: input.workspace_name,
    current: workspace,
    records: [evidence],
    run,
    policy,
  });
  return saved.ok ? ok({ workspace: saved.value, run }) : saved;
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
