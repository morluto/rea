import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import {
  functionBodySchema,
  functionBodyEntryAgrees,
} from "../domain/hopperValues.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

/** Read-only direct inventory operations admitted by the Ghidra adapter. */
export const GHIDRA_INVENTORY_OPERATIONS = [
  "address_name",
  "list_documents",
  "list_names",
  "list_procedures",
  "list_segments",
  "list_strings",
  "procedure_address",
  "resolve_containing_procedure",
  "search_procedures",
  "search_strings",
] as const;

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
const explicitAddress = identifier;
const filteredAddress = explicitAddress.nullable().default(null);
const searchInput = {
  pattern: z.string().min(1),
  mode: z.enum(["literal", "regex"]).default("literal"),
  case_sensitive: z.boolean().default(false),
  document,
};

const inputSchemas = {
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
} satisfies Readonly<Record<GhidraInventoryOperation, z.ZodType>>;

/** Validate and default one provider request before it crosses the socket. */
export const parseGhidraInventoryInput = (
  operation: GhidraInventoryOperation,
  value: Readonly<Record<string, JsonValue>>,
): Result<Readonly<Record<string, JsonValue>>, AnalysisInputError> => {
  const parsed = inputSchemas[operation].safeParse(value);
  if (!parsed.success)
    return err(new AnalysisInputError(operation, { cause: parsed.error }));
  return ok(parsed.data);
};

export const ghidraCanonicalAddressSchema = z
  .string()
  .regex(/^(?:0x[0-9a-f]+|(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+:0x[0-9a-f]+)$/u);
const canonicalAddress = ghidraCanonicalAddressSchema;
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
    thunk_target: canonicalAddress.nullable(),
  })
  .strict();
/** Ghidra FunctionManager classification, independent of body ownership inference. */
export const ghidraFunctionClassificationSchema = procedureFacts
  .extend({ provenance: z.literal("ghidra-function-manager") })
  .strict();
/** Require complete canonical AddressSet evidence on every Ghidra function identity. */
export const ghidraFunctionBodySchema = functionBodySchema.superRefine(
  (body, context) => {
    if (
      !body.available ||
      body.provenance !== "ghidra-function-body-address-set" ||
      body.ranges.some(
        ({ start, end }) =>
          !ghidraCanonicalAddressSchema.safeParse(start).success ||
          !ghidraCanonicalAddressSchema.safeParse(end).success,
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Ghidra omitted complete canonical function-body AddressSet evidence",
      });
  },
);

/** Strict provider identity shared by inventory and function-analysis results. */
export const ghidraProcedureIdentitySchema = z
  .object({
    address: ghidraCanonicalAddressSchema,
    name: z.string().min(1),
    classification: ghidraFunctionClassificationSchema,
    body: ghidraFunctionBodySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !functionBodyEntryAgrees(value.body, value.address) ||
      (value.body.available &&
        !value.classification.external &&
        !value.body.contains_entry)
    )
      context.addIssue({
        code: "custom",
        message: "Ghidra function body disagrees with its entry point",
      });
  });

const stringFacts = z
  .object({
    encoding: z.string().min(1),
    termination: z.enum(["missing", "present_or_not_required"]),
    byte_length: z.number().int().min(0),
  })
  .strict();
const baseItem = {
  address: canonicalAddress,
  value: z.string(),
};
const symbolItem = z.object({ ...baseItem, symbol: symbolFacts }).strict();
const procedureItem = z
  .object({ ...baseItem, procedure: procedureFacts })
  .strict();
const stringItem = z.object({ ...baseItem, string: stringFacts }).strict();
const searchItem = z.object(baseItem).strict();

const availablePermissions = z
  .object({
    available: z.literal(true),
    source: z.literal("ghidra-memory-block"),
  })
  .strict();
const memoryRegion = z
  .object({
    name: z.string(),
    start: canonicalAddress,
    end: canonicalAddress,
    readable: z.boolean(),
    writable: z.boolean(),
    executable: z.boolean(),
    permissions: availablePermissions,
    provenance: z.literal("ghidra-memory-block"),
    address_space: z.string().min(1),
    image_base: canonicalAddress,
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
      query_address: canonicalAddress,
      found: z.literal(true),
      procedure: ghidraProcedureIdentitySchema,
    })
    .strict()
    .superRefine((value, context) => {
      const body = value.procedure.body;
      if (
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
      query_address: canonicalAddress,
      found: z.literal(false),
      procedure: z.null(),
      reason: z.enum(["outside_segments", "not_in_procedure"]),
    })
    .strict(),
]);

const resultSchemas = {
  address_name: z.string().nullable(),
  list_documents: z.array(z.string().min(1)).length(1),
  list_names: z.array(symbolItem),
  list_procedures: z.array(procedureItem),
  list_segments: z.array(segment),
  list_strings: z.array(stringItem),
  procedure_address: canonicalAddress,
  resolve_containing_procedure: containingProcedure,
  search_procedures: z.array(searchItem),
  search_strings: z.array(searchItem),
} satisfies Readonly<Record<GhidraInventoryOperation, z.ZodType>>;

/** Validate exact Java-bridge output before creating Evidence. */
export const parseGhidraInventoryResult = (
  operation: GhidraInventoryOperation,
  value: JsonValue,
): Result<JsonValue, AnalysisOutputError> => {
  const parsed = resultSchemas[operation].safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new AnalysisOutputError(
          operation,
          "Ghidra bridge output did not match the inventory contract",
          { cause: parsed.error },
        ),
      );
};
