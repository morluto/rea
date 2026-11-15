import { z } from "zod";
import { DISCOVER_TOOLS } from "../../dist/catalogDiscovery.js";
import { TOOL_CONTRACTS } from "../../dist/contracts/toolContracts.js";
import { advertisedOutputJsonSchema } from "../../dist/contracts/toolSchemaMetadata.js";

/**
 * The canonical output JSON Schema for one tool. `tools/list` omits output
 * schemas by default (or bounds them), so verifiers validate replies against
 * the compiled contract instead of a listed definition.
 */
export const canonicalOutputSchema = (name) => {
  // Transport discovery is registered from its own schema, not a tool contract.
  if (name === DISCOVER_TOOLS.name)
    return z.toJSONSchema(DISCOVER_TOOLS.outputSchema, { io: "output" });
  const contract = TOOL_CONTRACTS.find((candidate) => candidate.name === name);
  if (contract === undefined) throw new Error(`No tool contract named ${name}`);
  return advertisedOutputJsonSchema(contract);
};

/** A listed tool definition whose output schema the SDK client validates against. */
export const withCanonicalOutputSchema = (tool) => ({
  ...tool,
  outputSchema: canonicalOutputSchema(tool.name),
});
