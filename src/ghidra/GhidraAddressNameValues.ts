import { z } from "zod";
import { nativeAddressObservationSchema } from "../domain/native/nativeAddress.js";
import { jsonRecordSchema } from "../domain/jsonRecord.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

/** Exact source keys retained by successful naming request admission. */
export interface GhidraNamingRequest {
  readonly keys: readonly string[];
}

type GhidraNamingOperation = "set_address_name" | "set_addresses_names";

/**
 * Bridge-owned reasons why Ghidra did not apply one requested analyst name.
 * Batch reasons are decided from the names held before the batch.
 */
const ADDRESS_NAME_FAILURE_REASONS = [
  "invalid_address",
  "unmapped_address",
  "invalid_name",
  "conflicting_alias_names",
  "duplicate_requested_name",
  "name_held_by_selected_address",
  "name_held_by_unselected_address",
  "duplicate_name",
  "readback_mismatch",
] as const;
type AddressNameFailureReason = (typeof ADDRESS_NAME_FAILURE_REASONS)[number];
/** Reasons explained by one shared contested-destination record. */
const conflictReasons: ReadonlySet<AddressNameFailureReason> = new Set([
  "duplicate_requested_name",
  "name_held_by_selected_address",
  "name_held_by_unselected_address",
]);
/** Reasons a single-address edit can report; selection conflicts need a batch. */
const singleAddressNameReasons: ReadonlySet<AddressNameFailureReason> = new Set(
  [
    "invalid_name",
    "name_held_by_unselected_address",
    "duplicate_name",
    "readback_mismatch",
  ],
);
const distinct = (values: readonly string[]) =>
  new Set(values).size === values.length;
const addressNameFailure = z
  .strictObject({
    address: nativeAddressObservationSchema.nullable(),
    reason: z.enum(ADDRESS_NAME_FAILURE_REASONS),
    conflict: z.int().min(0).nullable(),
  })
  .superRefine((failure, context) => {
    if ((failure.address === null) !== (failure.reason === "invalid_address"))
      context.addIssue({
        code: "custom",
        path: ["address"],
        message: "Only an unresolved address lacks its canonical address",
      });
    if ((failure.conflict === null) === conflictReasons.has(failure.reason))
      context.addIssue({
        code: "custom",
        path: ["conflict"],
        message:
          "Exactly the conflict reasons refer to a contested destination",
      });
  });
/** One contested destination, shared by every address that requested it. */
const addressNameConflict = z.strictObject({
  namespace: z.string().min(1).nullable(),
  name: z.string().min(1),
  requested_by: z
    .array(nativeAddressObservationSchema)
    .min(1)
    .refine(distinct, "Requesting addresses are distinct"),
  held_by: z
    .array(nativeAddressObservationSchema)
    .refine(distinct, "Holding addresses are distinct"),
});
/**
 * Per-key booleans, reasons for failed keys and each contested destination
 * once, so reply size grows linearly with the request and its holders.
 */
const addressNameOutcomes = z
  .strictObject({
    results: jsonRecordSchema(z.boolean()),
    failures: jsonRecordSchema(addressNameFailure),
    conflicts: z.array(addressNameConflict),
  })
  .superRefine(({ results, failures, conflicts }, context) => {
    for (const [key, applied] of Object.entries(results))
      if (applied === Object.hasOwn(failures, key))
        context.addIssue({
          code: "custom",
          path: ["failures", key],
          message:
            "Exactly the addresses that were not applied report a reason",
        });
    // Index each destination once so validation stays linear in reply size.
    const contested = conflicts.map((conflict) => ({
      members: new Set(conflict.requested_by),
      reasons:
        conflict.requested_by.length > 1
          ? ["duplicate_requested_name"]
          : conflict.held_by.some(
                (holder) => holder !== conflict.requested_by[0],
              )
            ? [
                "name_held_by_selected_address",
                "name_held_by_unselected_address",
              ]
            : [],
      referenced: new Set<string>(),
    }));
    for (const [key, failure] of Object.entries(failures)) {
      if (!Object.hasOwn(results, key))
        context.addIssue({
          code: "custom",
          path: ["failures", key],
          message: "A failure reason names an address outside the batch result",
        });
      if (failure.conflict === null) continue;
      const conflict = contested[failure.conflict];
      if (
        conflict === undefined ||
        failure.address === null ||
        !conflict.members.has(failure.address) ||
        !conflict.reasons.includes(failure.reason)
      )
        context.addIssue({
          code: "custom",
          path: ["failures", key, "conflict"],
          message: "A conflict reason must match its contested destination",
        });
      else conflict.referenced.add(failure.address);
    }
    contested.forEach(({ members, referenced }, index) => {
      if (referenced.size !== members.size)
        context.addIssue({
          code: "custom",
          path: ["conflicts", index],
          message: "Every requesting address fails with this conflict",
        });
    });
  });
/** A single edit reports one key and only reasons one address can produce. */
const singleAddressNameOutcome = addressNameOutcomes.superRefine(
  ({ results, failures }, context) => {
    if (
      Object.keys(results).length !== 1 ||
      Object.values(failures).some(
        ({ reason }) => !singleAddressNameReasons.has(reason),
      )
    )
      context.addIssue({
        code: "custom",
        message: "A single name edit reports one supported outcome",
      });
  },
);

/** Admit per-request bridge outcomes once before projecting naming results. */
export const parseGhidraAddressNameResult = (
  operation: GhidraNamingOperation,
  value: JsonValue,
  namingRequest: GhidraNamingRequest | null,
): Result<
  { readonly value: JsonValue; readonly rawResult?: JsonValue },
  AnalysisOutputError
> => {
  const parsed = (
    operation === "set_address_name"
      ? singleAddressNameOutcome
      : addressNameOutcomes
  ).safeParse(value);
  if (!parsed.success)
    return err(namingOutputFailure(operation, value, parsed.error));
  const { results, failures, conflicts } = parsed.data;
  // Java returns every original request key, including distinct spellings
  // that resolve to the same address. Canonicalizing here would erase them.
  if (
    namingRequest === null ||
    namingRequest.keys.length === 0 ||
    namingRequest.keys.length !== Object.keys(results).length ||
    namingRequest.keys.some((key) => !Object.hasOwn(results, key))
  )
    return err(namingOutputFailure(operation, value));

  const outcomes = Object.values(results);
  // Booleans answer the caller. Failure facts stay in raw_result without a
  // second copy of those booleans.
  return ok({
    value: operation === "set_address_name" ? outcomes[0]! : results,
    ...(outcomes.every(Boolean) ? {} : { rawResult: { failures, conflicts } }),
  });
};

/** An invalid reply does not establish whether remote database edits occurred. */
const namingOutputFailure = (
  operation: GhidraNamingOperation,
  value: JsonValue,
  cause?: unknown,
): AnalysisOutputError =>
  new AnalysisOutputError(
    operation,
    "Ghidra naming reply did not match the requested naming contract; mutation outcome is unknown",
    {
      cause,
      diagnostics: { bridge_result: value, mutation_outcome: "unknown" },
    },
  );
