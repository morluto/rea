import type { ToolContract } from "../contracts/toolContracts.js";
import { toolInputSchemaWithMetadata } from "../contracts/toolSchemaMetadata.js";

/** Project the canonical Zod contracts directly into SDK registration. */
export const toolRegistrationOptions = <Contract extends ToolContract>(
  contract: Contract,
): {
  readonly title: Contract["title"];
  readonly description: Contract["description"];
  readonly inputSchema: Contract["inputSchema"];
  readonly outputSchema: Contract["outputSchema"];
  readonly annotations: Contract["annotations"];
} => ({
  title: contract.title,
  description: contract.description,
  inputSchema: toolInputSchemaWithMetadata(contract),
  outputSchema: contract.outputSchema,
  annotations: contract.annotations,
});
