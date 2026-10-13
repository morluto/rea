import { createHash } from "node:crypto";

import canonicalize from "canonicalize";
import { z } from "zod";

import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import type { ToolContract } from "./contracts/toolContractTypes.js";
import { CLI_COMMAND_NAMES } from "./cliCommandNames.js";
import { compareUnicodeCodePoints } from "./domain/unicodeCodePointOrder.js";

const sortByName = (
  contracts: readonly ToolContract[],
): readonly ToolContract[] =>
  [...contracts].sort((left, right) =>
    compareUnicodeCodePoints(left.name, right.name),
  );

const sortedToolContracts = sortByName(TOOL_CONTRACTS);

/**
 * Digested per-tool projection. Every contract field that changes what a
 * client receives belongs here, including `returns_target_content`: a server
 * that predates the untrusted-content framing must not digest equal to one
 * that emits `_meta.provenance`, or a stale process would report aligned.
 */
const createToolCatalog = (contracts: readonly ToolContract[]) =>
  contracts.map((contract) => ({
    name: contract.name,
    title: contract.title,
    surface: contract.kind,
    description: contract.description,
    effects: { ...contract.effects },
    returns_target_content: contract.returnsTargetContent,
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

/**
 * Catalog digests over the given tool contracts. Exported so tests can prove
 * which contract fields the identity covers; production uses
 * {@link CATALOG_IDENTITY}.
 */
export const createCatalogDigests = (
  contracts: readonly ToolContract[] = TOOL_CONTRACTS,
) => {
  const tools = createToolCatalog(sortByName(contracts));
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
