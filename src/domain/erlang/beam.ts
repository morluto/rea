import { z } from "zod";
import { knownCoverageStatusSchema } from "../coverage.js";

import { digestSchema } from "../digests.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  parameterBudgetLimitFor,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";

const uint = z.number().int().min(0).max(0xffffffff);
const range = z.strictObject({ offset: uint, bytes: uint });

/** Hard ceiling on the caller-selected input read budget. */
export const MAX_INSPECT_ERLANG_BEAM_FILE_BYTES = 536870912;
/** Hard ceiling on IFF chunks in one BEAM form. */
export const MAX_INSPECT_ERLANG_BEAM_CHUNKS = 256;
/** Hard ceiling on decoded atom-table entries. */
export const MAX_INSPECT_ERLANG_BEAM_ATOMS = 65536;
/** Hard ceiling on export, import, and lambda rows combined. */
export const MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS = 1_048_576;

/** The per-call budgets of `inspect_erlang_beam`. */
export const ERLANG_BEAM_BUDGETS = {
  max_file_bytes: {
    minimum: 16,
    maximum: MAX_INSPECT_ERLANG_BEAM_FILE_BYTES,
    default_value: 67108864,
    unit: "bytes",
  },
  max_chunks: {
    minimum: 1,
    maximum: MAX_INSPECT_ERLANG_BEAM_CHUNKS,
    default_value: 64,
    unit: "count",
  },
  max_atoms: {
    minimum: 1,
    maximum: MAX_INSPECT_ERLANG_BEAM_ATOMS,
    default_value: 4096,
    unit: "count",
  },
  /** Export, import and lambda rows combined; each is retained in the report. */
  max_table_rows: {
    minimum: 1,
    maximum: MAX_INSPECT_ERLANG_BEAM_TABLE_ROWS,
    default_value: 65536,
    unit: "count",
  },
} as const satisfies Record<string, ParameterBudget>;
export type ErlangBeamBudget = keyof typeof ERLANG_BEAM_BUDGETS;

/** The per-call budget that stopped a BEAM inspection. */
export const erlangBeamBudgetLimit =
  parameterBudgetLimitFor<ErlangBeamBudget>(ERLANG_BEAM_BUDGETS);

/** Complete bounded inspection of one Erlang BEAM IFF container. */
export const inspectErlangBeamInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema.describe(
    "Absolute filesystem path to a BEAM file",
  ),
  max_file_bytes: parameterBudgetSchema(
    ERLANG_BEAM_BUDGETS.max_file_bytes,
  ).describe("Maximum stable artifact bytes to read (default 64 MiB)"),
  max_chunks: parameterBudgetSchema(ERLANG_BEAM_BUDGETS.max_chunks).describe(
    "Maximum IFF chunks to examine; exceeding the budget fails without partial success",
  ),
  max_atoms: parameterBudgetSchema(ERLANG_BEAM_BUDGETS.max_atoms).describe(
    "Maximum atom-table entries to decode; exceeding the budget fails without partial success",
  ),
  max_table_rows: parameterBudgetSchema(
    ERLANG_BEAM_BUDGETS.max_table_rows,
  ).describe(
    "Maximum export, import and lambda rows combined (default 65536); exceeding the budget fails without partial success",
  ),
});

const atomSchema = z.strictObject({
  index: uint,
  name: z.string(),
});

const exportSchema = z.strictObject({
  function_index: uint,
  function: z.string().nullable(),
  arity: uint,
  label: uint,
});

const importSchema = z.strictObject({
  module_index: uint,
  module: z.string().nullable(),
  function_index: uint,
  function: z.string().nullable(),
  arity: uint,
});

const lambdaSchema = z.strictObject({
  function_index: uint,
  function: z.string().nullable(),
  arity: uint,
  label: uint,
  index: uint,
  free_vars: uint,
  old_unique: uint,
});

const chunkSchema = z.strictObject({
  index: uint,
  name: z.string().length(4),
  location: range,
  payload: z.strictObject({
    location: range,
    bytes: uint,
    sha256: digestSchema,
  }),
});

/** Observed BEAM IFF form; missing optional tables stay null rather than empty-everywhere. */
export const erlangBeamSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: uint,
  }),
  form: z.strictObject({
    location: range,
    size: uint,
  }),
  chunks: z.array(chunkSchema),
  atoms: z.array(atomSchema).nullable(),
  atom_encoding: z.enum(["latin1", "utf8"]).nullable(),
  exports: z.array(exportSchema).nullable(),
  imports: z.array(importSchema).nullable(),
  lambdas: z.array(lambdaSchema).nullable(),
  code: z
    .strictObject({
      instruction_set: uint,
      opcode_max: uint,
      labels: uint,
      functions: uint,
      extra_header_bytes: uint,
      instructions: range,
    })
    .nullable(),
  module: z.string().nullable(),
  coverage: z.strictObject({
    // "partial" when bytes trail the declared FOR1 form or a decoded table.
    status: knownCoverageStatusSchema,
    examined_chunks: uint,
    atoms: uint,
    // Optional so Evidence retained by builds predating this field reparses
    // as unknown rather than a fabricated zero; every new parse emits the count.
    trailing_bytes: uint.optional(),
  }),
  limitations: z.array(z.string()),
});

export type ErlangBeam = z.infer<typeof erlangBeamSchema>;
export type InspectErlangBeamInput = z.infer<
  typeof inspectErlangBeamInputSchema
>;
