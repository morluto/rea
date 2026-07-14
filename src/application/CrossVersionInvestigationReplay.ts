import { isDeepStrictEqual } from "node:util";

import {
  artifactInventoryResultSchema,
  type ArtifactInventoryResult,
} from "../domain/artifactGraph.js";
import { parseArtifactInventoryEvidence } from "../domain/artifactInventoryEvidence.js";
import type { Evidence } from "../domain/evidence.js";
import {
  EvidenceIntegrityError,
  InvestigationWorkspaceError,
} from "../domain/errors.js";
import type {
  CrossVersionInvestigationInput,
  InvestigationRun,
  InvestigationRunTarget,
  InvestigationWorkspace,
} from "../domain/investigationWorkspace.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  createArtifactComparisonEvidence,
  createChangedBehaviorEvidence,
} from "./CrossVersionInvestigationEvidence.js";
import { AUTOMATIC_RUN_LIMITATION } from "./CrossVersionInventory.js";
import { ARTIFACT_GRAPH_PROVIDER } from "./InvestigationProviders.js";

/** Validated workspace state returned by an explicit cache-only selector. */
export interface CompletedInvestigationReplay {
  readonly workspace: InvestigationWorkspace;
  readonly run: InvestigationRun;
}

interface ValidatedInventory {
  readonly records: readonly Evidence[];
  readonly result: ReturnType<typeof parseArtifactInventoryEvidence>;
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
  if (
    workspace === null ||
    run === undefined ||
    run.status !== "complete" ||
    !controlsMatch(run, input)
  )
    return replayConflict();
  const records = new Map(
    workspace.bundle.records.map((record) => [record.evidence_id, record]),
  );
  const left = inventoryRecords(records, run.left_inventory_evidence_ids);
  const right = inventoryRecords(records, run.right_inventory_evidence_ids);
  if (!left.ok) return left;
  if (!right.ok) return right;
  if (
    !pathsMatch(left.value, input.left_path) ||
    !pathsMatch(right.value, input.right_path)
  )
    return replayConflict();
  const validated = validateLinkedEvidence(
    workspace,
    run,
    left.value,
    right.value,
  );
  return validated.ok ? ok({ workspace, run }) : validated;
};

const controlsMatch = (
  run: InvestigationRun,
  input: CrossVersionInvestigationInput,
): boolean =>
  isDeepStrictEqual(run.options, input.options) &&
  run.integrity_policy === input.integrity_policy &&
  run.integrity_continue_approved === input.integrity_continue_approved &&
  run.max_integrity_mismatches === input.max_integrity_mismatches;

const inventoryRecords = (
  records: ReadonlyMap<string, Evidence>,
  evidenceIds: readonly string[],
): Result<readonly Evidence[], EvidenceIntegrityError> => {
  if (new Set(evidenceIds).size !== evidenceIds.length)
    return replayIntegrity("Investigation replay repeats inventory Evidence");
  const selected = evidenceIds.flatMap((evidenceId) => {
    const evidence = records.get(evidenceId);
    return evidence === undefined ? [] : [evidence];
  });
  return selected.length === evidenceIds.length
    ? ok(selected)
    : replayIntegrity("Investigation replay is missing inventory Evidence");
};

const pathsMatch = (records: readonly Evidence[], path: string): boolean =>
  records.every(({ subject }) => subject?.local_path === path);

const validateLinkedEvidence = (
  workspace: InvestigationWorkspace,
  run: InvestigationRun,
  leftRecords: readonly Evidence[],
  rightRecords: readonly Evidence[],
): Result<null, EvidenceIntegrityError> => {
  try {
    const left = validateInventory(leftRecords, run.left, run);
    const right = validateInventory(rightRecords, run.right, run);
    if (!left.ok) return left;
    if (!right.ok) return right;
    const expectedLimitations = runLimitations(left.value, right.value);
    if (!isDeepStrictEqual(run.limitations, expectedLimitations))
      return replayIntegrity(
        "Investigation replay limitations disagree with inventory Evidence",
      );
    const comparison = createArtifactComparisonEvidence(
      { left: left.value.records, right: right.value.records },
      run.options.change_limit,
    );
    const storedComparison = evidenceFor(workspace, run.comparison_evidence_id);
    if (
      storedComparison === undefined ||
      !isDeepStrictEqual(storedComparison, comparison)
    )
      return replayIntegrity(
        "Investigation replay comparison Evidence is inconsistent",
      );
    const result = createChangedBehaviorEvidence(workspace, run, comparison);
    const storedResult = evidenceFor(workspace, run.result_evidence_id);
    return storedResult !== undefined && isDeepStrictEqual(storedResult, result)
      ? ok(null)
      : replayIntegrity("Investigation replay result Evidence is inconsistent");
  } catch (cause: unknown) {
    return replayIntegrity(
      "Investigation replay linked Evidence is invalid",
      cause,
    );
  }
};

const validateInventory = (
  records: readonly Evidence[],
  target: InvestigationRunTarget,
  run: InvestigationRun,
): Result<ValidatedInventory, EvidenceIntegrityError> => {
  const pages = records.map((record) =>
    artifactInventoryResultSchema.parse(record.normalized_result),
  );
  const expectedPageCount = Math.max(
    1,
    Math.ceil((pages[0]?.manifest.node_count ?? 0) / run.options.page_size),
    Math.ceil(
      (pages[0]?.manifest.occurrence_count ?? 0) / run.options.page_size,
    ),
    Math.ceil((pages[0]?.manifest.edge_count ?? 0) / run.options.page_size),
  );
  if (records.length !== expectedPageCount)
    return replayIntegrity(
      "Investigation replay inventory Evidence pagination is inconsistent",
    );
  if (!sameSnapshotMetadata(pages))
    return replayIntegrity(
      "Investigation replay inventory pages disagree on snapshot metadata",
    );
  for (const [index, record] of records.entries()) {
    const page = pages[index];
    if (page === undefined || !inventoryRecordMatches(record, page, run, index))
      return replayIntegrity(
        "Investigation replay inventory Evidence is inconsistent",
      );
  }
  const result = parseArtifactInventoryEvidence(records);
  if (!result.inventory.complete || !targetMatches(result.inventory, target))
    return replayIntegrity(
      "Investigation replay inventory commitment is inconsistent",
    );
  return ok({ records, result });
};

const inventoryRecordMatches = (
  record: Evidence,
  page: ArtifactInventoryResult,
  run: InvestigationRun,
  index: number,
): boolean => {
  const offset = index * run.options.page_size;
  const parameters = {
    node_offset: offset,
    node_limit: run.options.page_size,
    occurrence_offset: offset,
    occurrence_limit: run.options.page_size,
    edge_offset: offset,
    edge_limit: run.options.page_size,
    max_entries: run.options.max_entries,
    max_total_bytes: run.options.max_total_bytes,
    max_entry_bytes: run.options.max_entry_bytes,
    max_compression_ratio: run.options.max_compression_ratio,
    max_depth: run.options.max_depth,
    max_path_bytes: run.options.max_path_bytes,
    integrity_policy: run.integrity_policy,
    integrity_continue_approved: run.integrity_continue_approved,
    max_integrity_mismatches: run.max_integrity_mismatches,
  };
  const locations = page.occurrences.items.map(({ logical_path: path }) => ({
    kind: "artifact-path" as const,
    path,
  }));
  return (
    record.subject !== null &&
    record.subject.name === record.subject.local_path.split("/").at(-1) &&
    record.subject.digest.sha256 === page.manifest.root_sha256 &&
    record.subject.format === page.manifest.root_format &&
    record.subject.architecture === null &&
    isDeepStrictEqual(record.provider, ARTIFACT_GRAPH_PROVIDER) &&
    record.predicate_type === "rea.analysis/v2" &&
    record.operation === "inventory_artifact" &&
    isDeepStrictEqual(record.parameters, parameters) &&
    record.raw_result === null &&
    record.confidence === "observed" &&
    record.authority === "shipped-artifact" &&
    record.environment === null &&
    isDeepStrictEqual(record.limitations, page.limitations) &&
    isDeepStrictEqual(record.locations, locations) &&
    record.evidence_links.length === 0 &&
    isDeepStrictEqual(page.limits, traversalLimits(run)) &&
    pageMatches(
      page.nodes,
      offset,
      run.options.page_size,
      page.manifest.node_count,
    ) &&
    pageMatches(
      page.occurrences,
      offset,
      run.options.page_size,
      page.manifest.occurrence_count,
    ) &&
    pageMatches(
      page.edges,
      offset,
      run.options.page_size,
      page.manifest.edge_count,
    )
  );
};

const sameSnapshotMetadata = (
  pages: readonly ArtifactInventoryResult[],
): boolean => {
  const first = pages[0];
  return (
    first !== undefined &&
    pages.every(
      (page) =>
        isDeepStrictEqual(page.manifest, first.manifest) &&
        isDeepStrictEqual(page.limits, first.limits) &&
        isDeepStrictEqual(page.provenance, first.provenance) &&
        isDeepStrictEqual(
          page.integrity_contradictions,
          first.integrity_contradictions,
        ) &&
        isDeepStrictEqual(page.limitations, first.limitations),
    )
  );
};

const pageMatches = (
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
): boolean =>
  page.offset === offset &&
  page.limit === limit &&
  page.total === total &&
  page.items.length === Math.max(0, Math.min(limit, page.total - offset)) &&
  page.next_offset === (offset + limit < page.total ? offset + limit : null);

const traversalLimits = (run: InvestigationRun) => ({
  max_entries: run.options.max_entries,
  max_total_bytes: run.options.max_total_bytes,
  max_entry_bytes: run.options.max_entry_bytes,
  max_compression_ratio: run.options.max_compression_ratio,
  max_depth: run.options.max_depth,
  max_path_bytes: run.options.max_path_bytes,
});

const targetMatches = (
  inventory: ReturnType<typeof parseArtifactInventoryEvidence>["inventory"],
  target: InvestigationRunTarget,
): boolean =>
  inventory.manifest.root_sha256 === target.root_sha256 &&
  inventory.manifest.graph_sha256 === target.graph_sha256 &&
  inventory.manifest.manifest_id === target.manifest_id &&
  inventory.manifest.root_format === target.format;

const runLimitations = (
  left: ValidatedInventory,
  right: ValidatedInventory,
): string[] =>
  [
    ...new Set([
      ...left.result.inventory.limitations.map((item) => `Left: ${item}`),
      ...right.result.inventory.limitations.map((item) => `Right: ${item}`),
      AUTOMATIC_RUN_LIMITATION,
    ]),
  ].sort((first, second) => first.localeCompare(second));

const evidenceFor = (
  workspace: InvestigationWorkspace,
  evidenceId: string | null,
): Evidence | undefined =>
  evidenceId === null
    ? undefined
    : workspace.bundle.records.find(
        ({ evidence_id: current }) => current === evidenceId,
      );

const replayConflict = (): Result<never, InvestigationWorkspaceError> =>
  err(new InvestigationWorkspaceError("read", "revision-conflict"));

const replayIntegrity = (
  message: string,
  cause?: unknown,
): Result<never, EvidenceIntegrityError> =>
  err(
    new EvidenceIntegrityError(
      message,
      cause === undefined ? undefined : { cause },
    ),
  );
