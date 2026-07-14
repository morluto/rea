import {
  changedBehaviorResultSchema,
  type ChangedBehaviorResult,
} from "../domain/changedBehavior.js";
import { artifactInventoryResultSchema } from "../domain/artifactGraph.js";
import { parseArtifactInventoryEvidence } from "../domain/artifactInventoryEvidence.js";
import type { Evidence } from "../domain/evidence.js";
import {
  EvidenceIntegrityError,
  InvestigationWorkspaceError,
} from "../domain/errors.js";
import type {
  CrossVersionInvestigationInput,
  InvestigationRun,
  InvestigationWorkspace,
} from "../domain/investigationWorkspace.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ARTIFACT_COMPARISON_PROVIDER,
  ARTIFACT_GRAPH_PROVIDER,
  CHANGED_BEHAVIOR_PROVIDER,
} from "./InvestigationProviders.js";

/** Validated workspace state returned by an explicit replay selector. */
export interface CompletedInvestigationReplay {
  readonly workspace: InvestigationWorkspace;
  readonly run: InvestigationRun;
}

/** Select and verify one caller-identified complete run without input access. */
export const selectCompletedInvestigationReplay = (
  workspace: InvestigationWorkspace | null,
  input: CrossVersionInvestigationInput,
): Result<
  CompletedInvestigationReplay,
  InvestigationWorkspaceError | EvidenceIntegrityError
> => {
  const run = workspace?.runs.find(
    ({ run_id: runId }) => runId === input.replay_run_id,
  );
  if (workspace === null || run === undefined || run.status !== "complete")
    return err(new InvestigationWorkspaceError("read", "revision-conflict"));
  if (!replayRequestMatches(workspace, run, input))
    return err(new InvestigationWorkspaceError("read", "revision-conflict"));
  const evidence = validateCompletedReplayEvidence(workspace, run);
  return evidence.ok ? ok({ workspace, run }) : evidence;
};

const replayRequestMatches = (
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
  input: CrossVersionInvestigationInput,
): boolean =>
  JSON.stringify(run.options) === JSON.stringify(input.options) &&
  run.integrity_policy === input.integrity_policy &&
  run.integrity_continue_approved === input.integrity_continue_approved &&
  run.max_integrity_mismatches === input.max_integrity_mismatches &&
  inventoryEvidenceMatches(workspace, run.left_inventory_evidence_ids, {
    path: input.left_path,
    target: run.left,
    input,
  }) &&
  inventoryEvidenceMatches(workspace, run.right_inventory_evidence_ids, {
    path: input.right_path,
    target: run.right,
    input,
  });

interface InventoryReplayExpectation {
  readonly path: string;
  readonly target: InvestigationRun["left"];
  readonly input: CrossVersionInvestigationInput;
}

const inventoryEvidenceMatches = (
  workspace: InvestigationWorkspace,
  evidenceIds: readonly string[],
  expectation: InventoryReplayExpectation,
): boolean => {
  const byId = new Map(
    workspace.bundle.records.map((record) => [record.evidence_id, record]),
  );
  const evidence = evidenceIds.flatMap((evidenceId) => {
    const record = byId.get(evidenceId);
    return record === undefined ? [] : [record];
  });
  if (
    evidence.length !== evidenceIds.length ||
    !evidence.every((record, index) =>
      inventoryPageMatches(record, index, expectation),
    )
  )
    return false;
  try {
    const inventory = parseArtifactInventoryEvidence(evidence).inventory;
    return (
      inventory.complete &&
      evidence.length ===
        expectedInventoryPageCount(
          inventory.manifest.node_count,
          inventory.manifest.occurrence_count,
          inventory.manifest.edge_count,
          expectation.input.options.page_size,
        ) &&
      inventory.manifest.root_sha256 === expectation.target.root_sha256 &&
      inventory.manifest.graph_sha256 === expectation.target.graph_sha256 &&
      inventory.manifest.manifest_id === expectation.target.manifest_id &&
      inventory.manifest.root_format === expectation.target.format
    );
  } catch {
    return false;
  }
};

const inventoryPageMatches = (
  evidence: Evidence,
  index: number,
  expectation: InventoryReplayExpectation,
): boolean => {
  const page = artifactInventoryResultSchema.safeParse(
    evidence.normalized_result,
  );
  if (!page.success) return false;
  const offset = index * expectation.input.options.page_size;
  return (
    inventoryEvidenceMetadataMatches(evidence, expectation) &&
    inventoryParametersMatch(evidence.parameters, offset, expectation.input) &&
    inventoryResultPageMatches(page.data, offset, expectation.input)
  );
};

const inventoryEvidenceMetadataMatches = (
  evidence: Evidence,
  expectation: InventoryReplayExpectation,
): boolean =>
  evidence.operation === "inventory_artifact" &&
  evidence.predicate_type === "rea.analysis/v2" &&
  providerMatches(evidence.provider, ARTIFACT_GRAPH_PROVIDER) &&
  evidence.subject?.local_path === expectation.path &&
  evidence.subject.digest.sha256 === expectation.target.root_sha256 &&
  evidence.subject.format === expectation.target.format &&
  evidence.confidence === "observed" &&
  evidence.authority === "shipped-artifact" &&
  evidence.raw_result === null &&
  evidence.environment === null &&
  evidence.evidence_links.length === 0;

const inventoryResultPageMatches = (
  page: ReturnType<typeof artifactInventoryResultSchema.parse>,
  offset: number,
  input: CrossVersionInvestigationInput,
): boolean =>
  collectionPageMatches(
    page.nodes,
    offset,
    input.options.page_size,
    page.manifest.node_count,
  ) &&
  collectionPageMatches(
    page.occurrences,
    offset,
    input.options.page_size,
    page.manifest.occurrence_count,
  ) &&
  collectionPageMatches(
    page.edges,
    offset,
    input.options.page_size,
    page.manifest.edge_count,
  ) &&
  valuesMatch(page.limits, traversalLimits(input));

const collectionPageMatches = (
  page: {
    readonly items: readonly unknown[];
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
    readonly next_offset: number | null;
  },
  offset: number,
  limit: number,
  total: number,
): boolean => {
  const expectedItems = Math.max(0, Math.min(limit, total - offset));
  const nextOffset = offset + limit < total ? offset + limit : null;
  return (
    page.offset === offset &&
    page.limit === limit &&
    page.total === total &&
    page.items.length === expectedItems &&
    page.next_offset === nextOffset
  );
};

const expectedInventoryPageCount = (
  nodeCount: number,
  occurrenceCount: number,
  edgeCount: number,
  pageSize: number,
): number =>
  Math.max(
    1,
    Math.ceil(nodeCount / pageSize),
    Math.ceil(occurrenceCount / pageSize),
    Math.ceil(edgeCount / pageSize),
  );

const inventoryParametersMatch = (
  parameters: Readonly<Record<string, unknown>>,
  offset: number,
  input: CrossVersionInvestigationInput,
): boolean =>
  Object.keys(parameters).length === 15 &&
  parameters.node_offset === offset &&
  parameters.node_limit === input.options.page_size &&
  parameters.occurrence_offset === offset &&
  parameters.occurrence_limit === input.options.page_size &&
  parameters.edge_offset === offset &&
  parameters.edge_limit === input.options.page_size &&
  parameters.max_entries === input.options.max_entries &&
  parameters.max_total_bytes === input.options.max_total_bytes &&
  parameters.max_entry_bytes === input.options.max_entry_bytes &&
  parameters.max_compression_ratio === input.options.max_compression_ratio &&
  parameters.max_depth === input.options.max_depth &&
  parameters.max_path_bytes === input.options.max_path_bytes &&
  parameters.integrity_policy === input.integrity_policy &&
  parameters.integrity_continue_approved ===
    input.integrity_continue_approved &&
  parameters.max_integrity_mismatches === input.max_integrity_mismatches;

const traversalLimits = (input: CrossVersionInvestigationInput) => ({
  max_entries: input.options.max_entries,
  max_total_bytes: input.options.max_total_bytes,
  max_entry_bytes: input.options.max_entry_bytes,
  max_compression_ratio: input.options.max_compression_ratio,
  max_depth: input.options.max_depth,
  max_path_bytes: input.options.max_path_bytes,
});

const validateCompletedReplayEvidence = (
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
): Result<null, EvidenceIntegrityError> => {
  const inventoryIds = [
    ...run.left_inventory_evidence_ids,
    ...run.right_inventory_evidence_ids,
  ];
  const comparison = workspace.bundle.records.find(
    ({ evidence_id: evidenceId }) => evidenceId === run.comparison_evidence_id,
  );
  if (!comparisonEvidenceMatches(comparison, inventoryIds, run))
    return inconsistentReplayEvidence();
  const resultLinks = [
    ...new Set([comparison.evidence_id, ...inventoryIds]),
  ].sort((left, right) => left.localeCompare(right, "en"));
  const result = workspace.bundle.records.find(
    ({ evidence_id: evidenceId }) => evidenceId === run.result_evidence_id,
  );
  if (!resultEvidenceMatches(result, resultLinks, workspace, run))
    return inconsistentReplayEvidence();
  const parsedResult = changedBehaviorResultSchema.safeParse(
    result.normalized_result,
  );
  if (
    !parsedResult.success ||
    !resultPayloadMatches(parsedResult.data, resultLinks, workspace, run)
  )
    return inconsistentReplayEvidence();
  return ok(null);
};

const comparisonEvidenceMatches = (
  comparison: Evidence | undefined,
  inventoryIds: readonly string[],
  run: InvestigationRun,
): comparison is Evidence =>
  comparison?.operation === "compare_artifacts" &&
  comparison.predicate_type === "rea.artifact-comparison/v1" &&
  providerMatches(comparison.provider, ARTIFACT_COMPARISON_PROVIDER) &&
  comparison.subject === null &&
  comparison.confidence === "derived" &&
  comparison.authority === "analyst-inference" &&
  valuesMatch(comparison.evidence_links, inventoryIds) &&
  comparisonParametersMatch(comparison.parameters, run);

const resultEvidenceMatches = (
  result: Evidence | undefined,
  resultLinks: readonly string[],
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
): result is Evidence =>
  result?.operation === "find_changed_behavior" &&
  result.predicate_type === "rea.changed-behavior/v1" &&
  providerMatches(result.provider, CHANGED_BEHAVIOR_PROVIDER) &&
  result.subject === null &&
  result.confidence === "derived" &&
  result.authority === "analyst-inference" &&
  valuesMatch(result.evidence_links, resultLinks) &&
  resultParametersMatch(result.parameters, workspace, run);

const resultPayloadMatches = (
  result: ChangedBehaviorResult,
  resultLinks: readonly string[],
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
): boolean => {
  const summary = result.investigation_run;
  return (
    summary?.workspace_id === workspace.workspace_id &&
    summary.run_id === run.run_id &&
    summary.left_manifest_id === run.left.manifest_id &&
    summary.right_manifest_id === run.right.manifest_id &&
    summary.inventory_evidence_count ===
      run.left_inventory_evidence_ids.length +
        run.right_inventory_evidence_ids.length &&
    summary.comparison_evidence_id === run.comparison_evidence_id &&
    valuesMatch(summary.limitations, run.limitations) &&
    valuesMatch(result.evidence_links, resultLinks)
  );
};

const inconsistentReplayEvidence = (): Result<never, EvidenceIntegrityError> =>
  err(
    new EvidenceIntegrityError(
      "Completed investigation replay Evidence is inconsistent",
    ),
  );

const comparisonParametersMatch = (
  parameters: Readonly<Record<string, unknown>>,
  run: InvestigationRun,
): boolean =>
  Object.keys(parameters).length === 4 &&
  JSON.stringify(parameters.left_evidence_ids) ===
    JSON.stringify(run.left_inventory_evidence_ids) &&
  JSON.stringify(parameters.right_evidence_ids) ===
    JSON.stringify(run.right_inventory_evidence_ids) &&
  parameters.offset === 0 &&
  parameters.limit === run.options.change_limit;

const resultParametersMatch = (
  parameters: Readonly<Record<string, unknown>>,
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
): boolean =>
  Object.keys(parameters).length === 5 &&
  parameters.workspace_id === workspace.workspace_id &&
  parameters.run_id === run.run_id &&
  JSON.stringify(parameters.comparison_evidence_ids) ===
    JSON.stringify([run.comparison_evidence_id]) &&
  parameters.offset === 0 &&
  parameters.limit === Math.min(run.options.change_limit, 100);

const providerMatches = (
  actual: {
    readonly id: string;
    readonly name: string;
    readonly version: string | null;
  },
  expected: {
    readonly id: string;
    readonly name: string;
    readonly version: string | null;
  },
): boolean =>
  actual.id === expected.id &&
  actual.name === expected.name &&
  actual.version === expected.version;

const valuesMatch = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);
