import type { AnalysisProfileCommitment } from "../domain/analysisProfile.js";
import type { AnalysisSnapshot } from "../domain/analysisSnapshot.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import type { EvidenceBundle } from "../domain/evidenceBundle.js";
import { evidenceBundleForTarget } from "../domain/evidenceBundle.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { type UnknownRegistryError } from "../domain/unknownRegistryError.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../domain/residualUnknown.js";
import { err, ok, type Result } from "../domain/result.js";
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

/** Owns session evidence, snapshots, and residual unknowns. */
export abstract class BinarySessionRecords {
  readonly #evidence = new EvidenceLedger();
  readonly #snapshot = new AnalysisSnapshotCache();
  #snapshotInvalidated = false;
  readonly #snapshotListeners = new Set<() => void | Promise<void>>();

  /** Observe changes to the mutable current analysis snapshot resource. */
  onAnalysisSnapshotChanged(listener: () => void | Promise<void>): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  recordEvidence(
    evidence: Evidence,
  ): Result<"added" | "duplicate", EvidenceIntegrityError> {
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

  importEvidenceBundle(
    bundle: unknown,
  ): Result<number, EvidenceIntegrityError> {
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
      predicateType: "rea.residual-unknown-mutation",
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
