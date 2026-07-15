import { z } from "zod";

import { AnalysisInputError, AnalysisOutputError } from "../domain/errors.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";

/** Read-only direct operations admitted by the Ghidra v1 adapter. */
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

const boundedIdentifier = z.string().min(1).max(4096);
const document = boundedIdentifier.nullable().default(null);
const explicitAddress = boundedIdentifier;
const filteredAddress = explicitAddress.nullable().default(null);
const pagination = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
};
const searchInput = {
  pattern: z.string().min(1).max(256),
  mode: z.enum(["literal", "regex"]).default("literal"),
  case_sensitive: z.boolean().default(false),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(100),
  document,
};

const inputSchemas = {
  address_name: z.object({ document, address: explicitAddress }).strict(),
  list_documents: z.object({}).strict(),
  list_names: z
    .object({ document, address: filteredAddress, ...pagination })
    .strict(),
  list_procedures: z.object({ document, ...pagination }).strict(),
  list_segments: z.object({ document }).strict(),
  list_strings: z
    .object({ document, address: filteredAddress, ...pagination })
    .strict(),
  procedure_address: z
    .object({ document, procedure: boundedIdentifier })
    .strict(),
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
  return ok(jsonObjectSchema.parse(parsed.data));
};

const canonicalAddress = z
  .string()
  .regex(/^(?:0x[0-9a-f]+|(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})+:0x[0-9a-f]+)$/u);
const valueTruncation = { value_truncated: z.boolean() };
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
  ...valueTruncation,
};
const symbolItem = z.object({ ...baseItem, symbol: symbolFacts }).strict();
const procedureItem = z
  .object({ ...baseItem, procedure: procedureFacts })
  .strict();
const stringItem = z.object({ ...baseItem, string: stringFacts }).strict();
const searchItem = z.object(baseItem).strict();

const pageSchema = <Item extends z.ZodType>(item: Item, maximumLimit: number) =>
  z
    .object({
      items: z.array(item),
      offset: z.number().int().min(0),
      limit: z.number().int().min(1).max(maximumLimit),
      total: z.number().int().min(0),
      next_offset: z.number().int().min(0).nullable(),
      has_more: z.boolean(),
    })
    .strict()
    .superRefine((page, context) => {
      const next = page.offset + page.items.length;
      const hasMore = next < page.total;
      if (page.items.length > page.limit)
        context.addIssue({
          code: "custom",
          path: ["items"],
          message: "page exceeds its declared limit",
        });
      if (page.items.length > 0 && next > page.total)
        context.addIssue({
          code: "custom",
          path: ["total"],
          message: "page items exceed its exact total",
        });
      if (hasMore && page.items.length === 0)
        context.addIssue({
          code: "custom",
          path: ["items"],
          message: "page continuation must advance its offset",
        });
      if (page.has_more !== hasMore)
        context.addIssue({
          code: "custom",
          path: ["has_more"],
          message: "page continuation does not match its exact total",
        });
      if (page.next_offset !== (hasMore ? next : null))
        context.addIssue({
          code: "custom",
          path: ["next_offset"],
          message: "page continuation offset is inconsistent",
        });
    });

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
      procedure: z
        .object({ address: canonicalAddress, name: z.string().min(1) })
        .strict(),
    })
    .strict(),
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
  list_names: pageSchema(symbolItem, 500),
  list_procedures: pageSchema(procedureItem, 500),
  list_segments: z.array(segment),
  list_strings: pageSchema(stringItem, 500),
  procedure_address: canonicalAddress,
  resolve_containing_procedure: containingProcedure,
  search_procedures: pageSchema(searchItem, 100),
  search_strings: pageSchema(searchItem, 100),
} satisfies Readonly<Record<GhidraInventoryOperation, z.ZodType>>;

/** Require exact, bounded Java-bridge output before creating Evidence. */
export const parseGhidraInventoryResult = (
  operation: GhidraInventoryOperation,
  value: JsonValue,
): Result<JsonValue, AnalysisOutputError> => {
  const parsed = resultSchemas[operation].safeParse(value);
  return parsed.success
    ? ok(jsonValueSchema.parse(parsed.data))
    : err(
        new AnalysisOutputError(
          operation,
          "Ghidra bridge output did not match the inventory contract",
          { cause: parsed.error },
        ),
      );
};
