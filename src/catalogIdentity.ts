import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import { CLI_COMMAND_NAMES } from "./cliCommandNames.js";

export { CLI_COMMAND_NAMES } from "./cliCommandNames.js";

const toolCatalog = TOOL_CONTRACTS.map((contract) => ({
  name: contract.name,
  surface: contract.kind,
  description: contract.description,
  annotations: contract.annotations,
  input_schema: z.toJSONSchema(contract.inputSchema, {
    unrepresentable: "any",
  }),
  output_schema: z.toJSONSchema(contract.outputSchema, {
    unrepresentable: "any",
  }),
})).sort((left, right) => left.name.localeCompare(right.name));

const promptCatalog = PROMPT_CONTRACTS.map((contract) => ({
  name: contract.name,
  title: contract.title,
  description: contract.description,
  arguments: contract.arguments,
  steps: contract.steps,
})).sort((left, right) => left.name.localeCompare(right.name));

const resourceCatalog = [
  { name: "server-identity", uri: "rea://server/identity" },
  { name: "active-residual-unknowns", uri: "rea://unknowns/active" },
] as const;
const resourceTemplateCatalog = [
  { name: "session-evidence", uri_template: "rea://evidence/{evidenceId}" },
  {
    name: "evidence-section",
    uri_template: "rea://evidence/{evidenceId}/section/{section}",
  },
  { name: "residual-unknown", uri_template: "rea://unknown/{unknownId}" },
  {
    name: "analysis-snapshot",
    uri_template: "rea://snapshot/{snapshotDigest}",
  },
  {
    name: "artifact-page",
    uri_template: "rea://artifact/{manifestId}/{collection}",
  },
  {
    name: "function-dossier",
    uri_template: "rea://function/{targetSha256}/{address}",
  },
  {
    name: "investigation-workspace-revision",
    uri_template: "rea://workspace/{workspaceId}/revision/{revision}",
  },
] as const;

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Catalog is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

/** Stable, schema-sensitive identity for every public REA surface. */
export const CATALOG_IDENTITY = {
  counts: {
    cli_commands: CLI_COMMAND_NAMES.length,
    mcp_tools: toolCatalog.length,
    mcp_prompts: promptCatalog.length,
    mcp_resources: resourceCatalog.length,
    mcp_resource_templates: resourceTemplateCatalog.length,
  },
  digests: {
    tools_sha256: digest(toolCatalog),
    prompts_sha256: digest(promptCatalog),
    resources_sha256: digest({ resourceCatalog, resourceTemplateCatalog }),
    combined_sha256: digest({
      cli: CLI_COMMAND_NAMES,
      tools: toolCatalog,
      prompts: promptCatalog,
      resources: resourceCatalog,
      resource_templates: resourceTemplateCatalog,
    }),
  },
  tools: toolCatalog.map(({ name, surface, annotations }) => ({
    name,
    surface,
    annotations: {
      read_only: annotations.readOnlyHint ?? false,
      destructive: annotations.destructiveHint ?? false,
      idempotent: annotations.idempotentHint ?? false,
      open_world: annotations.openWorldHint ?? true,
    },
  })),
} as const;
