import { z } from "zod";

import type { JsonValue } from "./jsonValue.js";
import { AnalysisOutputError, HopperProtocolError } from "./errors.js";
import { err, ok, type Result } from "./result.js";
import { nativeApiBoundarySchema } from "./nativeApiBoundary.js";
import { nativeValueFlowSchema } from "./nativeValueFlow.js";

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

/** Return a bounded byte distance between canonical addresses in one space. */
export const addressDistance = (start: string, end: string): number => {
  const left = addressCoordinate(start);
  const right = addressCoordinate(end);
  if (left === null || right === null || left.space !== right.space) return 0;
  const distance = right.offset - left.offset;
  if (distance <= 0n) return 0;
  return Number(
    distance > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : distance,
  );
};

const addressCoordinate = (
  value: string,
): { readonly space: string; readonly offset: bigint } | null => {
  const separator = value.lastIndexOf(":0x");
  const space = separator < 0 ? "default" : value.slice(0, separator);
  const offset = separator < 0 ? value : value.slice(separator + 1);
  if (!/^0x[0-9a-f]+$/u.test(offset)) return null;
  return { space, offset: BigInt(offset) };
};

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
const unavailableAnalysisFactSchema = z
  .object({ available: z.literal(false), reason: z.string() })
  .strict();
/** Complete observed function-body ranges; every range endpoint is inclusive. */
export const functionBodySchema = z.discriminatedUnion("available", [
  unavailableAnalysisFactSchema,
  z
    .strictObject({
      available: z.literal(true),
      provenance: z.string().min(1),
      ranges: z.array(
        z.strictObject({
          start: z.string(),
          end: z
            .string()
            .describe("Inclusive last address of this observed body range."),
        }),
      ),
      total_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      span_bytes: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .nullable(),
      non_contiguous: z.boolean(),
      contains_entry: z.boolean(),
    })
    .superRefine((body, context) => {
      let total = 0n;
      const bounds = new Map<string, { start: bigint; end: bigint }>();
      const closedSpaces = new Set<string>();
      let previousSpace: string | null = null;
      for (const range of body.ranges) {
        const start = addressCoordinate(range.start);
        const end = addressCoordinate(range.end);
        if (
          start === null ||
          end === null ||
          start.space !== end.space ||
          end.offset < start.offset
        ) {
          context.addIssue({
            code: "custom",
            message: "Function body range has invalid inclusive endpoints",
          });
          return;
        }
        if (previousSpace !== null && previousSpace !== start.space)
          closedSpaces.add(previousSpace);
        const previous = bounds.get(start.space);
        if (
          closedSpaces.has(start.space) ||
          (previous !== undefined && start.offset <= previous.end + 1n)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Function body ranges must be ordered, disjoint and maximal within each address space",
          });
          return;
        }
        bounds.set(start.space, {
          start: previous?.start ?? start.offset,
          end: end.offset,
        });
        previousSpace = start.space;
        total += end.offset - start.offset + 1n;
      }
      const onlyBounds =
        bounds.size === 1 ? [...bounds.values()][0] : undefined;
      const span =
        bounds.size === 0
          ? 0n
          : onlyBounds === undefined
            ? null
            : onlyBounds.end - onlyBounds.start + 1n;
      const reportedSpan =
        body.span_bytes === null ? null : BigInt(body.span_bytes);
      if (
        total !== BigInt(body.total_bytes) ||
        span !== reportedSpan ||
        body.non_contiguous !== body.ranges.length > 1
      )
        context.addIssue({
          code: "custom",
          message:
            "Function body counts, enclosing span or contiguity disagree with inclusive ranges",
        });
    }),
]);

const unknownFunctionBody = () =>
  functionBodySchema.default({
    available: false,
    reason: "The provider did not report complete function body ranges.",
  });

/** Check the declared entry membership against complete, inclusive body ranges. */
export const functionBodyEntryAgrees = (
  body: z.infer<typeof functionBodySchema>,
  address: string,
): boolean => {
  if (!body.available) return true;
  const entry = addressCoordinate(address);
  if (entry === null) return false;
  const contains = body.ranges.some((range) => {
    const start = addressCoordinate(range.start);
    const end = addressCoordinate(range.end);
    return (
      start !== null &&
      end !== null &&
      start.space === entry.space &&
      entry.offset >= start.offset &&
      entry.offset <= end.offset
    );
  });
  return contains === body.contains_entry;
};

export const procedureClassificationSchema = z
  .object({
    external: z.boolean(),
    thunk: z.boolean(),
    thunk_target: z.string().nullable(),
    provenance: z.string().min(1),
  })
  .strict();
export const procedureIdentitySchema = z
  .object({
    address: z.string(),
    name: z.string(),
    classification: procedureClassificationSchema.nullable().default(null),
    body: unknownFunctionBody(),
  })
  .strict()
  .superRefine((identity, context) => {
    if (!functionBodyEntryAgrees(identity.body, identity.address))
      context.addIssue({
        code: "custom",
        message:
          "Function body entry membership disagrees with procedure identity",
      });
  });
export const localVariableSchema = z
  .object({
    description: z.string(),
    provenance: z.string().min(1),
  })
  .strict();
/** Provider-neutral complete raw-instruction list for one analyzed function. */
export const functionInstructionWindowSchema = z
  .object({
    procedure: procedureIdentitySchema,
    instructions: z.array(z.string()),
    limitations: z.array(z.string()),
  })
  .strict();

const availableReferenceKindSchema = z
  .object({
    available: z.literal(true),
    provenance: z.string().min(1),
    type: z.string(),
    flow: z.boolean(),
    call: z.boolean(),
    jump: z.boolean(),
    data: z.boolean(),
    read: z.boolean(),
    write: z.boolean(),
    indirect: z.boolean(),
    computed: z.boolean(),
    conditional: z.boolean(),
    terminal: z.boolean(),
    primary: z.boolean(),
    operand_index: z.number().int(),
    external: z.boolean(),
  })
  .strict();
export const referenceKindSchema = z.discriminatedUnion("available", [
  unavailableAnalysisFactSchema,
  availableReferenceKindSchema,
]);
const referenceEdgeSchema = z
  .object({
    source_address: z.string(),
    target_address: z.string(),
    source_procedure: procedureIdentitySchema.nullable(),
    target_procedure: procedureIdentitySchema.nullable(),
    kind: referenceKindSchema,
  })
  .strict();
export const functionDossierSchema = z
  .object({
    procedure: procedureIdentitySchema.safeExtend({
      signature: z.string().nullable(),
      locals: z.array(localVariableSchema),
    }),
    pseudocode: z.string(),
    assembly: z.array(z.string()),
    comments: z.array(
      z
        .object({
          address: z.string(),
          kind: z.enum(["comment", "inline"]),
          text: z.string(),
        })
        .strict(),
    ),
    callers: z.array(procedureIdentitySchema),
    callees: z.array(procedureIdentitySchema),
    incoming_references: z.array(referenceEdgeSchema),
    outgoing_references: z.array(referenceEdgeSchema),
    referenced_strings: z.array(
      z
        .object({
          address: z.string(),
          value: z.string(),
          source_address: z.string(),
        })
        .strict(),
    ),
    referenced_names: z.array(
      z
        .object({
          address: z.string(),
          value: z.string(),
          source_address: z.string(),
        })
        .strict(),
    ),
    basic_blocks: z.array(
      z
        .object({
          start: z.string(),
          end: z.string(),
          successors: z.array(z.string()),
        })
        .strict(),
    ),
    native_api: nativeApiBoundarySchema.nullable().default(null),
    native_value_flow: nativeValueFlowSchema.nullable().default(null),
    limitations: z.array(z.string()).default([]),
  })
  .strict();

/** Strict analyzed-function dossier shared by provider and comparison boundaries. */
export type FunctionDossier = z.infer<typeof functionDossierSchema>;

/** Strictly parse a complete provider-neutral function dossier. */
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

/** Parse Hopper's direct or wrapped procedure map into stable entries. */
export const parseProcedures = (
  value: JsonValue,
): Result<readonly AddressedName[], HopperProtocolError> => {
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
    : invalid("procedure map", parsed.error);
};

/** Parse Hopper's direct or wrapped list of address/name records. */
export const parseNames = (
  value: JsonValue,
): Result<readonly AddressedName[], HopperProtocolError> => {
  const unwrapped = unwrapProperty(value, "names");
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
