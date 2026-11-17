import { createCatalogIdentity } from "./catalogIdentity.js";
import {
  DISCOVER_TOOLS,
  HOT_TOOL_NAMES,
  progressiveCatalogIdentity,
} from "./catalogDiscovery.js";
import { contractsForToolFamilies } from "../toolFamilies.js";
import { toolContract } from "../toolContracts.js";
import { advertisedOutputJsonSchema } from "../toolSchemaMetadata.js";
import { promptsForToolFamilies } from "../promptToolFamilyScope.js";
import type { McpOutputSchemaProfile } from "../mcpSchemaPresentation.js";
import type { CatalogIdentitySnapshot } from "./recordedCatalogDigests.js";

export interface McpDoctorCatalogExpectation {
  readonly catalog: CatalogIdentitySnapshot;
  readonly expectedToolNames: readonly string[];
  readonly expectedPromptNames: readonly string[];
  readonly binarySessionOutputSchema: Record<string, unknown>;
}

/** Build expectations from live contracts when family selection or source runs require it. */
export const buildLiveMcpDoctorExpectation = (
  selection: ReadonlySet<string> | undefined,
  outputSchemaProfile: McpOutputSchemaProfile,
  progressive: boolean,
): McpDoctorCatalogExpectation => {
  const contracts = contractsForToolFamilies(selection);
  const promptContracts = promptsForToolFamilies(selection);
  const catalog = createCatalogIdentity({
    contracts,
    outputSchemaProfile,
    promptContracts,
  });
  return {
    catalog: progressive ? progressiveCatalogIdentity(catalog) : catalog,
    expectedToolNames: progressive
      ? [
          ...contracts
            .map(({ name }) => name)
            .filter((name) => HOT_TOOL_NAMES.has(name)),
          DISCOVER_TOOLS.name,
        ]
      : contracts.map(({ name }) => name),
    expectedPromptNames: promptContracts.map(({ name }) => name),
    binarySessionOutputSchema: advertisedOutputJsonSchema(
      toolContract("binary_session"),
    ),
  };
};
