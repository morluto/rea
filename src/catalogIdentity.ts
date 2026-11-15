import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { contractsForToolFamilies } from "./contracts/toolFamilies.js";
import { promptsForToolFamilies } from "./contracts/promptToolFamilyScope.js";
import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import type { PromptContract } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import type { ToolContract } from "./contracts/toolContractTypes.js";
import { CLI_COMMAND_NAMES } from "./cliCommandNames.js";
import { compareUnicodeCodePoints } from "./domain/unicodeCodePointOrder.js";
import {
  advertisedInputJsonSchema,
  advertisedOutputJsonSchema,
} from "./contracts/toolSchemaMetadata.js";
import {
  describeAdvertisedTool,
  presentAdvertisedInput,
  type CompactInputSchemaPresentation,
} from "./contracts/compactInputSchema.js";
import { presentAdvertisedOutputSchema } from "./contracts/compactOutputSchema.js";
import {
  COMPACT_OUTPUT_SCHEMA_PRESENTATION,
  resolveMcpOutputSchemaProfile,
  type McpOutputSchemaProfile,
} from "./config/mcpOutputSchemaProfile.js";
import { COMPACT_INPUT_SCHEMA_PRESENTATION } from "./config/mcpInputSchemaProfile.js";
import { RECORDED_CATALOG_DIGEST_PROFILES } from "./recordedCatalogDigests.js";

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
    input_schema: advertisedInputJsonSchema(contract),
    output_schema: advertisedOutputJsonSchema(contract),
  }));

/** The compact input schema and the tool description carrying its guidance. */
const presentedInput = (
  description: string,
  schema: Record<string, unknown>,
  presentation: CompactInputSchemaPresentation,
) => {
  const input = presentAdvertisedInput(schema, presentation);
  return {
    description: describeAdvertisedTool(description, input.guidance),
    input_schema: input.schema,
  };
};

/** Advertised input for every tool; output stays canonical unless bounded. */
const presentToolCatalog = (
  catalog: ReturnType<typeof createToolCatalog>,
  presentation: CompactInputSchemaPresentation,
) =>
  catalog.map((tool) => ({
    ...tool,
    ...presentedInput(tool.description, tool.input_schema, presentation),
  }));

const presentOutputSchemas = (
  catalog: ReturnType<typeof presentToolCatalog>,
  outputSchemaProfile: McpOutputSchemaProfile,
) =>
  outputSchemaProfile === "compact"
    ? catalog.map((tool) => ({
        ...tool,
        output_schema: presentAdvertisedOutputSchema(
          tool.output_schema,
          COMPACT_OUTPUT_SCHEMA_PRESENTATION,
        ),
      }))
    : catalog;

const createPromptCatalog = (contracts: readonly PromptContract[]) =>
  contracts
    .map((contract) => ({
      name: contract.name,
      title: contract.title,
      description: contract.description,
      objective: contract.objective,
      arguments: contract.arguments,
      steps: contract.steps,
    }))
    .sort((left, right) => compareUnicodeCodePoints(left.name, right.name));

const sortByName = (
  contracts: readonly ToolContract[],
): readonly ToolContract[] =>
  [...contracts].sort((left, right) =>
    compareUnicodeCodePoints(left.name, right.name),
  );

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Catalog is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

const digestCatalogs = (
  catalog: ReturnType<typeof presentToolCatalog>,
  prompts: ReturnType<typeof createPromptCatalog>,
  outputSchemaProfile: McpOutputSchemaProfile,
) => {
  const tools = {
    output_schema_profile: outputSchemaProfile,
    catalog: presentOutputSchemas(catalog, outputSchemaProfile),
  };
  return {
    tools_sha256: digest(tools),
    prompts_sha256: digest(prompts),
    combined_sha256: digest({
      cli: CLI_COMMAND_NAMES,
      tools,
      prompts,
    }),
  } as const;
};

/**
 * Catalog digests over the given tool contracts. Exported so tests can prove
 * which contract fields the identity covers; production uses
 * {@link DEFAULT_CATALOG_IDENTITY}.
 */
export const createCatalogDigests = (
  contracts: readonly ToolContract[] = TOOL_CONTRACTS,
  promptContracts: readonly PromptContract[] = PROMPT_CONTRACTS,
  compactPresentation: CompactInputSchemaPresentation = COMPACT_INPUT_SCHEMA_PRESENTATION,
  outputSchemaProfile: McpOutputSchemaProfile = resolveMcpOutputSchemaProfile(
    undefined,
  ),
) =>
  digestCatalogs(
    presentToolCatalog(
      createToolCatalog(sortByName(contracts)),
      compactPresentation,
    ),
    createPromptCatalog(promptContracts),
    outputSchemaProfile,
  );

export type CatalogDigests = ReturnType<typeof digestCatalogs>;
export type CatalogDigestProfiles = Readonly<
  Record<McpOutputSchemaProfile, CatalogDigests>
>;

/** Build-time identities share schema conversion across both output profiles. */
export const createCatalogDigestProfiles = (
  contracts: readonly ToolContract[] = TOOL_CONTRACTS,
  promptContracts: readonly PromptContract[] = PROMPT_CONTRACTS,
): CatalogDigestProfiles => {
  const catalog = presentToolCatalog(
    createToolCatalog(sortByName(contracts)),
    COMPACT_INPUT_SCHEMA_PRESENTATION,
  );
  const prompts = createPromptCatalog(promptContracts);
  return {
    off: digestCatalogs(catalog, prompts, "off"),
    compact: digestCatalogs(catalog, prompts, "compact"),
  };
};

/** One catalog identity: advertised presentation, contract and prompt scope, output profile. */
export interface CatalogIdentityOptions {
  readonly compactPresentation?: CompactInputSchemaPresentation | undefined;
  readonly contracts?: readonly ToolContract[] | undefined;
  readonly outputSchemaProfile?: McpOutputSchemaProfile | undefined;
  readonly promptContracts?: readonly PromptContract[] | undefined;
}

export const createCatalogIdentity = (options: CatalogIdentityOptions = {}) => {
  const {
    compactPresentation = COMPACT_INPUT_SCHEMA_PRESENTATION,
    contracts = TOOL_CONTRACTS,
    outputSchemaProfile = resolveMcpOutputSchemaProfile(undefined),
    promptContracts = PROMPT_CONTRACTS,
  } = options;
  const selectedPresentation = { budgetBytes: compactPresentation.budgetBytes };
  // Recorded digests describe the complete catalog at the built-in budget
  // only; a scoped tool or prompt set, or a custom budget, computes from its
  // own inputs on first use.
  let catalogDigests: CatalogDigests | undefined =
    selectedPresentation.budgetBytes !==
      COMPACT_INPUT_SCHEMA_PRESENTATION.budgetBytes ||
    contracts !== TOOL_CONTRACTS ||
    promptContracts !== PROMPT_CONTRACTS
      ? undefined
      : RECORDED_CATALOG_DIGEST_PROFILES?.[outputSchemaProfile];
  return {
    counts: {
      cli_commands: CLI_COMMAND_NAMES.length,
      mcp_tools: contracts.length,
      mcp_prompts: promptContracts.length,
    },
    get digests() {
      return (catalogDigests ??= createCatalogDigests(
        contracts,
        promptContracts,
        selectedPresentation,
        outputSchemaProfile,
      ));
    },
  } as const;
};

/** Default MCP advertisement: compact input, output schemas omitted. */
export const DEFAULT_CATALOG_IDENTITY = createCatalogIdentity();

/**
 * Identity whose digests cover exactly the contracts a registration advertises.
 * Composition reuses it when a deferred server attaches its runtime, so both
 * paths derive the same value from the same scope.
 */
export const catalogIdentityForToolFamilies = (
  compactPresentation: CompactInputSchemaPresentation,
  outputSchemaProfile: McpOutputSchemaProfile,
  advertisedToolFamilies: ReadonlySet<string> | undefined,
): ReturnType<typeof createCatalogIdentity> =>
  compactPresentation.budgetBytes ===
    COMPACT_INPUT_SCHEMA_PRESENTATION.budgetBytes &&
  outputSchemaProfile === resolveMcpOutputSchemaProfile(undefined) &&
  advertisedToolFamilies === undefined
    ? DEFAULT_CATALOG_IDENTITY
    : createCatalogIdentity({
        compactPresentation: { budgetBytes: compactPresentation.budgetBytes },
        contracts: contractsForToolFamilies(advertisedToolFamilies),
        outputSchemaProfile,
        promptContracts: promptsForToolFamilies(advertisedToolFamilies),
      });
