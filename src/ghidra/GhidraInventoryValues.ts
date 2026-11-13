import {
  type GhidraNamingRequest,
  parseGhidraAddressNameResult,
} from "./GhidraAddressNameValues.js";
import { GHIDRA_INVENTORY_OPERATIONS } from "./GhidraInventoryOperations.js";
import { nativeSearchFields } from "../domain/native/nativeSearch.js";
import { nativeSymbolMetadataSchema } from "../domain/native/nativeSymbol.js";
import { nativeAddressObservationSchema } from "../domain/native/nativeAddress.js";
import { nativeByteReadSchema } from "../domain/native/nativeByteRead.js";
import { z } from "zod";
import { jsonRecordSchema } from "../domain/jsonRecord.js";
import {
  MAX_BYTE_SEARCH_MATCHES,
  bytePatternFields,
  validateBytePattern,
  byteSearchResultSchema,
} from "../domain/native/bytePattern.js";
import {
  normalizeNativeLoadImageObservation,
  nativeLoadImageObservationSchema,
  type NativeLoadImageObservation,
} from "../domain/native/nativeLoadImage.js";

import {
  type AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { projectBinaryOverview } from "../domain/native/nativeSegments.js";
import {
  availableFunctionBodySchema,
  functionBodyEntryAgrees,
} from "../domain/native/functionBody.js";
import { procedureIdentitySchema } from "../domain/native/procedureInfo.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";

/** Inventory operations that write analyst names into the session database. */
export const GHIDRA_NAMING_OPERATIONS = [
  "set_address_name",
  "set_addresses_names",
] as const satisfies readonly GhidraInventoryOperation[];

type GhidraNamingOperation = (typeof GHIDRA_NAMING_OPERATIONS)[number];

/** One direct inventory operation implemented by the packaged Java bridge. */
export type GhidraInventoryOperation =
  (typeof GHIDRA_INVENTORY_OPERATIONS)[number];

const operationSet: ReadonlySet<string> = new Set(GHIDRA_INVENTORY_OPERATIONS);

/** Narrow an application operation to the Ghidra inventory surface. */
export const isGhidraInventoryOperation = (
  operation: string,
): operation is GhidraInventoryOperation => operationSet.has(operation);

export const ghidraIdentifierSchema = z.string().min(1);
const identifier = ghidraIdentifierSchema;
const document = identifier.nullable().default(null);
/** Caller address spelling; the bridge resolves its space and emits canonical output. */
export const ghidraInputAddressSchema = z
  .string()
  .regex(
    /^(?:(?:0[xX])?[0-9a-fA-F]+|(?:[A-Za-z0-9._~-]|%[0-9a-fA-F]{2})+:0[xX][0-9a-fA-F]+)$/u,
    "Use hexadecimal digits, optionally prefixed with 0x, or an encoded address-space name followed by :0x and hexadecimal digits",
  );
const explicitAddress = ghidraInputAddressSchema;
const filteredAddress = explicitAddress.nullable().default(null);
const searchInput = {
  ...nativeSearchFields,
  document,
};

const inputSchemas = {
  read_binary_inventory_summary: z.strictObject({}),
  search_bytes: z
    .strictObject({
      ...bytePatternFields,
      document,
      start: explicitAddress.optional(),
      end: explicitAddress.optional(),
      limit: z.int().min(1).max(MAX_BYTE_SEARCH_MATCHES).default(100),
      cursor: z.string().min(1).optional(),
    })
    .superRefine(validateBytePattern),
  inspect_native_load_image: z.strictObject({}),
  read_bytes: z.strictObject({
    document,
    address: explicitAddress,
    length: z.int().min(1).max(Number.MAX_SAFE_INTEGER).default(256),
  }),
  address_to_file_offset: z.strictObject({
    document,
    address: explicitAddress,
  }),
  address_name: z.object({ document, address: explicitAddress }).strict(),
  list_documents: z.object({}).strict(),
  list_names: z.object({ document, address: filteredAddress }).strict(),
  list_procedures: z.object({ document }).strict(),
  list_segments: z.object({ document }).strict(),
  list_strings: z.object({ document, address: filteredAddress }).strict(),
  procedure_address: z.object({ document, procedure: identifier }).strict(),
  resolve_containing_procedure: z
    .object({ document, address: explicitAddress })
    .strict(),
  search_procedures: z.object(searchInput).strict(),
  search_strings: z.object(searchInput).strict(),
  set_address_name: z
    .object({ document, address: explicitAddress, name: z.string().min(1) })
    .strict(),
  set_addresses_names: z
    .object({
      document,
      names: jsonRecordSchema(z.string().min(1), explicitAddress),
    })
    .strict()
    .refine(
      (value) => Object.keys(value.names).length > 0,
      "Supply at least one address name",
    ),
} satisfies Readonly<Record<GhidraInventoryOperation, z.ZodType>>;

/** Parsed naming identity accompanies wire parameters without crossing the socket. */
type GhidraInventoryInputAdmission =
  | {
      readonly ok: true;
      readonly value: Readonly<Record<string, JsonValue>>;
      readonly namingRequest: GhidraNamingRequest | null;
    }
  | { readonly ok: false; readonly error: AnalysisInputError };

/** Validate and default one provider request before it crosses the socket. */
export const parseGhidraInventoryInput = (
  operation: GhidraInventoryOperation,
  value: Readonly<Record<string, JsonValue>>,
): GhidraInventoryInputAdmission => {
  const failure = (
    issues: readonly z.core.$ZodIssue[],
    cause: unknown,
  ): Extract<GhidraInventoryInputAdmission, { readonly ok: false }> => ({
    ok: false,
    error: analysisInputErrorFromIssues(operation, issues, value, { cause }),
  });

  if (operation === "set_address_name") {
    const parsed = inputSchemas.set_address_name.safeParse(value);
    return parsed.success
      ? {
          ok: true,
          value: parsed.data,
          namingRequest: { keys: [parsed.data.address] },
        }
      : failure(parsed.error.issues, parsed.error);
  }
  if (operation === "set_addresses_names") {
    const parsed = inputSchemas.set_addresses_names.safeParse(value);
    return parsed.success
      ? {
          ok: true,
          value: parsed.data,
          namingRequest: { keys: Object.keys(parsed.data.names) },
        }
      : failure(parsed.error.issues, parsed.error);
  }
  const parsed = inputSchemas[operation].safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data, namingRequest: null }
    : failure(parsed.error.issues, parsed.error);
};

const symbolFacts = z
  .object({
    primary: z.boolean(),
    dynamic: z.boolean(),
    external: z.boolean(),
    type: z.string().min(1),
    source: z.enum(["default", "analysis", "ai", "imported", "user_defined"]),
  })
  .strict();
const procedureFacts = z
  .object({
    external: z.boolean(),
    thunk: z.boolean(),
    thunk_target: nativeAddressObservationSchema.nullable(),
  })
  .strict();
/** Ghidra FunctionManager classification, independent of body ownership inference. */
export const ghidraFunctionClassificationSchema = procedureFacts
  .extend({ provenance: z.literal("ghidra-function-manager") })
  .strict();
/** Require complete canonical AddressSet evidence on every Ghidra function identity. */
export const ghidraFunctionBodySchema = availableFunctionBodySchema.safeExtend({
  provenance: z.literal("ghidra-function-body-address-set"),
  ranges: z.array(
    availableFunctionBodySchema.shape.ranges.element.extend({
      start: nativeAddressObservationSchema,
      end: nativeAddressObservationSchema,
    }),
  ),
});

/** Canonical Ghidra identity, retaining the generic dossier's name and symbol admission. */
export const ghidraFunctionIdentitySchema = procedureIdentitySchema
  .safeExtend({
    address: nativeAddressObservationSchema,
    classification: ghidraFunctionClassificationSchema,
    body: ghidraFunctionBodySchema,
  })
  .superRefine((value, context) => {
    if (!value.classification.external && !value.body.contains_entry)
      context.addIssue({
        code: "custom",
        message: "Ghidra function body disagrees with its entry point",
      });
  });

/** Inventory identities require a nonempty name and an explicit symbol observation. */
export const ghidraProcedureIdentitySchema =
  ghidraFunctionIdentitySchema.safeExtend({
    name: z.string().min(1),
    symbol: nativeSymbolMetadataSchema.nullable(),
  });

const stringFacts = z
  .object({
    encoding: z.string().min(1),
    termination: z.enum(["missing", "present_or_not_required"]),
    byte_length: z.int().min(0),
  })
  .strict();
const baseItem = {
  address: nativeAddressObservationSchema,
  value: z.string(),
};
const symbolItem = z.object({ ...baseItem, symbol: symbolFacts }).strict();
const addressedItem = z
  .object({ ...baseItem, symbol: symbolFacts.exactOptional() })
  .strict();
const procedureItem = addressedItem.extend({ procedure: procedureFacts });
/** Other symbols at the exact entry that matched; value stays the primary name. */
const procedureMatchItem = procedureItem.extend({
  matched_aliases: z.array(z.string().min(1)).min(1).exactOptional(),
});
const stringItem = z.object({ ...baseItem, string: stringFacts }).strict();

const availablePermissions = z
  .object({
    available: z.literal(true),
    source: z.literal("ghidra-memory-block"),
  })
  .strict();
const memoryRegion = z
  .object({
    name: z.string(),
    start: nativeAddressObservationSchema,
    end: nativeAddressObservationSchema,
    readable: z.boolean(),
    writable: z.boolean(),
    executable: z.boolean(),
    permissions: availablePermissions,
    provenance: z.literal("ghidra-memory-block"),
    address_space: z.string().min(1),
    image_base: nativeAddressObservationSchema,
    initialized: z.boolean(),
    overlay: z.boolean(),
  })
  .strict();
const segment = memoryRegion
  .extend({ sections: z.array(memoryRegion) })
  .strict();
const containingProcedure = z.discriminatedUnion("found", [
  z
    .object({
      query_address: nativeAddressObservationSchema,
      found: z.literal(true),
      procedure: ghidraProcedureIdentitySchema,
    })
    .strict()
    .superRefine((value, context) => {
      const body = value.procedure.body;
      const exactExternalEntry =
        value.procedure.classification.external &&
        value.query_address === value.procedure.address;
      if (
        !exactExternalEntry &&
        body.available &&
        !functionBodyEntryAgrees(
          { ...body, contains_entry: true },
          value.query_address,
        )
      )
        context.addIssue({
          code: "custom",
          message:
            "Found containing procedure body does not contain the query address",
        });
    }),
  z
    .object({
      query_address: nativeAddressObservationSchema,
      found: z.literal(false),
      procedure: z.null(),
      reason: z.enum(["outside_segments", "not_in_procedure"]),
    })
    .strict(),
]);

const byteMatch = byteSearchResultSchema.shape.matches.element;
const canonicalByteMatch = byteMatch.safeExtend({
  address: nativeAddressObservationSchema,
  procedure: byteMatch.shape.procedure
    .unwrap()
    .safeExtend({ address: nativeAddressObservationSchema })
    .nullable(),
});
const byteCoverage = byteSearchResultSchema.shape.searched.shape;
const canonicalByteCoverage = byteCoverage.blocks.element.safeExtend({
  start: nativeAddressObservationSchema,
  end: nativeAddressObservationSchema,
});

const resultSchemas = {
  read_binary_inventory_summary: z
    .strictObject({
      document: identifier,
      segments: z.array(segment),
      procedure_count: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
      string_count: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .transform(projectBinaryOverview),
  search_bytes: byteSearchResultSchema.safeExtend({
    matches: z.array(canonicalByteMatch).max(MAX_BYTE_SEARCH_MATCHES),
    searched: byteSearchResultSchema.shape.searched.safeExtend({
      blocks: z.array(canonicalByteCoverage),
      skipped_uninitialized: z.array(canonicalByteCoverage),
      skipped_not_loaded: z.array(canonicalByteCoverage),
      skipped_overlays: z.array(canonicalByteCoverage),
    }),
  }),
  inspect_native_load_image: nativeLoadImageObservationSchema,
  read_bytes: nativeByteReadSchema
    .safeExtend({ address: nativeAddressObservationSchema })
    .strict(),
  address_to_file_offset: z.strictObject({
    address: nativeAddressObservationSchema,
    file_offset: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
  address_name: z.string().nullable(),
  list_documents: z.array(z.string().min(1)).length(1),
  list_names: z.array(symbolItem),
  list_procedures: z.array(procedureItem),
  list_segments: z.array(segment),
  list_strings: z.array(stringItem),
  procedure_address: nativeAddressObservationSchema,
  resolve_containing_procedure: containingProcedure,
  search_procedures: z.array(procedureMatchItem),
  search_strings: z.array(stringItem),
} satisfies Readonly<
  Record<Exclude<GhidraInventoryOperation, GhidraNamingOperation>, z.ZodType>
>;

/** The format owner retains raw output only when projection omits reported facts. */
export interface ParsedGhidraInventoryResult<Value = JsonValue> {
  readonly value: Value;
  readonly rawResult?: JsonValue;
}

/** Validate exact Java-bridge output and own its Evidence representation. */
export function parseGhidraInventoryResult(
  operation: "inspect_native_load_image",
  value: JsonValue,
  namingRequest: GhidraNamingRequest | null,
): Result<
  ParsedGhidraInventoryResult<NativeLoadImageObservation>,
  AnalysisOutputError
>;
export function parseGhidraInventoryResult(
  operation: GhidraInventoryOperation,
  value: JsonValue,
  namingRequest: GhidraNamingRequest | null,
): Result<ParsedGhidraInventoryResult, AnalysisOutputError>;
export function parseGhidraInventoryResult(
  operation: GhidraInventoryOperation,
  value: JsonValue,
  namingRequest: GhidraNamingRequest | null,
): Result<
  ParsedGhidraInventoryResult<JsonValue | NativeLoadImageObservation>,
  AnalysisOutputError
> {
  if (operation === "inspect_native_load_image") {
    const parsed = resultSchemas.inspect_native_load_image.safeParse(value);
    return parsed.success
      ? ok({ value: normalizeNativeLoadImageObservation(parsed.data) })
      : err(inventoryOutputFailure(operation, parsed.error));
  }
  if (operation === "set_address_name" || operation === "set_addresses_names") {
    return parseGhidraAddressNameResult(operation, value, namingRequest);
  }
  const parsed = resultSchemas[operation].safeParse(value);
  return parsed.success
    ? ok({
        value: jsonValueSchema.parse(parsed.data),
        // The overview omits detailed segment permissions, sections and provenance.
        // Load-image observations above undergo separate local attestation.
        ...(operation === "read_binary_inventory_summary"
          ? { rawResult: value }
          : {}),
      })
    : err(inventoryOutputFailure(operation, parsed.error));
}

const inventoryOutputFailure = (
  operation: GhidraInventoryOperation,
  cause: unknown,
): AnalysisOutputError =>
  new AnalysisOutputError(
    operation,
    "Ghidra bridge output did not match the inventory contract",
    { cause },
  );
