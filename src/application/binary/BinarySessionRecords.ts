import type { AnalysisProfileCommitment } from "../../domain/analysisProfile.js";
import type { AnalysisSnapshot } from "../../domain/analysisSnapshot.js";
import type { BinaryTarget } from "../../domain/binaryTarget.js";
import type { Evidence } from "../../domain/evidence.js";
import type { EvidenceBundle } from "../../domain/evidenceBundle.js";
import { evidenceBundleForTarget } from "../../domain/evidenceBundle.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { type AnalysisError } from "../../domain/analysisErrorBase.js";
import { type UnknownRegistryError } from "../../domain/unknownRegistryError.js";
import type {
  RecordUnknownInput,
  ResidualUnknown,
  UnknownStatus,
  UpdateUnknownInput,
} from "../../domain/residualUnknown.js";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  AnalysisExecution,
  AnalysisOperation,
} from "../AnalysisProvider.js";
import { AnalysisSnapshotCache } from "./AnalysisSnapshotCache.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";

export interface ActiveAnalysisBinding {
  readonly target: BinaryTarget;
  readonly profile: AnalysisProfileCommitment | null;
}

/** Binary snapshot owner and compatibility facade for composed investigation records. */
export abstract class BinarySessionRecords {
  readonly #records: InvestigationRecords;
  readonly #snapshot = new AnalysisSnapshotCache();
  #snapshotInvalidated = false;
  readonly #snapshotListeners = new Set<() => void | Promise<void>>();

  constructor(records: InvestigationRecords = new InvestigationRecords()) {
    this.#records = records;
  }

  /** Observe changes to the mutable current analysis snapshot resource. */
  onAnalysisSnapshotChanged(listener: () => void | Promise<void>): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  recordEvidence(
    evidence: Evidence,
  ): Result<"added" | "duplicate", EvidenceIntegrityError> {
    const recorded = this.#records.recordEvidence(evidence);
    if (recorded.ok && recorded.value === "added") this.#emitSnapshotChanged();
    return recorded;
  }

  hasEvidence(evidenceId: string): boolean {
    return this.#records.hasEvidence(evidenceId);
  }

  evidenceById(evidenceId: string): Evidence | undefined {
    return this.#records.evidenceById(evidenceId);
  }

  exportEvidenceBundle(): EvidenceBundle {
    return this.#records.exportEvidenceBundle();
  }

  importEvidenceBundle(
    bundle: unknown,
  ): Result<number, EvidenceIntegrityError> {
    const imported = this.#records.mergeEvidenceBundle(bundle);
    if (!imported.ok) return imported;
    if (imported.value.metadataChanged) this.invalidateSnapshot();
    else if (imported.value.changed) this.#emitSnapshotChanged();
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
        ? this.#records.exportEvidenceBundle()
        : evidenceBundleForTarget(
            this.#records.exportEvidenceBundle(),
            target.sha256,
          ),
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
        const imported = this.#records.mergeEvidenceBundle(bundle);
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
      Record<string, import("../../domain/jsonValue.js").JsonValue>
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

  /** Retain one derived workflow result alongside its provider cache entries. */
  recordWorkflowSnapshot(input: {
    readonly operation: string;
    readonly parameters: Readonly<
      Record<string, import("../../domain/jsonValue.js").JsonValue>
    >;
    readonly execution: Parameters<
      AnalysisSnapshotCache["recordWorkflow"]
    >[0]["execution"];
  }): Result<null, EvidenceIntegrityError> {
    const active = this.activeAnalysisBinding();
    if (active === undefined || active.profile === null)
      return err(
        new EvidenceIntegrityError(
          "Workflow snapshot entries require an active concrete provider profile",
        ),
      );
    try {
      this.#snapshot.recordWorkflow({
        target: active.target,
        profile: active.profile,
        ...input,
      });
      this.#emitSnapshotChanged();
      return ok(null);
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError(
          cause instanceof Error
            ? cause.message
            : "Workflow snapshot entry validation failed",
          { cause },
        ),
      );
    }
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
    this.#records.clear();
    this.#snapshot.clear();
    this.#snapshotInvalidated = false;
    this.#emitSnapshotChanged();
  }

  #emitSnapshotChanged(): void {
    for (const listener of this.#snapshotListeners) {
      try {
        const notification = listener();
        if (notification !== undefined)
          void notification.catch((cause: unknown) => {
            // best-effort cleanup: async observer notifications must not reject unhandled.
            void cause;
          });
      } catch (cause: unknown) {
        // External resource observers are best-effort; one callback must not
        // make a committed evidence mutation appear to fail.
        void cause;
      }
    }
  }

  recordUnknown(
    input: RecordUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    const target = this.activeAnalysisBinding()?.target;
    const recorded = this.#records.recordUnknown(input, target);
    if (recorded.ok) this.#emitSnapshotChanged();
    return recorded;
  }

  recordEvidenceWithUnknown(
    evidence: Evidence,
    input: RecordUnknownInput,
  ): Result<ResidualUnknown | null, AnalysisError> {
    const recorded = this.#records.recordEvidenceWithUnknown(evidence, input);
    if (recorded.ok) this.#emitSnapshotChanged();
    return recorded;
  }

  updateUnknown(
    input: UpdateUnknownInput,
  ): Result<ResidualUnknown, AnalysisError> {
    const target = this.activeAnalysisBinding()?.target;
    const updated = this.#records.updateUnknown(input, target);
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
    return this.#records.listUnknowns(filters);
  }

  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    return this.#records.verifyUnknownResolution(unknownId);
  }
}
