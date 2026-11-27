import { z } from "zod";
import { functionBodySchema } from "./functionBody.js";
import { nativeInventoryRowsSchemas } from "./nativeInventory.js";
import { containingProcedureResolutionSchema } from "./nativeObservation.js";

/**
 * One native operation's provider-neutral result contract with its exact fact
 * type. Readers name the contract they need; nothing selects one by catalog
 * order. Row schemas are lenient: fields they do not name are dropped from
 * the typed fact, while Evidence keeps the provider's source value.
 */
export interface NativeOperationFactContract<Operation extends string, Fact> {
  readonly operation: Operation;
  /** What the result holds, for failure messages. */
  readonly subject: string;
  readonly schema: z.ZodType<Fact>;
}

const factContract = <Operation extends string, Fact>(
  operation: Operation,
  subject: string,
  schema: z.ZodType<Fact>,
): NativeOperationFactContract<Operation, Fact> =>
  Object.freeze({ operation, subject, schema });

export const listNamesFact = factContract(
  "list_names",
  "name inventory",
  nativeInventoryRowsSchemas.names,
);
export const listProceduresFact = factContract(
  "list_procedures",
  "procedure inventory",
  nativeInventoryRowsSchemas.names,
);
export const exportBodyMetadataSchema = z.strictObject({
  body: functionBodySchema,
  limitations: z.array(z.string()),
});

export const decompileExportInventoryFact = factContract(
  "list_procedures",
  "procedure inventory for decompile export",
  z.array(
    nativeInventoryRowsSchemas.names.element.extend({
      export_body_metadata: exportBodyMetadataSchema.exactOptional(),
    }),
  ),
);

export const searchProceduresFact = factContract(
  "search_procedures",
  "procedure search result",
  nativeInventoryRowsSchemas.names,
);
export const listStringsFact = factContract(
  "list_strings",
  "string inventory",
  nativeInventoryRowsSchemas.strings,
);
export const searchStringsFact = factContract(
  "search_strings",
  "string search result",
  nativeInventoryRowsSchemas.strings,
);
export const resolveContainingProcedureFact = factContract(
  "resolve_containing_procedure",
  "containing-procedure resolution",
  containingProcedureResolutionSchema,
);
