import { z } from "zod";

import { AnalysisInputError, AnalysisOutputError } from "../domain/errors.js";
import {
  functionDossierSchema,
  type FunctionDossier,
} from "../domain/hopperValues.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  ghidraBoundedIdentifierSchema,
  ghidraCanonicalAddressSchema,
} from "./GhidraInventoryValues.js";

/** Read-only function operations admitted by the Ghidra adapter. */
export const GHIDRA_FUNCTION_OPERATIONS = [
  "analyze_function",
  "procedure_assembly",
  "procedure_callees",
  "procedure_callers",
  "procedure_info",
  "procedure_pseudo_code",
  "procedure_references",
  "xrefs",
] as const;

/** One function-analysis operation implemented by the packaged Java bridge. */
export type GhidraFunctionOperation =
  (typeof GHIDRA_FUNCTION_OPERATIONS)[number];

const operationSet: ReadonlySet<string> = new Set(GHIDRA_FUNCTION_OPERATIONS);

/** Narrow an application operation to the Ghidra function-analysis surface. */
export const isGhidraFunctionOperation = (
  operation: string,
): operation is GhidraFunctionOperation => operationSet.has(operation);

const document = ghidraBoundedIdentifierSchema.nullable().default(null);
const procedure = ghidraBoundedIdentifierSchema;
const directProcedure = { document, procedure };
const collectionOffsets = z
  .object({
    comments: z.number().int().min(0).default(0),
    callers: z.number().int().min(0).default(0),
    callees: z.number().int().min(0).default(0),
    incoming_references: z.number().int().min(0).default(0),
    outgoing_references: z.number().int().min(0).default(0),
    referenced_strings: z.number().int().min(0).default(0),
    referenced_names: z.number().int().min(0).default(0),
    basic_blocks: z.number().int().min(0).default(0),
  })
  .strict()
  .default({
    comments: 0,
    callers: 0,
    callees: 0,
    incoming_references: 0,
    outgoing_references: 0,
    referenced_strings: 0,
    referenced_names: 0,
    basic_blocks: 0,
  });

const inputSchemas = {
  analyze_function: z
    .object({
      procedure,
      include_assembly: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
      max_pseudocode_chars: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .default(20_000),
      max_instructions: z.number().int().min(1).max(5_000).default(500),
      pseudocode_offset: z.number().int().min(0).default(0),
      assembly_offset: z.number().int().min(0).default(0),
      collection_offset: collectionOffsets,
    })
    .strict(),
  procedure_assembly: z.object(directProcedure).strict(),
  procedure_callees: z.object(directProcedure).strict(),
  procedure_callers: z.object(directProcedure).strict(),
  procedure_info: z.object(directProcedure).strict(),
  procedure_pseudo_code: z.object(directProcedure).strict(),
  procedure_references: z
    .object({
      ...directProcedure,
      direction: z.enum(["incoming", "outgoing"]).default("outgoing"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
      max_instructions: z.number().int().min(1).max(5_000).default(500),
    })
    .strict(),
  xrefs: z.object({ document, address: ghidraCanonicalAddressSchema }).strict(),
} satisfies Readonly<Record<GhidraFunctionOperation, z.ZodType>>;

/** Validate and default one function request before it crosses the socket. */
export const parseGhidraFunctionInput = (
  operation: GhidraFunctionOperation,
  value: Readonly<Record<string, JsonValue>>,
): Result<Readonly<Record<string, JsonValue>>, AnalysisInputError> => {
  const parsed = inputSchemas[operation].safeParse(value);
  return parsed.success
    ? ok(jsonObjectSchema.parse(parsed.data))
    : err(new AnalysisInputError(operation, { cause: parsed.error }));
};

const classification = z
  .object({
    external: z.boolean(),
    thunk: z.boolean(),
    thunk_target: ghidraCanonicalAddressSchema.nullable(),
    provenance: z.literal("ghidra-function-manager"),
  })
  .strict();
const procedureIdentity = z
  .object({
    address: ghidraCanonicalAddressSchema,
    name: z.string().min(1),
    classification,
  })
  .strict();
const localVariable = z
  .object({
    description: z.string(),
    provenance: z.literal("ghidra-function-database"),
  })
  .strict();
const referenceKind = z
  .object({
    available: z.literal(true),
    provenance: z.literal("ghidra-reference-manager"),
    type: z.string().min(1),
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
const referenceEdge = z
  .object({
    source_address: ghidraCanonicalAddressSchema,
    target_address: ghidraCanonicalAddressSchema,
    source_procedure: procedureIdentity.nullable(),
    target_procedure: procedureIdentity.nullable(),
    kind: referenceKind,
  })
  .strict();
const boundedReferences = z
  .object({
    items: z.array(referenceEdge),
    total: z.number().int().min(0).nullable(),
    returned: z.number().int().min(0),
    truncated: z.boolean(),
    next_offset: z.number().int().min(0).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.returned !== value.items.length)
      context.addIssue({
        code: "custom",
        path: ["returned"],
        message: "returned must equal the number of reference items",
      });
    if (value.total !== null && value.total < value.returned)
      context.addIssue({
        code: "custom",
        path: ["total"],
        message: "total cannot be smaller than returned",
      });
    if (value.next_offset !== null && !value.truncated)
      context.addIssue({
        code: "custom",
        path: ["next_offset"],
        message: "a continuation requires truncated output",
      });
  });
const procedureReferences = z
  .object({
    procedure: procedureIdentity,
    direction: z.enum(["incoming", "outgoing"]),
    references: boundedReferences,
    instructions_scanned: z.number().int().min(0),
    instruction_scan_truncated: z.boolean(),
  })
  .strict();
const procedureInfo = z
  .object({
    name: z.string().min(1),
    entrypoint: ghidraCanonicalAddressSchema,
    basicblock_count: z.number().int().min(0),
    length: z.number().int().min(0),
    signature: z.string().nullable(),
    locals: z.array(localVariable),
    classification,
  })
  .strict();

const ghidraFunctionDossier = functionDossierSchema.superRefine(
  (value, context) => {
    const addresses = [
      value.procedure.address,
      ...value.comments.items.map(({ address }) => address),
      ...value.callers.items.map(({ address }) => address),
      ...value.callees.items.map(({ address }) => address),
      ...value.incoming_references.items.flatMap(referenceAddresses),
      ...value.outgoing_references.items.flatMap(referenceAddresses),
      ...value.referenced_strings.items.flatMap(
        ({ address, source_address }) => [address, source_address],
      ),
      ...value.referenced_names.items.flatMap(({ address, source_address }) => [
        address,
        source_address,
      ]),
      ...value.basic_blocks.items.flatMap(({ start, end, successors }) => [
        start,
        end,
        ...successors,
      ]),
    ];
    if (
      addresses.some(
        (address) => !ghidraCanonicalAddressSchema.safeParse(address).success,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Ghidra dossier contains a non-canonical address",
      });
    const identities = [
      value.procedure,
      ...value.callers.items,
      ...value.callees.items,
      ...value.incoming_references.items.flatMap(referenceProcedures),
      ...value.outgoing_references.items.flatMap(referenceProcedures),
    ];
    if (
      identities.some(
        ({ classification: facts }) => !classification.safeParse(facts).success,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Ghidra dossier omitted function classification",
      });
    if (
      value.procedure.locals.some(
        (variable) => !localVariable.safeParse(variable).success,
      ) ||
      [
        ...value.incoming_references.items,
        ...value.outgoing_references.items,
      ].some(({ kind }) => !referenceKind.safeParse(kind).success)
    )
      context.addIssue({
        code: "custom",
        message: "Ghidra dossier contains invalid provenance",
      });
    if (
      !value.limitations.some((item) => /indirect|computed/u.test(item)) ||
      !value.limitations.some((item) => /provider|Ghidra|Hopper/u.test(item))
    )
      context.addIssue({
        code: "custom",
        message: "Ghidra dossier omitted required uncertainty limitations",
      });
  },
);

const resultSchemas = {
  analyze_function: ghidraFunctionDossier,
  procedure_assembly: z.string(),
  procedure_callees: z.array(ghidraCanonicalAddressSchema),
  procedure_callers: z.array(ghidraCanonicalAddressSchema),
  procedure_info: procedureInfo,
  procedure_pseudo_code: z.string().nullable(),
  procedure_references: procedureReferences,
  xrefs: z.array(ghidraCanonicalAddressSchema),
} satisfies Readonly<Record<GhidraFunctionOperation, z.ZodType>>;

/** Require exact, bounded Java-bridge function output before creating Evidence. */
export const parseGhidraFunctionResult = (
  operation: GhidraFunctionOperation,
  value: JsonValue,
): Result<JsonValue, AnalysisOutputError> => {
  const parsed = resultSchemas[operation].safeParse(value);
  return parsed.success
    ? ok(jsonValueSchema.parse(parsed.data))
    : err(
        new AnalysisOutputError(
          operation,
          "Ghidra bridge output did not match the function-analysis contract",
          { cause: parsed.error },
        ),
      );
};

const referenceAddresses = (
  edge: FunctionDossier["incoming_references"]["items"][number],
): readonly string[] => [
  edge.source_address,
  edge.target_address,
  ...(edge.source_procedure === null ? [] : [edge.source_procedure.address]),
  ...(edge.target_procedure === null ? [] : [edge.target_procedure.address]),
];

const referenceProcedures = (
  edge: FunctionDossier["incoming_references"]["items"][number],
): readonly NonNullable<
  FunctionDossier["incoming_references"]["items"][number]["source_procedure"]
>[] => [
  ...(edge.source_procedure === null ? [] : [edge.source_procedure]),
  ...(edge.target_procedure === null ? [] : [edge.target_procedure]),
];
