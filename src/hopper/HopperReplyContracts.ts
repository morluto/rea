import { z } from "zod";

import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  analysisBookmarkSchema,
  nativeInventoryRowsSchemas,
} from "../domain/native/nativeInventory.js";
import { nativeObservationSourceSchemas } from "../domain/native/nativeObservation.js";
import { err, ok, type Result } from "../domain/result.js";
import type { HOPPER_OPERATIONS } from "./HopperProviderMetadata.js";

type HopperOperation = (typeof HOPPER_OPERATIONS)[number];

const nullableText = z.string().nullable();

/**
 * Bridge reply contracts, keyed by method and built from the shared native
 * domain schemas. A reply is validated once here, before any consumer reads it.
 */
export const hopperReplySchemas = {
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
} as const satisfies Partial<Record<HopperOperation, z.ZodType>>;

/**
 * Operations whose replies still reach Evidence without a client-side reply
 * contract. This list may only shrink: add each operation's contract above and
 * remove it here.
 */
export const HOPPER_OPERATIONS_WITHOUT_REPLY_CONTRACT = Object.freeze([
  "address_to_file_offset",
  "analyze_function",
  "list_segments",
  "procedure_callers",
  "procedure_info",
  "procedure_references",
  "read_bytes",
  "read_function_instructions",
  "resolve_containing_procedure",
] as const satisfies readonly Exclude<
  HopperOperation,
  keyof typeof hopperReplySchemas
>[]);

export type HopperReplyMethod = keyof typeof hopperReplySchemas;
export type HopperReply<M extends HopperReplyMethod> = z.output<
  (typeof hopperReplySchemas)[M]
>;

export const hasHopperReplyContract = (
  method: string,
): method is HopperReplyMethod => Object.hasOwn(hopperReplySchemas, method);

/**
 * Validate one bridge reply against its method's contract. The source value is
 * returned unchanged, so Evidence keeps every reported field; a reply outside
 * the contract is an output failure, never passed through.
 */
export const parseHopperReply = <M extends HopperReplyMethod>(
  method: M,
  value: JsonValue,
  operation: string = method,
): Result<HopperReply<M> & JsonValue, AnalysisOutputError> => {
  const parsed = hopperReplySchemas[method].safeParse(value);
  return parsed.success
    ? // The schemas carry no transforms, so the validated source is the
      // parsed value without the object copy that drops unlisted fields.
      ok(value as HopperReply<M> & JsonValue)
    : err(
        new AnalysisOutputError(
          operation,
          `Hopper bridge output did not match the ${method} contract`,
          { cause: parsed.error },
        ),
      );
};
