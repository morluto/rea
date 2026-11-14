import type { z } from "zod";

import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { nativeInventoryRowsSchemas } from "../domain/native/nativeInventory.js";
import { err, ok, type Result } from "../domain/result.js";
import type { HOPPER_OPERATIONS } from "./HopperProviderMetadata.js";

type HopperOperation = (typeof HOPPER_OPERATIONS)[number];

/**
 * Bridge reply contracts, keyed by method and built from the shared native
 * domain schemas. A reply is validated once here, before any consumer reads it.
 */
export const hopperReplySchemas = {
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
  "address_name",
  "address_to_file_offset",
  "analyze_function",
  "comment",
  "current_address",
  "current_document",
  "current_procedure",
  "goto_address",
  "inline_comment",
  "list_bookmarks",
  "list_documents",
  "list_segments",
  "next_address",
  "prev_address",
  "procedure_address",
  "procedure_assembly",
  "procedure_callees",
  "procedure_callers",
  "procedure_info",
  "procedure_pseudo_code",
  "procedure_references",
  "read_bytes",
  "read_function_instructions",
  "resolve_containing_procedure",
  "set_address_name",
  "set_addresses_names",
  "set_bookmark",
  "set_comment",
  "set_inline_comment",
  "unset_bookmark",
  "xrefs",
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
