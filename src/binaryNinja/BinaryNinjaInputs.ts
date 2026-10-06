import { z } from "zod";
import type { AnalysisOperation } from "../application/AnalysisProvider.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { BINARY_NINJA_OPERATIONS } from "./BinaryNinjaValues.js";

const admitted: ReadonlySet<string> = new Set(BINARY_NINJA_OPERATIONS);

/** Validate REA inputs, including its MCP projection of omitted optional fields as null. */
export const parseBinaryNinjaParameters = (
  operation: AnalysisOperation,
  parameters: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> => {
  if (operation !== "health" && !admitted.has(operation))
    throw new AnalysisCapabilityUnavailableError(
      "binary-ninja",
      operation,
      "This read-only adapter does not declare this operation.",
    );
  const schema =
    operation === "analyze_function"
      ? enhancedInputSchemas.analyze_function
      : OFFICIAL_TOOL_CONTRACTS.find(({ name }) => name === operation)
          ?.inputSchema;
  const optional = new Set(
    schema instanceof z.ZodObject
      ? Object.entries(schema.shape)
          .filter(
            ([, field]) => field instanceof z.ZodType && field.isOptional(),
          )
          .map(([key]) => key)
      : [],
  );
  const input = Object.fromEntries(
    Object.entries(parameters).filter(
      ([key, value]) => !(value === null && optional.has(key)),
    ),
  );
  const parsed = schema?.safeParse(input);
  if (parsed !== undefined && !parsed.success)
    throw new AnalysisInputError(operation, { cause: parsed.error });
  return input;
};
