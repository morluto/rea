import canonicalize from "canonicalize";

import {
  createEvidenceBundle,
  parseEvidenceBundle,
  validateResidualUnknownAddition,
  type EvidenceBundle,
} from "../../domain/evidenceBundle.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { UnknownRegistryError } from "../../domain/unknownRegistryError.js";
import { parseEvidence, type Evidence } from "../../domain/evidence.js";
import {
  createResidualUnknown,
  updateResidualUnknown,
  type RecordUnknownInput,
  type ResidualUnknown,
  type UnknownStatus,
  type UpdateUnknownInput,
} from "../../domain/residualUnknown.js";
import { err, ok, type Result } from "../../domain/result.js";

type EvidenceLedgerFailure = EvidenceIntegrityError;
type RecordResult = Result<"added" | "duplicate", EvidenceLedgerFailure>;

/** Describes the state changes made by one atomic bundle import. */
export interface EvidenceImportDelta {
  readonly recordsAdded: number;
  readonly unknownsAdded: number;
  readonly changed: boolean;
}

type ImportResult = Result<EvidenceImportDelta, EvidenceLedgerFailure>;

/** Session-owned set of immutable evidence records. */
export class EvidenceLedger {
  readonly #records = new Map<string, Evidence>();
  readonly #unknownRevisions = new Map<string, ResidualUnknown>();
  readonly #unknownHeads = new Map<string, ResidualUnknown>();
  /** Record evidence idempotently; conflicting content is rejected. */
  record(input: Evidence): RecordResult {
    let evidence: Evidence;
    try {
      evidence = parseEvidence(input);
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError("Evidence record validation failed", {
          cause,
        }),
      );
    }
    const existing = this.#records.get(evidence.evidence_id);
    if (existing !== undefined) {
      return recordsAgree(existing, evidence)
        ? ok("duplicate")
        : err(new EvidenceIntegrityError("Conflicting evidence record"));
    }
    this.#records.set(evidence.evidence_id, evidence);
    return ok("added");
  }

  /** Validate an entire bundle before atomically merging its records. */
  import(input: unknown): ImportResult {
    let bundle: EvidenceBundle;
    try {
      bundle = parseEvidenceBundle(input);
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError("Evidence bundle validation failed", {
          cause,
        }),
      );
    }
    // A record-only bundle cannot change the already-valid unknown graph. The
    // bundle parser has validated every incoming record and its manifests, so
    // checking ID conflicts and committing only the additions preserves the
    // atomic merge without rebuilding and reparsing the entire ledger.
    if (bundle.unknowns.length === 0) {
      const additions = new Map<string, Evidence>();
      const replacements = new Map<string, Evidence>();
      let metadataChanged = false;
      for (const evidence of bundle.records) {
        const existing = this.#records.get(evidence.evidence_id);
        if (existing !== undefined) {
          if (!recordsAgree(existing, evidence))
            return err(
              new EvidenceIntegrityError("Conflicting evidence record"),
            );
          if (canonicalize(existing) !== canonicalize(evidence)) {
            replacements.set(evidence.evidence_id, evidence);
            metadataChanged = true;
          }
          continue;
        }
        additions.set(evidence.evidence_id, evidence);
      }
      for (const [id, evidence] of replacements)
        this.#records.set(id, evidence);
      for (const [id, evidence] of additions) this.#records.set(id, evidence);
      return ok({
        recordsAdded: additions.size,
        unknownsAdded: 0,
        changed: additions.size > 0 || metadataChanged,
      });
    }
    const pending = new Map(this.#records);
    let metadataChanged = false;
    for (const evidence of bundle.records) {
      const existing = pending.get(evidence.evidence_id);
      if (existing !== undefined && !recordsAgree(existing, evidence))
        return err(new EvidenceIntegrityError("Conflicting evidence record"));
      if (
        existing !== undefined &&
        canonicalize(existing) !== canonicalize(evidence)
      )
        metadataChanged = true;
      pending.set(evidence.evidence_id, evidence);
    }
    const pendingUnknowns = new Map(this.#unknownRevisions);
    let unknownsAdded = 0;
    for (const unknown of bundle.unknowns) {
      const key = unknownRevisionKey(unknown);
      const existing = pendingUnknowns.get(key);
      if (
        existing !== undefined &&
        existing.revision_digest !== unknown.revision_digest
      )
        return err(new EvidenceIntegrityError("Conflicting unknown revision"));
      pendingUnknowns.set(key, unknown);
      if (existing === undefined) unknownsAdded += 1;
    }
    const checked = this.#validateCandidate(pending, pendingUnknowns);
    if (!checked.ok) {
      if (checked.error instanceof UnknownRegistryError)
        return err(
          new EvidenceIntegrityError(
            "Evidence bundle unknown registry failed",
            {
              cause: checked.error,
            },
          ),
        );
      return err(checked.error);
    }
    const added = pending.size - this.#records.size;
    this.#commit(pending, pendingUnknowns);
    return ok({
      recordsAdded: added,
      unknownsAdded,
      changed: added > 0 || unknownsAdded > 0 || metadataChanged,
    });
  }

  /** Export records in deterministic, semantically irrelevant ID order. */
  export(): EvidenceBundle {
    return structuredClone(
      createEvidenceBundle(
        [...this.#records.values()],
        [...this.#unknownRevisions.values()],
      ),
    );
  }

  /** Check whether one immutable Evidence ID is present in this ledger. */
  has(evidenceId: string): boolean {
    return this.#records.has(evidenceId);
  }

  /** Return a detached immutable Evidence value by semantic ID. */
  get(evidenceId: string): Evidence | undefined {
    const evidence = this.#records.get(evidenceId);
    return evidence === undefined ? undefined : structuredClone(evidence);
  }

  /** Create one approved unknown and atomically append its mutation evidence. */
  recordUnknown(
    input: RecordUnknownInput,
    mutationEvidence: Evidence,
  ): Result<ResidualUnknown, EvidenceIntegrityError | UnknownRegistryError> {
    let parsedMutation: Evidence;
    try {
      parsedMutation = parseEvidence(mutationEvidence);
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError("Unknown mutation evidence is invalid", {
          cause,
        }),
      );
    }
    let unknown: ResidualUnknown;
    try {
      unknown = createResidualUnknown(
        input,
        parsedMutation.evidence_id,
        parsedMutation.subject?.digest.sha256 ?? null,
      );
    } catch (cause: unknown) {
      return err(new UnknownRegistryError("invalid-transition", { cause }));
    }
    if (this.#unknownHeads.has(unknown.unknown_id))
      return err(new UnknownRegistryError("already-exists"));
    return this.#appendUnknown(unknown, parsedMutation);
  }

  /** Atomically record derived Evidence and a linked residual unknown. */
  recordWithUnknown(
    evidenceInput: Evidence,
    input: RecordUnknownInput,
    mutationInput: Evidence,
  ): Result<
    ResidualUnknown | null,
    EvidenceIntegrityError | UnknownRegistryError
  > {
    let evidence: Evidence;
    let mutation: Evidence;
    try {
      evidence = parseEvidence(evidenceInput);
      mutation = parseEvidence(mutationInput);
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError("Atomic Evidence validation failed", {
          cause,
        }),
      );
    }
    const existingEvidence = this.#records.get(evidence.evidence_id);
    if (
      existingEvidence !== undefined &&
      !recordsAgree(existingEvidence, evidence)
    )
      return err(new EvidenceIntegrityError("Conflicting evidence record"));
    let unknown: ResidualUnknown;
    try {
      unknown = createResidualUnknown(
        input,
        mutation.evidence_id,
        mutation.subject?.digest.sha256 ?? null,
      );
    } catch (cause: unknown) {
      return err(new UnknownRegistryError("invalid-transition", { cause }));
    }
    const existingUnknown = this.#unknownHeads.get(unknown.unknown_id);
    if (existingUnknown !== undefined) {
      if (
        existingUnknown.revision !== 1 ||
        existingUnknown.revision_digest !== unknown.revision_digest
      )
        return err(new UnknownRegistryError("already-exists"));
      const checked = this.#appendIncremental([evidence]);
      if (!checked.ok) return checked;
      return ok(null);
    }
    const checked = this.#appendIncremental([evidence, mutation], unknown);
    if (!checked.ok) return checked;
    return ok(structuredClone(unknown));
  }

  /** Apply one approved full-state update using optimistic revision matching. */
  updateUnknown(
    input: UpdateUnknownInput,
    mutationEvidence: Evidence,
  ): Result<ResidualUnknown, EvidenceIntegrityError | UnknownRegistryError> {
    const current = this.#unknownHeads.get(input.unknown_id);
    if (current === undefined)
      return err(new UnknownRegistryError("not-found"));
    if (current.revision !== input.expected_revision)
      return err(new UnknownRegistryError("revision-conflict"));
    let unknown: ResidualUnknown;
    try {
      unknown = updateResidualUnknown(
        current,
        input,
        mutationEvidence.evidence_id,
      );
    } catch (cause: unknown) {
      return err(new UnknownRegistryError("invalid-transition", { cause }));
    }
    return this.#appendUnknown(unknown, mutationEvidence);
  }

  /** Query current heads in stable ID order. */
  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): ResidualUnknown[] {
    return [...this.#unknownHeads.values()]
      .filter(
        (unknown) =>
          (filters.status === undefined || unknown.status === filters.status) &&
          (filters.severity === undefined ||
            unknown.severity === filters.severity) &&
          (filters.domain === undefined || unknown.domain === filters.domain),
      )
      .sort((left, right) => left.unknown_id.localeCompare(right.unknown_id))
      .map((unknown) => structuredClone(unknown));
  }

  /** Return current resolution validity; imported invalid states are rejected. */
  verifyUnknownResolution(unknownId: string): Result<
    {
      readonly valid: boolean;
      readonly truthVerified: boolean;
      readonly unknown: ResidualUnknown;
    },
    UnknownRegistryError
  > {
    const unknown = this.#unknownHeads.get(unknownId);
    if (unknown === undefined)
      return err(new UnknownRegistryError("not-found"));
    return ok({
      valid: unknown.status === "resolved",
      truthVerified: unknown.resolution?.disposition === "verified",
      unknown: structuredClone(unknown),
    });
  }

  /** Clear records when the owning session closes. */
  clear(): void {
    this.#records.clear();
    this.#unknownRevisions.clear();
    this.#unknownHeads.clear();
  }

  #appendUnknown(
    unknown: ResidualUnknown,
    mutationEvidenceInput: Evidence,
  ): Result<ResidualUnknown, EvidenceIntegrityError | UnknownRegistryError> {
    let mutationEvidence: Evidence;
    try {
      mutationEvidence = parseEvidence(mutationEvidenceInput);
    } catch (cause: unknown) {
      return err(
        new EvidenceIntegrityError("Unknown mutation evidence is invalid", {
          cause,
        }),
      );
    }
    const checked = this.#appendIncremental([mutationEvidence], unknown);
    if (!checked.ok) return checked;
    return ok(structuredClone(unknown));
  }

  #appendIncremental(
    records: readonly Evidence[],
    unknown?: ResidualUnknown,
  ): Result<void, EvidenceIntegrityError | UnknownRegistryError> {
    const additions = new Map<string, Evidence>();
    for (const evidence of records) {
      const existing =
        additions.get(evidence.evidence_id) ??
        this.#records.get(evidence.evidence_id);
      if (existing !== undefined) {
        if (!recordsAgree(existing, evidence))
          return err(new EvidenceIntegrityError("Conflicting evidence record"));
        continue;
      }
      additions.set(evidence.evidence_id, evidence);
    }
    const unknownKey =
      unknown === undefined ? undefined : unknownRevisionKey(unknown);
    if (unknownKey !== undefined && this.#unknownRevisions.has(unknownKey))
      return err(new UnknownRegistryError("integrity"));
    if (unknown !== undefined)
      try {
        validateResidualUnknownAddition(
          unknown,
          {
            get: (id) => additions.get(id) ?? this.#records.get(id),
            has: (id) => additions.has(id) || this.#records.has(id),
          },
          this.#unknownHeads,
        );
      } catch (cause: unknown) {
        return err(new UnknownRegistryError("integrity", { cause }));
      }
    for (const [id, evidence] of additions) this.#records.set(id, evidence);
    if (unknown !== undefined && unknownKey !== undefined) {
      this.#unknownRevisions.set(unknownKey, unknown);
      this.#unknownHeads.set(unknown.unknown_id, unknown);
    }
    return ok(undefined);
  }

  #validateCandidate(
    records: ReadonlyMap<string, Evidence>,
    unknowns: ReadonlyMap<string, ResidualUnknown>,
  ): Result<void, EvidenceIntegrityError | UnknownRegistryError> {
    try {
      parseEvidenceBundle(
        createEvidenceBundle([...records.values()], [...unknowns.values()]),
      );
    } catch (cause: unknown) {
      return err(new UnknownRegistryError("integrity", { cause }));
    }
    return ok(undefined);
  }

  #commit(
    records: ReadonlyMap<string, Evidence>,
    unknowns: ReadonlyMap<string, ResidualUnknown>,
  ): void {
    this.#records.clear();
    for (const [id, evidence] of records) this.#records.set(id, evidence);
    this.#unknownRevisions.clear();
    this.#unknownHeads.clear();
    for (const [key, unknown] of unknowns) {
      this.#unknownRevisions.set(key, unknown);
      const head = this.#unknownHeads.get(unknown.unknown_id);
      if (head === undefined || head.revision < unknown.revision)
        this.#unknownHeads.set(unknown.unknown_id, unknown);
    }
  }
}

const unknownRevisionKey = (unknown: ResidualUnknown): string =>
  `${unknown.unknown_id}:${String(unknown.revision)}`;

const recordsAgree = (left: Evidence, right: Evidence): boolean =>
  canonicalize(withoutLocalPath(left)) ===
  canonicalize(withoutLocalPath(right));

const withoutLocalPath = (evidence: Evidence): Evidence => ({
  ...evidence,
  subject:
    evidence.subject === null
      ? null
      : {
          ...evidence.subject,
          name: "<non-identity-name>",
          local_path: "<non-identity-local-path>",
        },
});
