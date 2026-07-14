import {
  createResidualUnknown,
  updateResidualUnknown,
  residualUnknownSchema,
  type RecordUnknownInput,
  type ResidualUnknown,
  type UnknownStatus,
  type UpdateUnknownInput,
} from "../domain/residualUnknown.js";
import { UnknownRegistryError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

export interface UnknownRegistryLimits {
  readonly maxRecords: number;
  readonly maxRelationships: number;
}

type UnknownRegistryMutation = Result<ResidualUnknown, UnknownRegistryError>;

type UnknownRegistryQuery = Result<
  readonly ResidualUnknown[],
  UnknownRegistryError
>;

type UnknownRegistryVerify = Result<
  {
    readonly valid: boolean;
    readonly truthVerified: boolean;
    readonly unknown: ResidualUnknown;
  },
  UnknownRegistryError
>;

/**
 * Persistent, bounded registry of residual unknowns linked to evidence.
 *
 * Each unknown carries a stable ID derived from its question and scope,
 * an immutable revision graph, and evidence-qualified resolution state.
 */
export class UnknownRegistry {
  readonly #revisions = new Map<string, ResidualUnknown>();
  readonly #heads = new Map<string, ResidualUnknown>();

  constructor(private readonly limits: UnknownRegistryLimits) {
    if (!Number.isSafeInteger(limits.maxRecords) || limits.maxRecords < 1)
      throw new RangeError("maxRecords must be a positive safe integer");
    if (
      !Number.isSafeInteger(limits.maxRelationships) ||
      limits.maxRelationships < 0
    )
      throw new RangeError(
        "maxRelationships must be a non-negative safe integer",
      );
  }

  recordUnknown(
    input: RecordUnknownInput,
    mutationEvidenceId: string,
  ): UnknownRegistryMutation {
    let unknown: ResidualUnknown;
    try {
      unknown = createResidualUnknown(input, mutationEvidenceId, null);
    } catch (cause: unknown) {
      return err(new UnknownRegistryError("invalid-transition", { cause }));
    }
    if (this.#heads.has(unknown.unknown_id))
      return err(new UnknownRegistryError("already-exists"));
    return this.#append(unknown);
  }

  updateUnknown(
    input: UpdateUnknownInput,
    mutationEvidenceId: string,
  ): UnknownRegistryMutation {
    const current = this.#heads.get(input.unknown_id);
    if (current === undefined)
      return err(new UnknownRegistryError("not-found"));
    if (current.revision !== input.expected_revision)
      return err(new UnknownRegistryError("revision-conflict"));
    let updated: ResidualUnknown;
    try {
      updated = updateResidualUnknown(current, input, mutationEvidenceId);
    } catch (cause: unknown) {
      return err(new UnknownRegistryError("invalid-transition", { cause }));
    }
    return this.#append(updated);
  }

  listUnknowns(
    filters: {
      readonly status?: UnknownStatus;
      readonly severity?: ResidualUnknown["severity"];
      readonly domain?: string;
    } = {},
  ): UnknownRegistryQuery {
    return ok(
      [...this.#heads.values()]
        .filter(
          (unknown) =>
            (filters.status === undefined ||
              unknown.status === filters.status) &&
            (filters.severity === undefined ||
              unknown.severity === filters.severity) &&
            (filters.domain === undefined || unknown.domain === filters.domain),
        )
        .sort((left, right) => left.unknown_id.localeCompare(right.unknown_id)),
    );
  }

  verifyUnknownResolution(unknownId: string): UnknownRegistryVerify {
    const unknown = this.#heads.get(unknownId);
    if (unknown === undefined)
      return err(new UnknownRegistryError("not-found"));
    return ok({
      valid: unknown.status === "resolved",
      truthVerified: unknown.resolution?.disposition === "verified",
      unknown,
    });
  }

  get(unknownId: string): ResidualUnknown | undefined {
    const unknown = this.#heads.get(unknownId);
    return unknown === undefined ? undefined : structuredClone(unknown);
  }

  has(unknownId: string): boolean {
    return this.#heads.has(unknownId);
  }

  clear(): void {
    this.#revisions.clear();
    this.#heads.clear();
  }

  #append(unknown: ResidualUnknown): UnknownRegistryMutation {
    const pending = this.#revisions.size + 1;
    if (pending > this.limits.maxRecords)
      return err(new UnknownRegistryError("limit"));
    if (unknown.relationships.length > this.limits.maxRelationships)
      return err(new UnknownRegistryError("limit"));
    try {
      residualUnknownSchema.parse(unknown);
    } catch (cause: unknown) {
      return err(new UnknownRegistryError("integrity", { cause }));
    }
    this.#revisions.set(
      `${unknown.unknown_id}:${String(unknown.revision)}`,
      unknown,
    );
    this.#heads.set(unknown.unknown_id, unknown);
    return ok(unknown);
  }
}
