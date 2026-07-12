import type { ToolContract } from "../contracts/toolContracts.js";

/** Project the public contract fields accepted by MCP tool registration. */
export const toolRegistrationOptions = (contract: ToolContract) => ({
  description: contract.description,
  inputSchema: contract.inputSchema,
  outputSchema: contract.outputSchema,
  annotations: contract.annotations,
});
