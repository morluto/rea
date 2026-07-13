import { z } from "zod";

import type { JsonValue } from "./jsonValue.js";
import { AnalysisOutputError, HopperProtocolError } from "./errors.js";
import { err, ok, type Result } from "./result.js";

export interface AddressedName {
  readonly address: string;
  readonly name: string;
}

export interface SegmentSummary {
  readonly name: string;
  readonly start: string;
  readonly end: string;
  readonly readable: boolean | null;
  readonly writable: boolean | null;
  readonly executable: boolean | null;
}

export interface AddressedPage {
  readonly items: readonly AddressedName[];
  readonly nextOffset: number | null;
  readonly hasMore: boolean;
}

const procedureMapSchema = z.record(z.string(), z.string());
const addressedNamesSchema = z.array(
  z.object({ address: z.string(), name: z.string() }),
);
const addressedNameMapSchema = z.record(z.string(), z.string());
const segmentSchema = z.object({
  name: z.string().default(""),
  start: z.string().default(""),
  end: z.string().default(""),
  readable: z.boolean().nullable().default(null),
  writable: z.boolean().nullable().default(null),
  executable: z.boolean().nullable().default(null),
});
const addressedPageSchema = z
  .object({
    items: z.array(z.object({ address: z.string(), value: z.string() })),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1),
    total: z.number().int().min(0),
    next_offset: z.number().int().min(0).nullable(),
    has_more: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.has_more && value.next_offset === null) {
      context.addIssue({
        code: "custom",
        message: "a page with more results must provide next_offset",
        path: ["next_offset"],
      });
    }
    if (!value.has_more && value.next_offset !== null) {
      context.addIssue({
        code: "custom",
        message: "a complete page must not provide next_offset",
        path: ["next_offset"],
      });
    }
  });
const unavailableSchema = z
  .object({ available: z.literal(false), reason: z.string() })
  .strict();
const procedureIdentitySchema = z
  .object({ address: z.string(), name: z.string() })
  .strict();
const localVariableSchema = z
  .object({
    description: z.string(),
    provenance: z.literal("hopper-public-python-api"),
  })
  .strict();
const boundedSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({
      items: z.array(item),
      total: z.number().int().min(0).nullable(),
      returned: z.number().int().min(0),
      truncated: z.boolean(),
      next_offset: z.number().int().min(0).nullable(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.returned !== value.items.length) {
        context.addIssue({
          code: "custom",
          message: "returned must equal the number of items",
          path: ["returned"],
        });
      }
      if (value.total !== null && value.total < value.returned) {
        context.addIssue({
          code: "custom",
          message: "total cannot be smaller than returned",
          path: ["total"],
        });
      }
      if (value.next_offset !== null && !value.truncated) {
        context.addIssue({
          code: "custom",
          message: "a continuation requires truncated output",
          path: ["next_offset"],
        });
      }
    });
const referenceEdgeSchema = z
  .object({
    source_address: z.string(),
    target_address: z.string(),
    source_procedure: procedureIdentitySchema.nullable(),
    target_procedure: procedureIdentitySchema.nullable(),
    kind: unavailableSchema,
  })
  .strict();
export const functionDossierSchema = z
  .object({
    procedure: z
      .object({
        address: z.string(),
        name: z.string(),
        signature: z.string().nullable(),
        locals: z.array(localVariableSchema),
      })
      .strict(),
    pseudocode: z
      .object({
        text: z.string(),
        total_chars: z.number().int().min(0),
        returned_chars: z.number().int().min(0),
        truncated: z.boolean(),
        next_offset: z.number().int().min(0).nullable(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.returned_chars !== [...value.text].length) {
          context.addIssue({
            code: "custom",
            message: "returned_chars must equal the text length",
            path: ["returned_chars"],
          });
        }
        if (value.total_chars < value.returned_chars) {
          context.addIssue({
            code: "custom",
            message: "total_chars cannot be smaller than returned_chars",
            path: ["total_chars"],
          });
        }
        if (value.next_offset !== null && !value.truncated) {
          context.addIssue({
            code: "custom",
            message: "a continuation requires truncated pseudocode",
            path: ["next_offset"],
          });
        }
      }),
    assembly: boundedSchema(z.string()),
    comments: boundedSchema(
      z
        .object({
          address: z.string(),
          kind: z.enum(["comment", "inline"]),
          text: z.string(),
        })
        .strict(),
    ),
    callers: boundedSchema(procedureIdentitySchema),
    callees: boundedSchema(procedureIdentitySchema),
    incoming_references: boundedSchema(referenceEdgeSchema),
    outgoing_references: boundedSchema(referenceEdgeSchema),
    referenced_strings: boundedSchema(
      z
        .object({
          address: z.string(),
          value: z.string(),
          source_address: z.string(),
        })
        .strict(),
    ),
    referenced_names: boundedSchema(
      z
        .object({
          address: z.string(),
          value: z.string(),
          source_address: z.string(),
        })
        .strict(),
    ),
    basic_blocks: boundedSchema(
      z
        .object({
          start: z.string(),
          end: z.string(),
          successors: z.array(z.string()),
        })
        .strict(),
    ),
    instruction_scan: z
      .object({ scanned: z.number().int().min(0), truncated: z.boolean() })
      .strict(),
  })
  .strict();

/** Strict analyzed-function dossier shared by provider and comparison boundaries. */
export type FunctionDossier = z.infer<typeof functionDossierSchema>;

/** Strictly parse a complete Hopper function dossier at the provider boundary. */
export const parseFunctionDossier = (
  value: JsonValue,
): Result<JsonValue, AnalysisOutputError> => {
  const parsed = functionDossierSchema.safeParse(value);
  return parsed.success
    ? ok(parsed.data)
    : err(
        new AnalysisOutputError(
          "analyze_function",
          "provider output did not match the dossier contract",
          { cause: parsed.error },
        ),
      );
};

/** Parse page entries and continuation metadata returned by list operations. */
export const parseAddressedPage = (
  value: JsonValue,
): Result<AddressedPage, HopperProtocolError> => {
  const parsed = addressedPageSchema.safeParse(value);
  return parsed.success
    ? ok({
        items: parsed.data.items.map(({ address, value: name }) => ({
          address,
          name,
        })),
        nextOffset: parsed.data.next_offset,
        hasMore: parsed.data.has_more,
      })
    : invalid("addressed page", parsed.error);
};

/** Parse Hopper's direct or wrapped procedure map into stable entries. */
export const parseProcedures = (
  value: JsonValue,
): Result<readonly AddressedName[], HopperProtocolError> => {
  const page = parseAddressedPage(value);
  if (page.ok) return ok(page.value.items);
  const parsed = procedureMapSchema.safeParse(
    unwrapProperty(value, "procedures"),
  );
  return parsed.success
    ? ok(
        Object.entries(parsed.data).map(([address, name]) => ({
          address,
          name,
        })),
      )
    : page;
};

/** Parse Hopper's direct or wrapped list of address/name records. */
export const parseNames = (
  value: JsonValue,
): Result<readonly AddressedName[], HopperProtocolError> => {
  const unwrapped = unwrapProperty(value, "names");
  const page = z
    .object({
      items: z.array(z.object({ address: z.string(), value: z.string() })),
    })
    .safeParse(unwrapped);
  if (page.success)
    return ok(
      page.data.items.map(({ address, value: name }) => ({ address, name })),
    );
  const records = addressedNamesSchema.safeParse(unwrapped);
  if (records.success) return ok(records.data);
  const map = addressedNameMapSchema.safeParse(unwrapped);
  return map.success
    ? ok(Object.entries(map.data).map(([address, name]) => ({ address, name })))
    : invalid("name list", map.error);
};

/** Parse callee/caller strings from direct or wrapped Hopper results. */
export const parseRelatedAddresses = (
  value: JsonValue,
  relation: "callees" | "callers",
): Result<readonly string[], HopperProtocolError> => {
  const parsed = z.array(z.string()).safeParse(unwrapProperty(value, relation));
  return parsed.success
    ? ok(parsed.data)
    : invalid(`${relation} list`, parsed.error);
};

/** Parse direct or wrapped Hopper segment records. */
export const parseSegments = (
  value: JsonValue,
): Result<readonly SegmentSummary[], HopperProtocolError> => {
  const parsed = z
    .array(segmentSchema)
    .safeParse(unwrapProperty(value, "segments"));
  return parsed.success
    ? ok(parsed.data)
    : invalid("segment list", parsed.error);
};

/** Parse direct or wrapped Hopper document names. */
export const parseDocuments = (
  value: JsonValue,
): Result<readonly string[], HopperProtocolError> => {
  const parsed = z
    .array(z.string())
    .safeParse(unwrapProperty(value, "documents"));
  return parsed.success
    ? ok(parsed.data)
    : invalid("document list", parsed.error);
};

/** Parse a direct or wrapped list when only its cardinality is required. */
export const parseListCount = (
  value: JsonValue,
  property: string,
): Result<number, HopperProtocolError> => {
  const unwrapped = unwrapProperty(value, property);
  const pageTotal = z
    .object({ total: z.number().int().min(0) })
    .safeParse(unwrapped);
  if (pageTotal.success) return ok(pageTotal.data.total);
  const page = z.object({ items: z.array(z.unknown()) }).safeParse(unwrapped);
  if (page.success) return ok(page.data.items.length);
  const list = z.array(z.unknown()).safeParse(unwrapped);
  if (list.success) return ok(list.data.length);
  const map = z.record(z.string(), z.unknown()).safeParse(unwrapped);
  return map.success
    ? ok(Object.keys(map.data).length)
    : invalid(`${property} list`, map.error);
};

const unwrapProperty = (value: JsonValue, property: string): JsonValue => {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    property in value
  ) {
    return value[property] ?? null;
  }
  return value;
};

const invalid = <T>(
  expected: string,
  cause: z.ZodError,
): Result<T, HopperProtocolError> =>
  err(
    new HopperProtocolError(`Hopper returned an invalid ${expected}`, {
      cause,
    }),
  );
