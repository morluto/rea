import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import { evidenceBundleForTarget } from "../domain/evidenceBundle.js";
import {
  EvidenceIntegrityError,
  type AnalysisError,
  type EvidenceLimitError,
  type UnknownRegistryError,
} from "../domain/errors.js";
import {
  parseInvestigationWorkspace,
  type InvestigationWorkspace,
} from "../domain/investigationWorkspace.js";
import {
  parseReconstructionCoverageWorkspace,
  type ReconstructionCoverageWorkspace,
} from "../domain/reconstructionCoverage.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../domain/residualUnknown.js";
import { err, type Result } from "../domain/result.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
} from "./AnalysisProvider.js";
import { AnalysisSnapshotCache } from "./AnalysisSnapshotCache.js";
import { EvidenceLedger } from "./EvidenceLedger.js";
import {
  UNKNOWN_REGISTRY_PROVIDER,
  unknownEvidenceLinks,
  unknownMutationEvidence,
} from "./UnknownEvidence.js";

export interface ActiveAnalysisBinding {
  readonly target: BinaryTarget;
  readonly profile: AnalysisProfileCommitment | null;
}

/** Owns session evidence, snapshots, workspaces, and residual unknowns. */
export abstract class BinarySessionRecords {
  readonly #evidence = new EvidenceLedger({
    maxRecords: 10_000,
    maxBytes: 64 * 1024 * 1024,
  });
  readonly #snapshot = new AnalysisSnapshotCache();
  readonly #investigationWorkspaces = new Map<string, InvestigationWorkspace>();
  readonly #coverageWorkspaces = new Map<
    string,
    ReconstructionCoverageWorkspace
  >();
  #snapshotInvalidated = false;

  recordEvidence(
    evidence: Evidence,
  ): Result<
    "added" | "duplicate",
    EvidenceIntegrityError | EvidenceLimitError
  > {
    return this.#evidence.record(evidence);
  }

  hasEvidence(evidenceId: string): boolean {
    return this.#evidence.has(evidenceId);
  }

  evidenceById(evidenceId: string): Evidence | undefined {
    return this.#evidence.get(evidenceId);
  }

  exportEvidenceBundle(): EvidenceBundle {
    return this.#evidence.export();
  }

  importEvidenceBundle(
    bundle: unknown,
  ): Result<number, EvidenceIntegrityError | EvidenceLimitError> {
    return this.#evidence.import(bundle);
  }

  protected abstract activeAnalysisBinding(): ActiveAnalysisBinding | undefined;

  exportAnalysisSnapshot(): Result<AnalysisSnapshot, AnalysisError> {
    const active = this.activeAnalysisBinding();
    if (this.#snapshotInvalidated)
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshots are unavailable after analysis metadata mutations",
        ),
      );
    const target = active?.target;
    const profile = active?.profile ?? undefined;
    if (target !== undefined && profile === undefined)
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshots require a concrete provider analysis profile",
        ),
      );
    return this.#snapshot.export(
      target,
      profile,
      target === undefined
        ? this.#evidence.export()
        : evidenceBundleForTarget(this.#evidence.export(), target.sha256),
    );
  }

  importAnalysisSnapshot(
    snapshot: AnalysisSnapshot,
  ): Result<number, AnalysisError> {
    const active = this.activeAnalysisBinding();
    if (active?.profile === null)
      return err(
        new EvidenceIntegrityError(
          "Analysis snapshot profile_mismatch: the active target has no concrete analysis profile",
        ),
      );
    return this.#snapshot.import(
      snapshot,
      active === undefined
        ? undefined
        : { target: active.target, profile: active.profile },
      (bundle) => this.#evidence.import(bundle),
    );
  }

  protected matchesSnapshot(
    target: BinaryTarget,
    profile: AnalysisProfileCommitment | null,
  ): boolean {
    return this.#snapshot.matches(target, profile ?? undefined);
  }

  protected selectSnapshot(
    target: BinaryTarget,
    profile: AnalysisProfileCommitment,
  ): void {
    this.#snapshot.select(target, profile);
  }

  protected lookupSnapshot(
    target: BinaryTarget,
    profile: AnalysisProfileCommitment,
    operation: AnalysisOperation,
    parameters: Readonly<
      Record<string, import("../domain/jsonValue.js").JsonValue>
    >,
  ): AnalysisExecution | undefined {
    return this.#snapshot.lookup(target, profile, operation, parameters);
  }

  protected recordSnapshot(
    input: Parameters<AnalysisSnapshotCache["record"]>[0],
  ): void {
    this.#snapshot.record(input);
  }

  protected invalidateSnapshot(): void {
    this.#snapshot.clear();
    this.#snapshotInvalidated = true;
  }

  protected resetSnapshotInvalidation(): void {
    this.#snapshotInvalidated = false;
  }

  protected clearSnapshot(): void {
    this.#snapshot.clear();
  }

  protected clearSessionRecords(): void {
    this.#evidence.clear();
    this.#snapshot.clear();
    this.#snapshotInvalidated = false;
  }

  retainInvestigationWorkspace(
    workspace: InvestigationWorkspace,
  ): "added" | "duplicate" {
    const parsed = parseInvestigationWorkspace(workspace);
    const key = workspaceKey(parsed.workspace_id, parsed.revision);
    if (this.#investigationWorkspaces.has(key)) return "duplicate";
    this.#investigationWorkspaces.set(key, parsed);
    return "added";
  }

  investigationWorkspace(
    workspaceId: string,
    revision: number,
  ): InvestigationWorkspace | undefined {
    const workspace = this.#investigationWorkspaces.get(
      workspaceKey(workspaceId, revision),
    );
    return workspace === undefined ? undefined : structuredClone(workspace);
  }

  investigationWorkspaces(): readonly InvestigationWorkspace[] {
    return sortedWorkspaces(this.#investigationWorkspaces.values());
  }

  retainReconstructionCoverageWorkspace(
    workspace: ReconstructionCoverageWorkspace,
  ): "added" | "duplicate" {
    const parsed = parseReconstructionCoverageWorkspace(workspace);
    const key = workspaceKey(parsed.workspace_id, parsed.revision);
    if (this.#coverageWorkspaces.has(key)) return "duplicate";
    this.#coverageWorkspaces.set(key, parsed);
    return "added";
  }

  reconstructionCoverageWorkspace(
    workspaceId: string,
    revision: number,
  ): ReconstructionCoverageWorkspace | undefined {
    const workspace = this.#coverageWorkspaces.get(
      workspaceKey(workspaceId, revision),
    );
    return workspace === undefined ? undefined : structuredClone(workspace);
  }

  reconstructionCoverageWorkspaces(): readonly ReconstructionCoverageWorkspace[] {
    return sortedWorkspaces(this.#coverageWorkspaces.values());
  }

  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    const target = this.activeAnalysisBinding()?.target;
    return this.#evidence.recordUnknown(
      input,
      unknownMutationEvidence(target, input),
    );
  }

  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError> {
    return this.#evidence.recordWithUnknown(
      evidence,
      input,
      unknownMutationEvidence(undefined, input),
    );
  }

  updateUnknown(
    input: UpdateUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    const target = this.activeAnalysisBinding()?.target;
    const evidence = createEvidence(target, UNKNOWN_REGISTRY_PROVIDER, {
      predicateType: "rea.residual-unknown-mutation/v1",
      operation: "update_unknown",
      parameters: {
        unknown_id: input.unknown_id,
        expected_revision: input.expected_revision,
      },
      result: { action: "update", status: input.status },
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: unknownEvidenceLinks(input),
      limitations: [
        "Registry mutation evidence records analyst intent, not proof of the answer.",
      ],
    });
    return this.#evidence.updateUnknown(input, evidence);
  }

  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): ResidualUnknown[] {
    return this.#evidence.listUnknowns(filters);
  }

  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    return this.#evidence.verifyUnknownResolution(unknownId);
  }
}

const workspaceKey = (workspaceId: string, revision: number): string =>
  `${workspaceId}:${String(revision)}`;

const sortedWorkspaces = <
  T extends { readonly workspace_id: string; readonly revision: number },
>(
  workspaces: Iterable<T>,
): readonly T[] =>
  [...workspaces]
    .sort(
      (left, right) =>
        left.workspace_id.localeCompare(right.workspace_id) ||
        left.revision - right.revision,
    )
    .map((workspace) => structuredClone(workspace));
