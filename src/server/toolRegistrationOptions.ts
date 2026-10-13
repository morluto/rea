import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import {
  toolInputSchemaWithMetadata,
  toolOutputSchemaWithMetadata,
} from "../contracts/toolSchemaMetadata.js";

/** Preserve advertised contracts while the application owns structured input failures. */
export const applicationValidatedInputSchema = (
  schema: StandardSchemaWithJSON,
): StandardSchemaWithJSON => ({
  "~standard": {
    ...schema["~standard"],
    vendor: "rea-application",
    validate: (value: unknown) => ({ value }),
  },
});

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
