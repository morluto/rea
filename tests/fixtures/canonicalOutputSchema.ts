import { z } from "zod";

import { DISCOVER_TOOLS } from "../../src/catalogDiscovery.js";
import { TOOL_CONTRACTS } from "../../src/contracts/toolContracts.js";
import {
  advertisedInputJsonSchema,
  advertisedOutputJsonSchema,
} from "../../src/contracts/toolSchemaMetadata.js";

const contractNamed = (name: string) => {
  const contract = TOOL_CONTRACTS.find((candidate) => candidate.name === name);
  if (contract === undefined) throw new Error(`No tool contract named ${name}`);
  return contract;
};

/**
 * The canonical output JSON Schema a validating client checks a reply
 * against. `tools/list` omits output schemas by default, so tests validate
 * structured results against the contract rather than a listed definition.
 * Transport discovery is registered from its own schema, not a tool contract.
 */
export const canonicalOutputSchema = (name: string): Record<string, unknown> =>
  name === DISCOVER_TOOLS.name
    ? z.toJSONSchema(DISCOVER_TOOLS.outputSchema, { io: "output" })
    : advertisedOutputJsonSchema(contractNamed(name));

/** The canonical input JSON Schema that the compact advertisement presents. */
export const canonicalInputSchema = (name: string): Record<string, unknown> =>
  advertisedInputJsonSchema(contractNamed(name));

/**
 * A listed tool definition carrying its canonical output schema, so the SDK
 * client (and any caller-supplied validator) checks replies against the
 * contract even though `tools/list` omits output schemas by default.
 */
export const withCanonicalOutputSchema = <
  Tool extends { readonly name: string },
>(
  tool: Tool,
): Tool & { outputSchema: Record<string, unknown> } => ({
  ...tool,
  outputSchema: canonicalOutputSchema(tool.name),
});
