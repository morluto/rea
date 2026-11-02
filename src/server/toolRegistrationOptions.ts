import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
  getEvidenceInputContract,
  type EvidenceRequestFrameInput,
} from "../domain/evidenceInputContract.js";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "../contracts/toolSchemaMetadata.js";

/** Parse structured argument text a client serialized instead of sending as JSON. */
const structuredArgumentText = (supplied: unknown): unknown => {
  if (typeof supplied !== "string") return supplied;
  if (!supplied.startsWith("{") && !supplied.startsWith("[")) return supplied;
  // The MCP request size limit bounds the parse cost.
  try {
    const parsed: unknown = JSON.parse(supplied);
    if (parsed !== null && typeof parsed === "object") return parsed;
  } catch {
    // Not JSON text: the supplied value keeps its meaning.
  }
  return supplied;
};

/** Merge JSON-text arguments into the bag; undefined when nothing needs recovery. */
const recoveredArgumentBag = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const suppliedArguments = value as Record<string, unknown>;
  const recovered = new Map<string, unknown>();
  for (const [argument, supplied] of Object.entries(suppliedArguments)) {
    const parsed = structuredArgumentText(supplied);
    if (parsed !== supplied) recovered.set(argument, parsed);
  }
  return recovered.size === 0
    ? undefined
    : { ...suppliedArguments, ...Object.fromEntries(recovered) };
};

/**
 * Recover structured arguments a client delivered as JSON text before the
 * canonical parser runs. Claude Desktop serializes array and object arguments
 * to strings (morluto/rea#3408), so structured parameters are rejected.
 * Recovered values still face the canonical parser: JSON text a string
 * parameter accepts stays the caller's, malformed text keeps its validation
 * failure, and native JSON values are untouched. Recovery applies to the whole
 * argument bag, so a call that mixes recovered structured arguments with JSON
 * text a string parameter accepts keeps its rejection.
 */
export const acceptStringifiedStructuredArguments = (
  schema: StandardSchemaWithJSON,
): StandardSchemaWithJSON => {
  const standard = schema["~standard"];
  if (standard === undefined || typeof standard.validate !== "function")
    return schema;
  if (standard.vendor === "rea-application") return schema;
  const select = (
    parsedResult: Awaited<ReturnType<typeof standard.validate>>,
    value: unknown,
  ) => {
    if (!("issues" in parsedResult)) return parsedResult;
    const unchangedResult = standard.validate(value);
    if (unchangedResult instanceof Promise) {
      return unchangedResult.then((result) =>
        "issues" in result ? parsedResult : result,
      );
    }
    return "issues" in unchangedResult ? parsedResult : unchangedResult;
  };
  return {
    "~standard": {
      ...standard,
      validate: (value: unknown) => {
        const recoveredArguments = recoveredArgumentBag(value);
        if (recoveredArguments === undefined) return standard.validate(value);
        const parsedResult = standard.validate(recoveredArguments);
        return parsedResult instanceof Promise
          ? parsedResult.then((result) => select(result, value))
          : select(parsedResult, value);
      },
    },
  };
};

/** Project the canonical Zod contracts directly into SDK registration. */
export const toolRegistrationOptions = <Contract extends ToolContract>(
  contract: Contract,
): {
  readonly title: Contract["title"];
  readonly description: Contract["description"];
  readonly inputSchema: StandardSchemaWithJSON<
    z.input<Contract["inputSchema"]>,
    EvidenceRequestFrameInput<z.output<Contract["inputSchema"]>>
  >;
  readonly outputSchema: Contract["outputSchema"];
  readonly annotations: Contract["annotations"];
} => {
  const advertised = toolInputSchemaWithMetadata(contract);
  const evidenceInputs = getEvidenceInputContract<Contract["inputSchema"]>(
    contract.inputSchema,
  );
  // The application owns source admission. Preserve the exact advertised
  // declaration while the SDK validates only the borrowing request envelope.
  const inputSchema = {
    "~standard": {
      version: advertised["~standard"].version,
      vendor: advertised["~standard"].vendor,
      jsonSchema: advertised["~standard"].jsonSchema,
      validate: evidenceInputs.frameSchema["~standard"].validate,
    },
  };
  return {
    title: contract.title,
    description: contract.description,
    inputSchema,
    outputSchema: toolOutputSchemaWithMetadata(contract),
    annotations: contract.annotations,
  };
};

/** Register a workflow that validates raw input before effects and projects its own errors. */
export const applicationToolRegistrationOptions = <
  Contract extends ToolContract,
>(
  contract: Contract,
) => {
  const registration = toolRegistrationOptions(contract);
  const standard = registration.inputSchema["~standard"];
  const inputSchema: StandardSchemaWithJSON = {
    "~standard": {
      ...standard,
      vendor: "rea-application",
      validate: async (value: unknown) => {
        const recoveredArguments = recoveredArgumentBag(value);
        if (recoveredArguments !== undefined) {
          const recoveredResult = await standard.validate(recoveredArguments);
          if (!("issues" in recoveredResult))
            return { value: recoveredArguments };
        }
        // The handler owns application parsing, so the wrapper always accepts.
        return { value };
      },
    },
  };
  return { ...registration, inputSchema };
};
