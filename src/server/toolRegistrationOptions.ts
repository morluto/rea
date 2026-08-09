import type { ToolContract } from "../contracts/toolContracts.js";

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
  inputSchema: contract.inputSchema,
  outputSchema: contract.outputSchema,
  annotations: contract.annotations,
});
