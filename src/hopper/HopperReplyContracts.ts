import { z } from "zod";

import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  analysisBookmarkSchema,
  nativeInventoryRowsSchemas,
} from "../domain/native/nativeInventory.js";
import { nativeObservationSourceSchemas } from "../domain/native/nativeObservation.js";
import { nativeByteReadSchema } from "../domain/native/nativeByteRead.js";
import { nativeCallClassificationSchema } from "../domain/native/nativeCallReference.js";
import {
  functionDossierSchema,
  functionInstructionWindowSchema,
} from "../domain/native/functionDossier.js";
import {
  referenceEdgeSchema,
  unresolvedCallSchema,
} from "../domain/native/nativeReference.js";
import { outputContractDiagnostics } from "../domain/native/nativeProviderOutput.js";
import { nativeSegmentListSchema } from "../domain/native/nativeSegments.js";
import {
  procedureIdentitySchema,
  procedureInfoSchema,
} from "../domain/native/procedureInfo.js";
import { err, ok, type Result } from "../domain/result.js";
import { HOPPER_OPERATIONS } from "./HopperProviderMetadata.js";

/** Every operation the provider dispatches to the bridge, including `health`. */
export type HopperOperation = (typeof HOPPER_OPERATIONS)[number] | "health";

const hopperOperations: ReadonlySet<string> = new Set([
  ...HOPPER_OPERATIONS,
  "health",
]);

/** Whether Hopper serves this operation. */
export const isHopperOperation = (
  operation: string,
): operation is HopperOperation => hopperOperations.has(operation);

/** The bridge method that serves an analyst operation. */
export const hopperBridgeMethod = (
  operation: HopperOperation,
): HopperReplyMethod =>
  operation === "procedure_callers" ? "rea_caller_base" : operation;

/** Every bridge method whose reply REA reads. */
type HopperBridgeMethod =
  | Exclude<HopperOperation, "procedure_callers">
  | "rea_caller_base"
  | "rea_caller_scan_page"
  | "rea_caller_scan_target";

const nullableText = z.string().nullable();

/** The native file mapping before REA binds it to the admitted source bytes. */
const fileOffsetObservationSchema = z.strictObject({
  address: z.string().regex(/^0x[0-9a-f]+$/u),
  provider_file_offset: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  provider_source_path: z.string().nullable(),
  provider_image_header_hex: z
    .string()
    .regex(/^[a-f0-9]{24}$/u)
    .nullable(),
});
const compactEdgeSchema = z.strictObject({
  source_address: z.string(),
  target_address: z.string(),
  source_procedure: z.union([
    z.literal("caller"),
    procedureIdentitySchema,
    z.null(),
  ]),
  target_procedure: z.string(),
  call: nativeCallClassificationSchema,
});
const callerScanTargetSchema = z.strictObject({
  target: procedureIdentitySchema,
  instructions: z.array(z.string()),
  instructions_complete: z.boolean(),
});

/**
 * Bridge reply contracts, keyed by method and built from the shared native
 * domain schemas. A reply is validated once here, before any consumer reads it.
 */
export const hopperReplySchemas = {
  // The startup handshake also authenticates run_id (parseHopperServerInfo).
  health: z.looseObject({
    name: z.literal("REA Hopper bridge"),
    version: z.string(),
    process_id: z.int().positive().max(Number.MAX_SAFE_INTEGER),
    run_id: z.string(),
    max_request_bytes: z
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
  }),
  address_name: nullableText,
  comment: nullableText,
  inline_comment: nullableText,
  current_address: z.string(),
  current_document: z.string(),
  current_procedure: z.string(),
  goto_address: z.string(),
  next_address: z.string(),
  prev_address: z.string(),
  list_bookmarks: z.array(analysisBookmarkSchema),
  list_documents: z.array(z.string()),
  procedure_address: nativeObservationSourceSchemas.procedure_address,
  procedure_assembly: z.string(),
  procedure_callees: nativeObservationSourceSchemas.procedure_callees,
  procedure_pseudo_code: nullableText,
  xrefs: nativeObservationSourceSchemas.xrefs,
  set_address_name: z.boolean(),
  set_addresses_names: z.record(z.string(), z.boolean()),
  set_bookmark: z.boolean(),
  set_comment: z.boolean(),
  set_inline_comment: z.boolean(),
  unset_bookmark: z.boolean(),
  list_names: nativeInventoryRowsSchemas.names,
  list_procedures: nativeInventoryRowsSchemas.names,
  search_procedures: nativeInventoryRowsSchemas.names,
  list_strings: nativeInventoryRowsSchemas.strings,
  search_strings: nativeInventoryRowsSchemas.strings,
  list_segments: nativeSegmentListSchema,
  procedure_info: procedureInfoSchema,
  read_bytes: nativeByteReadSchema,
  read_function_instructions: functionInstructionWindowSchema,
  resolve_containing_procedure:
    nativeObservationSourceSchemas.resolve_containing_procedure,
  address_to_file_offset: fileOffsetObservationSchema,
  analyze_function: functionDossierSchema,
  procedure_references: z.strictObject({
    procedure: procedureIdentitySchema,
    direction: z.enum(["incoming", "outgoing"]),
    reference_kinds_available: z.boolean(),
    unresolved_calls: z.array(unresolvedCallSchema),
    references: z.array(referenceEdgeSchema),
  }),
  // REA-private bridge methods behind procedure_callers reconciliation.
  rea_caller_base: callerScanTargetSchema.extend({
    callers: z.array(z.string()),
    callers_complete: z.boolean(),
  }),
  rea_caller_scan_target: callerScanTargetSchema,
  rea_caller_scan_page: z.strictObject({
    start: z.int().nonnegative(),
    next: z.int().nonnegative(),
    total: z.int().nonnegative(),
    oversized: z.boolean(),
    items: z.array(
      z.strictObject({
        caller: procedureIdentitySchema,
        callees: z.array(z.string()),
        references: z.array(compactEdgeSchema),
      }),
    ),
  }),
} as const satisfies Record<HopperBridgeMethod, z.ZodType>;

/** The production table's type; `HopperClient` defaults to it. */
export type HopperBridgeReplyContracts = typeof hopperReplySchemas;
export type HopperReplyMethod = keyof HopperBridgeReplyContracts;
export type HopperReply<M extends HopperReplyMethod> = z.output<
  (typeof hopperReplySchemas)[M]
>;

/**
 * A validated reply as JSON. `parseHopperReply` returns the bridge's decoded
 * JSON value unchanged, so every reply is a `JsonValue`; zod's output types
 * only spell optional members in a way `JsonValue` does not.
 */
export const hopperReplyJson = (
  reply: HopperReply<HopperReplyMethod> | JsonValue,
): JsonValue => reply as JsonValue;

/** A method-keyed reply contract table, such as `hopperReplySchemas`. */
export type HopperReplyContracts = Readonly<Record<string, z.ZodType>>;

/**
 * A table whose contracts validate a reply without changing it: each
 * schema's input type is its output type. `parseHopperReply` returns the raw
 * reply, so a coercion, default or transform would promise a type the reply
 * does not have; such a schema fails to type-check here.
 */
export type ValueKeepingContracts<Contracts extends HopperReplyContracts> = {
  readonly [M in keyof Contracts]: [z.input<Contracts[M]>] extends [
    z.output<Contracts[M]>,
  ]
    ? Contracts[M]
    : never;
};

/** The production table, checked to keep every reply value unchanged. */
export const hopperBridgeReplyContracts: ValueKeepingContracts<HopperBridgeReplyContracts> =
  hopperReplySchemas;

/** The validated reply a contract table assigns to one method. */
export type HopperContractReply<
  Contracts extends HopperReplyContracts,
  M extends keyof Contracts,
> = z.output<Contracts[M]>;

/**
 * A bridge reply outside its method's contract. `reply` is the reply exactly
 * as the bridge sent it, kept as partial evidence for callers that retain it.
 */
export class HopperReplyContractError extends AnalysisOutputError {
  constructor(
    operation: string,
    readonly method: string,
    readonly reply: JsonValue,
    cause: z.ZodError,
  ) {
    super(
      operation,
      `Hopper bridge output did not match the ${method} contract`,
      {
        cause,
        diagnostics: outputContractDiagnostics(cause, reply),
      },
    );
  }
}

/**
 * Validate one bridge reply against its method's contract. The source value is
 * returned unchanged, so Evidence keeps every reported field; a reply outside
 * the contract is an output failure, never passed through. Only the client
 * calls this; every consumer receives the typed reply.
 */
export const parseHopperReply = <
  Contracts extends HopperReplyContracts,
  M extends keyof Contracts & string,
>(
  contracts: Contracts & ValueKeepingContracts<Contracts>,
  method: M,
  value: JsonValue,
  operation: string,
): Result<HopperContractReply<Contracts, M>, HopperReplyContractError> => {
  const parsed = contracts[method]!.safeParse(value);
  return parsed.success
    ? // The schemas carry no transforms, so the validated source is the
      // parsed value without the object copy that drops unlisted fields.
      ok(value as HopperContractReply<Contracts, M>)
    : err(new HopperReplyContractError(operation, method, value, parsed.error));
};
