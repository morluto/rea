import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "../contracts/toolSchemaMetadata.js";

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
  outputSchema: toolOutputSchemaWithMetadata(contract),
  annotations: contract.annotations,
});

/** Register a workflow that validates raw input before effects and projects its own errors. */
export const applicationToolRegistrationOptions = <
  Contract extends ToolContract,
>(
  contract: Contract,
) => {
  const registration = toolRegistrationOptions(contract);
  const inputSchema: StandardSchemaWithJSON = {
    "~standard": {
      ...registration.inputSchema["~standard"],
      vendor: "rea-application",
      validate: (value: unknown) => ({ value }),
    },
  };
  return { ...registration, inputSchema };
};
