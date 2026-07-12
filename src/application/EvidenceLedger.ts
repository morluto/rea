import {
  createEvidenceBundle,
  evidenceBundleSchema,
  type EvidenceBundle,
} from "../domain/evidenceBundle.js";
import { parseEvidence, type Evidence } from "../domain/evidence.js";

export interface EvidenceLedgerLimits {
  readonly maxRecords: number;
}

/** Bounded, session-owned set of immutable evidence records. */
export class EvidenceLedger {
  readonly #records = new Map<string, Evidence>();

  constructor(private readonly limits: EvidenceLedgerLimits) {
    if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1)
      throw new RangeError("maxRecords must be a positive safe integer");
  }

  /** Record evidence idempotently; conflicting content is rejected. */
  record(input: Evidence): "added" | "duplicate" {
    const evidence = parseEvidence(input);
    const existing = this.#records.get(evidence.evidence_id);
    if (existing !== undefined) {
      if (!recordsAgree(existing, evidence))
        throw new Error(`Conflicting evidence record: ${evidence.evidence_id}`);
      return "duplicate";
    }
    if (this.#records.size >= this.limits.maxRecords)
      throw new RangeError("Evidence ledger record limit exceeded");
    this.#records.set(evidence.evidence_id, evidence);
    return "added";
  }

  /** Validate an entire bundle before atomically merging its records. */
  import(input: unknown): number {
    const bundle = evidenceBundleSchema.parse(input);
    const pending = new Map(this.#records);
    for (const unparsed of bundle.records) {
      const evidence = parseEvidence(unparsed);
      const existing = pending.get(evidence.evidence_id);
      if (existing !== undefined && !recordsAgree(existing, evidence))
        throw new Error(`Conflicting evidence record: ${evidence.evidence_id}`);
      pending.set(evidence.evidence_id, evidence);
    }
    if (pending.size > this.limits.maxRecords)
      throw new RangeError("Evidence ledger record limit exceeded");
    const added = pending.size - this.#records.size;
    this.#records.clear();
    for (const [id, evidence] of pending) this.#records.set(id, evidence);
    return added;
  }

  /** Export records in deterministic, semantically irrelevant ID order. */
  export(): EvidenceBundle {
    return createEvidenceBundle([...this.#records.values()]);
  }

  /** Clear records when the owning session closes. */
  clear(): void {
    this.#records.clear();
  }
}

const recordsAgree = (left: Evidence, right: Evidence): boolean =>
  JSON.stringify(withoutLocalPath(left)) ===
  JSON.stringify(withoutLocalPath(right));

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
