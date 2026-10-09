import { z } from "zod";
import {
  nativeFunctionAnnotationsInputSchema,
  nativeFunctionAnnotationsSchema,
} from "../domain/native/nativeFunctionAnnotations.js";
import { nativeDataTypeSchema } from "../domain/native/nativeDataType.js";
import {
  nativeInstructionSchema,
  nativeCallTargetsSchema,
} from "../domain/native/nativeInstruction.js";

import {
  type AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import {
  functionBodyEntryAgrees,
  functionInstructionWindowSchema,
  functionDossierSchema,
  type FunctionDossier,
} from "../domain/hopperValues.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import { nativeApiBoundarySchema } from "../domain/native/nativeApiBoundary.js";
import { nativeValueFlowSchema } from "../domain/native/nativeValueFlow.js";
import { err, ok, type Result } from "../domain/result.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import {
  ghidraIdentifierSchema,
  ghidraInputAddressSchema,
  ghidraCanonicalAddressSchema,
  ghidraFunctionClassificationSchema as classification,
  ghidraFunctionBodySchema as ghidraFunctionBody,
  ghidraProcedureIdentitySchema as procedureIdentity,
} from "./GhidraInventoryValues.js";

/** Function analysis and annotation operations admitted by the Ghidra adapter. */
export const GHIDRA_FUNCTION_OPERATIONS = [
  "annotate_native_function",
  "inspect_native_data_type",
  "inspect_native_instruction",
  "resolve_native_call_targets",
  "analyze_function",
  "procedure_assembly",
  "procedure_callees",
  "procedure_callers",
  "procedure_info",
  "procedure_pseudo_code",
  "read_function_instructions",
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

const document = ghidraIdentifierSchema.nullable().default(null);
const procedure = ghidraIdentifierSchema;
const directProcedure = { document, procedure };

const inputSchemas = {
  annotate_native_function: nativeFunctionAnnotationsInputSchema,
  inspect_native_data_type: z
    .object({
      document,
      type: z.string().min(1).nullable().default(null),
      address: ghidraInputAddressSchema.nullable().default(null),
    })
    .strict()
    .refine(
      (value) => (value.type === null) !== (value.address === null),
      "Supply exactly one of type or address",
    ),
  inspect_native_instruction: z
    .object({ document, address: ghidraInputAddressSchema })
    .strict(),
  resolve_native_call_targets: z
    .object({ document, address: ghidraInputAddressSchema })
    .strict(),
  analyze_function: z.object({ procedure }).strict(),
  procedure_assembly: z.object(directProcedure).strict(),
  procedure_callees: z.object(directProcedure).strict(),
  procedure_callers: z.object(directProcedure).strict(),
  procedure_info: z.object(directProcedure).strict(),
  procedure_pseudo_code: z.object(directProcedure).strict(),
  read_function_instructions: z.object(directProcedure).strict(),
  procedure_references: z
    .object({
      ...directProcedure,
      direction: z.enum(["incoming", "outgoing"]).default("outgoing"),
    })
    .strict(),
  xrefs: z.object({ document, address: ghidraInputAddressSchema }).strict(),
} satisfies Readonly<Record<GhidraFunctionOperation, z.ZodType>>;

/** Validate and default one function request before it crosses the socket. */
export const parseGhidraFunctionInput = (
  operation: GhidraFunctionOperation,
  value: Readonly<Record<string, JsonValue>>,
): Result<Readonly<Record<string, JsonValue>>, AnalysisInputError> => {
  const parsed = inputSchemas[operation].safeParse(value);
  return parsed.success
    ? ok(
        jsonObjectSchema.parse(
          Object.fromEntries(
            Object.entries(parsed.data).filter(
              ([, value]) => value !== undefined,
            ),
          ),
        ),
      )
    : err(
        analysisInputErrorFromIssues(operation, parsed.error.issues, value, {
          cause: parsed.error,
        }),
      );
};

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
const procedureReferences = z
  .object({
    procedure: procedureIdentity,
    direction: z.enum(["incoming", "outgoing"]),
    references: z.array(referenceEdge),
    reference_kinds_available: z.boolean(),
    unresolved_calls: z.array(
      z.strictObject({
        address: ghidraCanonicalAddressSchema,
        reason: z.string(),
      }),
    ),
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
    body: ghidraFunctionBody,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !functionBodyEntryAgrees(value.body, value.entrypoint) ||
      (value.body.available &&
        (value.length !== value.body.total_bytes ||
          (!value.classification.external && !value.body.contains_entry)))
    )
      context.addIssue({
        code: "custom",
        message: "Ghidra function body disagrees with entry point or length",
      });
  });

const ghidraNativeApiBoundary = nativeApiBoundarySchema.superRefine(
  (value, context) => {
    if (!value.available) return;
    if (value.provenance !== "ghidra-high-function")
      context.addIssue({
        code: "custom",
        message:
          "Ghidra native API observations require HighFunction provenance",
      });
    const addresses = value.jump_tables.flatMap((table) => [
      table.dispatch_address,
      ...table.data_sources.map(({ address }) => address),
      ...table.mappings.map(({ target_address }) => target_address),
      ...table.default_targets.map(({ target_address }) => target_address),
    ]);
    if (
      addresses.some(
        (address) => !ghidraCanonicalAddressSchema.safeParse(address).success,
      )
    )
      context.addIssue({
        code: "custom",
        message:
          "Ghidra native API observation contains a non-canonical address",
      });
  },
);

const ghidraNativeValueFlow = nativeValueFlowSchema.superRefine(
  (value, context) => {
    if (!value.available) return;
    const operations = value.operations;
    const addresses = operations.flatMap((operation) => [
      operation.address,
      ...operation.inputs.flatMap(({ location }) =>
        location === null ? [] : [location],
      ),
      ...(operation.output?.location == null
        ? []
        : [operation.output.location]),
    ]);
    if (
      addresses.some(
        (address) => !ghidraCanonicalAddressSchema.safeParse(address).success,
      )
    )
      context.addIssue({
        code: "custom",
        message: "Ghidra p-code flow contains a non-canonical address",
      });
    const operationIds = new Set(operations.map(({ id }) => id));
    if (operationIds.size !== operations.length)
      context.addIssue({
        code: "custom",
        message: "Ghidra p-code operation identifiers are not unique",
      });
    if (
      value.def_use.some(
        ({ definition, use }) =>
          !operationIds.has(definition) || !operationIds.has(use),
      ) ||
      value.effects.some(({ operation }) => !operationIds.has(operation))
    )
      context.addIssue({
        code: "custom",
        message: "Ghidra p-code relationship references a missing operation",
      });
    if (
      value.truncated !==
      (value.omitted_operations_lower_bound > 0 ||
        value.known_omitted_inputs > 0 ||
        value.known_omitted_edges > 0)
    )
      context.addIssue({
        code: "custom",
        message: "Ghidra p-code truncation flag contradicts omitted counts",
      });
  },
);

const ghidraFunctionDossier = functionDossierSchema
  .extend({
    procedure: functionDossierSchema.shape.procedure.safeExtend({
      classification,
      body: ghidraFunctionBody,
    }),
    native_api: ghidraNativeApiBoundary,
    native_value_flow: ghidraNativeValueFlow,
  })
  .strict()
  .superRefine((value, context) => {
    const addresses = [
      value.procedure.address,
      ...value.comments.map(({ address }) => address),
      ...value.callers.map(({ address }) => address),
      ...value.callees.map(({ address }) => address),
      ...value.incoming_references.flatMap(referenceAddresses),
      ...value.outgoing_references.flatMap(referenceAddresses),
      ...value.referenced_strings.flatMap(({ address, source_address }) => [
        address,
        source_address,
      ]),
      ...value.referenced_names.flatMap(({ address, source_address }) => [
        address,
        source_address,
      ]),
      ...value.basic_blocks.flatMap(({ start, end, successors }) => [
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
      ...value.callers,
      ...value.callees,
      ...value.incoming_references.flatMap(referenceProcedures),
      ...value.outgoing_references.flatMap(referenceProcedures),
    ];
    if (
      identities.some(
        (identity) =>
          !classification.safeParse(identity.classification).success ||
          !ghidraFunctionBody.safeParse(identity.body).success ||
          !functionBodyEntryAgrees(identity.body, identity.address) ||
          (identity.body.available &&
            identity.classification?.external === false &&
            !identity.body.contains_entry),
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
      [...value.incoming_references, ...value.outgoing_references].some(
        ({ kind }) => !referenceKind.safeParse(kind).success,
      )
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
  });
const ghidraFunctionInstructionWindow = functionInstructionWindowSchema
  .extend({ procedure: procedureIdentity })
  .strict();

const resultSchemas = {
  annotate_native_function: nativeFunctionAnnotationsSchema.safeExtend({
    dossier: ghidraFunctionDossier,
  }),
  analyze_function: ghidraFunctionDossier,
  procedure_assembly: z.string(),
  procedure_callees: z.array(ghidraCanonicalAddressSchema),
  procedure_callers: z.array(ghidraCanonicalAddressSchema),
  procedure_info: procedureInfo,
  procedure_pseudo_code: z.string().nullable(),
  read_function_instructions: ghidraFunctionInstructionWindow,
  inspect_native_instruction: nativeInstructionSchema,
  inspect_native_data_type: nativeDataTypeSchema,
  resolve_native_call_targets: nativeCallTargetsSchema,
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
  edge: FunctionDossier["incoming_references"][number],
): readonly string[] => [
  edge.source_address,
  edge.target_address,
  ...(edge.source_procedure === null ? [] : [edge.source_procedure.address]),
  ...(edge.target_procedure === null ? [] : [edge.target_procedure.address]),
];

const referenceProcedures = (
  edge: FunctionDossier["incoming_references"][number],
): readonly NonNullable<
  FunctionDossier["incoming_references"][number]["source_procedure"]
>[] => [
  ...(edge.source_procedure === null ? [] : [edge.source_procedure]),
  ...(edge.target_procedure === null ? [] : [edge.target_procedure]),
];
