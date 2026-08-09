import type { ToolContract } from "../contracts/toolContracts.js";

/** Project the canonical Zod contracts directly into SDK registration. */
export const toolRegistrationOptions = (contract: ToolContract) => ({
  title: contract.title,
  description: contract.description,
  inputSchema: contract.inputSchema,
  outputSchema: contract.outputSchema,
  annotations: contract.annotations,
});
