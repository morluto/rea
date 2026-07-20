import canonicalize from "canonicalize";

import {
  createEvidenceBundle,
  parseEvidenceBundle,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import {
  EvidenceIntegrityError,
  EvidenceLimitError,
  UnknownRegistryError,
} from "../domain/errors.js";
import { parseEvidence, type Evidence } from "../domain/evidence.js";
import {
  createResidualUnknown,
  updateResidualUnknown,
  type RecordUnknownInput,
  type ResidualUnknown,
  type UnknownStatus,
  type UpdateUnknownInput,
} from "../domain/residualUnknown.js";
import { err, ok, type Result } from "../domain/result.js";

export interface EvidenceLedgerLimits {
  readonly maxRecords: number;
  readonly maxBytes: number;
}

type EvidenceLedgerFailure = EvidenceIntegrityError | EvidenceLimitError;
type RecordResult = Result<"added" | "duplicate", EvidenceLedgerFailure>;
type ImportResult = Result<number, EvidenceLedgerFailure>;

/** Bounded, session-owned set of immutable evidence records. */
export class EvidenceLedger {
  readonly #records = new Map<string, Evidence>();
  readonly #unknownRevisions = new Map<string, ResidualUnknown>();
  readonly #unknownHeads = new Map<string, ResidualUnknown>();
  #bytes = 0;

  constructor(private readonly limits: EvidenceLedgerLimits) {
    if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1)
      throw new RangeError("maxRecords must be a positive safe integer");
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1)
      throw new RangeError("maxBytes must be a positive safe integer");
  }

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
    if (
      this.#exceedsRecordLimit(
        this.#records.size + 1,
        this.#unknownRevisions.size,
      )
    )
      return err(new EvidenceLimitError("records", this.limits.maxRecords));
    const bytes = serializedBytes(evidence);
    if (this.#bytes + bytes > this.limits.maxBytes)
      return err(new EvidenceLimitError("bytes", this.limits.maxBytes));
    this.#records.set(evidence.evidence_id, evidence);
    this.#bytes += bytes;
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
    const pending = new Map(this.#records);
    for (const evidence of bundle.records) {
      const existing = pending.get(evidence.evidence_id);
      if (existing !== undefined && !recordsAgree(existing, evidence))
        return err(new EvidenceIntegrityError("Conflicting evidence record"));
      pending.set(evidence.evidence_id, evidence);
    }
    const pendingUnknowns = new Map(this.#unknownRevisions);
    for (const unknown of bundle.unknowns) {
      const key = unknownRevisionKey(unknown);
      const existing = pendingUnknowns.get(key);
      if (
        existing !== undefined &&
        existing.revision_digest !== unknown.revision_digest
      )
        return err(new EvidenceIntegrityError("Conflicting unknown revision"));
      pendingUnknowns.set(key, unknown);
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
    this.#commit(pending, pendingUnknowns, checked.value);
    return ok(added);
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
  ): Result<
    ResidualUnknown,
    EvidenceIntegrityError | EvidenceLimitError | UnknownRegistryError
  > {
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

  /** Atomically record derived Evidence and an approved residual unknown. */
  recordWithUnknown(
    evidenceInput: Evidence,
    input: RecordUnknownInput,
    mutationInput: Evidence,
  ): Result<
    ResidualUnknown | null,
    EvidenceIntegrityError | EvidenceLimitError | UnknownRegistryError
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
    const pendingRecords = new Map(this.#records);
    pendingRecords.set(evidence.evidence_id, evidence);
    const existingUnknown = this.#unknownHeads.get(unknown.unknown_id);
    if (existingUnknown !== undefined) {
      if (
        existingUnknown.revision !== 1 ||
        existingUnknown.revision_digest !== unknown.revision_digest
      )
        return err(new UnknownRegistryError("already-exists"));
      return this.#commitCandidate(pendingRecords, this.#unknownRevisions);
    }
    return this.#appendUnknownCandidate(unknown, mutation, pendingRecords);
  }

  /** Apply one approved full-state update using optimistic revision matching. */
  updateUnknown(
    input: UpdateUnknownInput,
    mutationEvidence: Evidence,
  ): Result<
    ResidualUnknown,
    EvidenceIntegrityError | EvidenceLimitError | UnknownRegistryError
  > {
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
    this.#bytes = 0;
  }

  #appendUnknown(
    unknown: ResidualUnknown,
    mutationEvidenceInput: Evidence,
  ): Result<
    ResidualUnknown,
    EvidenceIntegrityError | EvidenceLimitError | UnknownRegistryError
  > {
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
    return this.#appendUnknownCandidate(
      unknown,
      mutationEvidence,
      new Map(this.#records),
    );
  }

  #appendUnknownCandidate(
    unknown: ResidualUnknown,
    mutationEvidence: Evidence,
    pendingRecords: Map<string, Evidence>,
  ): Result<
    ResidualUnknown,
    EvidenceIntegrityError | EvidenceLimitError | UnknownRegistryError
  > {
    pendingRecords.set(mutationEvidence.evidence_id, mutationEvidence);
    const pendingUnknowns = new Map(this.#unknownRevisions);
    pendingUnknowns.set(unknownRevisionKey(unknown), unknown);
    const committed = this.#commitCandidate(pendingRecords, pendingUnknowns);
    return committed.ok ? ok(structuredClone(unknown)) : err(committed.error);
  }

  #commitCandidate(
    records: ReadonlyMap<string, Evidence>,
    unknowns: ReadonlyMap<string, ResidualUnknown>,
  ): Result<
    null,
    EvidenceIntegrityError | EvidenceLimitError | UnknownRegistryError
  > {
    const checked = this.#validateCandidate(records, unknowns);
    if (!checked.ok) return checked;
    this.#commit(records, unknowns, checked.value);
    return ok(null);
  }

  #validateCandidate(
    records: ReadonlyMap<string, Evidence>,
    unknowns: ReadonlyMap<string, ResidualUnknown>,
  ): Result<
    number,
    EvidenceIntegrityError | EvidenceLimitError | UnknownRegistryError
  > {
    if (this.#exceedsRecordLimit(records.size, unknowns.size))
      return err(new EvidenceLimitError("records", this.limits.maxRecords));
    const bytes =
      [...records.values()].reduce(
        (total, evidence) => total + serializedBytes(evidence),
        0,
      ) +
      [...unknowns.values()].reduce(
        (total, unknown) => total + serializedBytes(unknown),
        0,
      );
    if (bytes > this.limits.maxBytes)
      return err(new EvidenceLimitError("bytes", this.limits.maxBytes));
    try {
      parseEvidenceBundle(
        createEvidenceBundle([...records.values()], [...unknowns.values()]),
      );
    } catch (cause: unknown) {
      return err(new UnknownRegistryError("integrity", { cause }));
    }
    return ok(bytes);
  }

  #exceedsRecordLimit(recordCount: number, unknownCount: number): boolean {
    return recordCount + unknownCount > this.limits.maxRecords;
  }

  #commit(
    records: ReadonlyMap<string, Evidence>,
    unknowns: ReadonlyMap<string, ResidualUnknown>,
    bytes: number,
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
    this.#bytes = bytes;
  }
}

const serializedBytes = (value: Evidence | ResidualUnknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

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
