import { projectToAdvertisedDialect } from "./advertisedDialectProjection.js";
import {
  presentAdvertisedInput,
  type CompactInputSchemaPresentation,
} from "./compactInputSchema.js";
import {
  presentAdvertisedOutputSchema,
  type CompactOutputSchemaPresentation,
} from "./compactOutputSchema.js";

// The one owner of what a client receives for a tool: its description, input
// schema and output schema. The server's registration and `tools/list`
// listing, catalog identities, served environment catalogs and client
// verifiers all derive the advertised tool here from the canonical JSON
// Schemas; canonical server-side validation is unchanged.

/** How the canonical schemas of one catalog are advertised. */
export interface AdvertisedToolPresentation {
  /**
   * The per-tool input budget of the compact presentation, or `annotated`:
   * project into the portable dialect and keep nested annotations, for a
   * catalog that bounds its own size.
   */
  readonly input: CompactInputSchemaPresentation | "annotated";
  /** Output schemas are bounded by this presentation, or omitted without one. */
  readonly output: CompactOutputSchemaPresentation | undefined;
}

/** The client-facing fields of one tool, canonical or advertised. */
export interface AdvertisedToolSchemas {
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, unknown> | undefined;
  readonly outputSchema?: Record<string, unknown> | undefined;
}

/** The tool description followed by the input guidance its schema omits. */
const describe = (
  description: string | undefined,
  guidance: readonly string[],
): string | undefined => {
  if (guidance.length === 0) return description;
  const input = guidance.join(" ");
  return description === undefined || description === ""
    ? input
    : `${description}\n\n${input}`;
};

// The SDK and the contract metadata memoize each canonical schema object, so
// repeated listings and both output profiles reuse one projection.
const annotated = new WeakMap<
  object,
  ReturnType<typeof projectToAdvertisedDialect>
>();

const presentInput = (
  schema: Record<string, unknown>,
  presentation: AdvertisedToolPresentation["input"],
): {
  readonly schema: Record<string, unknown>;
  readonly guidance: readonly string[];
} => {
  if (presentation !== "annotated")
    return presentAdvertisedInput(schema, presentation);
  let projected = annotated.get(schema);
  if (projected === undefined)
    annotated.set(schema, (projected = projectToAdvertisedDialect(schema)));
  return projected;
};

/**
 * The advertised description and input schema. Reading the description
 * projects the schema; a tool without an input schema keeps its description.
 */
export const advertiseToolInput = (
  description: string | undefined,
  inputSchema: Record<string, unknown>,
  presentation: AdvertisedToolPresentation["input"],
): {
  readonly description: string | undefined;
  readonly inputSchema: Record<string, unknown>;
} => {
  const input = presentInput(inputSchema, presentation);
  return {
    description: describe(description, input.guidance),
    inputSchema: input.schema,
  };
};

const compactedOutput = new WeakMap<
  object,
  Map<number, Record<string, unknown>>
>();

/** The advertised output schema, or undefined when the presentation omits it. */
export const advertiseToolOutput = (
  outputSchema: Record<string, unknown>,
  presentation: AdvertisedToolPresentation["output"],
): Record<string, unknown> | undefined => {
  if (presentation === undefined) return undefined;
  let byBudget = compactedOutput.get(outputSchema);
  if (byBudget === undefined)
    compactedOutput.set(outputSchema, (byBudget = new Map()));
  let advertised = byBudget.get(presentation.budgetBytes);
  if (advertised === undefined)
    byBudget.set(
      presentation.budgetBytes,
      (advertised = presentAdvertisedOutputSchema(outputSchema, presentation)),
    );
  return advertised;
};

/** Everything a client receives for one tool, from its canonical schemas. */
export const advertiseTool = (
  canonical: AdvertisedToolSchemas,
  presentation: AdvertisedToolPresentation,
): AdvertisedToolSchemas => {
  const input =
    canonical.inputSchema === undefined
      ? { description: canonical.description }
      : advertiseToolInput(
          canonical.description,
          canonical.inputSchema,
          presentation.input,
        );
  const outputSchema =
    canonical.outputSchema === undefined
      ? undefined
      : advertiseToolOutput(canonical.outputSchema, presentation.output);
  return {
    ...(input.description === undefined
      ? {}
      : { description: input.description }),
    ...("inputSchema" in input ? { inputSchema: input.inputSchema } : {}),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
};
