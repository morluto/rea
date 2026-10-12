import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import { CLI_COMMAND_NAMES } from "./cliCommandNames.js";
import { compareUnicodeCodePoints } from "./domain/unicodeCodePointOrder.js";

const sortedToolContracts = [...TOOL_CONTRACTS].sort((left, right) =>
  compareUnicodeCodePoints(left.name, right.name),
);

const createToolCatalog = () =>
  sortedToolContracts.map((contract) => ({
    name: contract.name,
    title: contract.title,
    surface: contract.kind,
    description: contract.description,
    effects: { ...contract.effects },
    annotations: contract.annotations,
    input_schema: {
      type: "object",
      ...z.toJSONSchema(contract.inputSchema, {
        unrepresentable: "any",
      }),
    },
    output_schema: {
      type: "object",
      ...z.toJSONSchema(contract.outputSchema, {
        unrepresentable: "any",
      }),
    },
  }));

const promptCatalog = PROMPT_CONTRACTS.map((contract) => ({
  name: contract.name,
  title: contract.title,
  description: contract.description,
  arguments: contract.arguments,
  steps: contract.steps,
})).sort((left, right) => compareUnicodeCodePoints(left.name, right.name));

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Catalog is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

const createCatalogDigests = () => {
  const tools = createToolCatalog();
  return {
    tools_sha256: digest(tools),
    prompts_sha256: digest(promptCatalog),
    combined_sha256: digest({
      cli: CLI_COMMAND_NAMES,
      tools,
      prompts: promptCatalog,
    }),
  } as const;
};

let catalogDigests: ReturnType<typeof createCatalogDigests> | undefined;

/** Stable, schema-sensitive identity; schema digests are computed on first use. */
export const CATALOG_IDENTITY = {
  counts: {
    cli_commands: CLI_COMMAND_NAMES.length,
    mcp_tools: sortedToolContracts.length,
    mcp_prompts: promptCatalog.length,
  },
  get digests() {
    return (catalogDigests ??= createCatalogDigests());
  },
} as const;
