import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import { CLI_COMMAND_NAMES } from "./cliCommandNames.js";

export { CLI_COMMAND_NAMES } from "./cliCommandNames.js";

const toolCatalog = TOOL_CONTRACTS.map((contract) => ({
  name: contract.name,
  title: contract.title,
  surface: contract.kind,
  description: contract.description,
  effects: { ...contract.effects },
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

/** Canonical fixed resources exposed by every target-free MCP session. */
export const MCP_RESOURCE_CATALOG = [
  { name: "server-identity", uri: "rea://server/identity" },
  { name: "active-residual-unknowns", uri: "rea://unknowns/active" },
] as const;
/** Canonical resource templates exposed by every target-free MCP session. */
export const MCP_RESOURCE_TEMPLATE_CATALOG = [
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
  {
    name: "reconstruction-coverage-revision",
    uri_template:
      "rea://reconstruction-coverage/{workspaceId}/revision/{revision}",
  },
  {
    name: "javascript-application-graph-page",
    uri_template:
      "rea://evidence/{evidenceId}/application-graph/{collection}/offset/{offset}/limit/{limit}",
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
    mcp_resources: MCP_RESOURCE_CATALOG.length,
    mcp_resource_templates: MCP_RESOURCE_TEMPLATE_CATALOG.length,
  },
  digests: {
    tools_sha256: digest(toolCatalog),
    prompts_sha256: digest(promptCatalog),
    resources_sha256: digest({
      resourceCatalog: MCP_RESOURCE_CATALOG,
      resourceTemplateCatalog: MCP_RESOURCE_TEMPLATE_CATALOG,
    }),
    combined_sha256: digest({
      cli: CLI_COMMAND_NAMES,
      tools: toolCatalog,
      prompts: promptCatalog,
      resources: MCP_RESOURCE_CATALOG,
      resource_templates: MCP_RESOURCE_TEMPLATE_CATALOG,
    }),
  },
  tools: toolCatalog.map(({ name, surface, effects, annotations }) => ({
    name,
    surface,
    effects,
    annotations: {
      read_only: annotations.readOnlyHint ?? false,
      destructive: annotations.destructiveHint ?? false,
      idempotent: annotations.idempotentHint ?? false,
      open_world: annotations.openWorldHint ?? true,
    },
  })),
} as const;
