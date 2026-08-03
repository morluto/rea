import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import {
  evidenceBundleForTarget,
  serializeEvidenceBundle,
} from "../domain/evidenceBundle.js";
import {
  EvidenceIntegrityError,
  EvidenceLimitError,
  type AnalysisError,
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
import { err, ok, type Result } from "../domain/result.js";
import type { EvidenceBundleSnapshot } from "./BinarySessionPort.js";
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
  static readonly MAX_RETAINED_BUNDLES = 16;
  static readonly MAX_RETAINED_BUNDLE_BYTES = 64 * 1024 * 1024;
  readonly #evidence = new EvidenceLedger({
    maxRecords: 10_000,
    maxBytes: 64 * 1024 * 1024,
  });
  readonly #snapshot = new AnalysisSnapshotCache();
  readonly #retainedBundles = new Map<string, string>();
  #retainedBundleBytes = 0;
  readonly #investigationWorkspaces = new Map<string, InvestigationWorkspace>();
  readonly #coverageWorkspaces = new Map<
    string,
    ReconstructionCoverageWorkspace
  >();
  #snapshotInvalidated = false;
  readonly #snapshotListeners = new Set<() => void | Promise<void>>();

  /** Observe changes to the mutable current analysis snapshot resource. */
  onAnalysisSnapshotChanged(listener: () => void | Promise<void>): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  recordEvidence(
    evidence: Evidence,
  ): Result<
    "added" | "duplicate",
    EvidenceIntegrityError | EvidenceLimitError
  > {
    const recorded = this.#evidence.record(evidence);
    if (recorded.ok && recorded.value === "added") this.#emitSnapshotChanged();
    return recorded;
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

  snapshotEvidenceBundle(): Result<EvidenceBundleSnapshot, EvidenceLimitError> {
    const bundle = this.#evidence.export();
    const encoded = serializeEvidenceBundle(bundle);
    const digest = createHash("sha256").update(encoded).digest("hex");
    const existing = this.#retainedBundles.get(digest);
    if (existing === undefined) {
      if (
        this.#retainedBundles.size >= BinarySessionRecords.MAX_RETAINED_BUNDLES
      )
        return err(
          new EvidenceLimitError(
            "records",
            BinarySessionRecords.MAX_RETAINED_BUNDLES,
          ),
        );
      const bytes = Buffer.byteLength(encoded);
      if (
        this.#retainedBundleBytes + bytes >
        BinarySessionRecords.MAX_RETAINED_BUNDLE_BYTES
      )
        return err(
          new EvidenceLimitError(
            "bytes",
            BinarySessionRecords.MAX_RETAINED_BUNDLE_BYTES,
          ),
        );
      this.#retainedBundles.set(digest, encoded);
      this.#retainedBundleBytes += bytes;
    }
    return ok({
      bundleDigest: digest,
      bundleVersion: 2,
      bytes: Buffer.byteLength(existing ?? encoded),
      records: bundle.records.length,
      unknowns: bundle.unknowns.length,
      scope: "session",
      survivesSession: false,
      uri: `rea://evidence-bundle/${digest}`,
    });
  }

  retainedEvidenceBundle(digest: string): string | undefined {
    return this.#retainedBundles.get(digest);
  }

  /** Release one immutable bundle so bounded retention has an explicit recovery path. */
  releaseEvidenceBundle(bundleDigest: string): boolean {
    const encoded = this.#retainedBundles.get(bundleDigest);
    if (encoded === undefined) return false;
    this.#retainedBundles.delete(bundleDigest);
    this.#retainedBundleBytes -= Buffer.byteLength(encoded);
    this.#emitSnapshotChanged();
    return true;
  }

  importEvidenceBundle(
    bundle: unknown,
  ): Result<number, EvidenceIntegrityError | EvidenceLimitError> {
    const imported = this.#evidence.import(bundle);
    if (!imported.ok) return imported;
    if (imported.value.changed) this.#emitSnapshotChanged();
    return ok(imported.value.recordsAdded);
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
    const imported = this.#snapshot.import(
      snapshot,
      active === undefined
        ? undefined
        : { target: active.target, profile: active.profile },
      (bundle) => {
        const imported = this.#evidence.import(bundle);
        return imported.ok ? ok(imported.value.recordsAdded) : imported;
      },
    );
    if (imported.ok) this.#emitSnapshotChanged();
    return imported;
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
    this.#emitSnapshotChanged();
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
    this.#emitSnapshotChanged();
  }

  protected invalidateSnapshot(): void {
    this.#snapshot.clear();
    this.#snapshotInvalidated = true;
    this.#emitSnapshotChanged();
  }

  protected resetSnapshotInvalidation(): void {
    if (!this.#snapshotInvalidated) return;
    this.#snapshotInvalidated = false;
    this.#emitSnapshotChanged();
  }

  protected clearSnapshot(): void {
    this.#snapshot.clear();
    this.#emitSnapshotChanged();
  }

  protected clearSessionRecords(): void {
    this.#evidence.clear();
    this.#snapshot.clear();
    this.#snapshotInvalidated = false;
    this.#retainedBundles.clear();
    this.#retainedBundleBytes = 0;
    this.#emitSnapshotChanged();
  }

  #emitSnapshotChanged(): void {
    for (const listener of this.#snapshotListeners) {
      try {
        const notification = listener();
        if (notification !== undefined)
          void notification.catch(() => undefined);
      } catch {
        // External resource observers are best-effort; one callback must not
        // make a committed evidence mutation appear to fail.
      }
    }
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
    const recorded = this.#evidence.recordUnknown(
      input,
      unknownMutationEvidence(target, input),
    );
    if (recorded.ok) this.#emitSnapshotChanged();
    return recorded;
  }

  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError> {
    const recorded = this.#evidence.recordWithUnknown(
      evidence,
      input,
      unknownMutationEvidence(undefined, input),
    );
    if (recorded.ok) this.#emitSnapshotChanged();
    return recorded;
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
    const updated = this.#evidence.updateUnknown(input, evidence);
    if (updated.ok) this.#emitSnapshotChanged();
    return updated;
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
import { createHash } from "node:crypto";
