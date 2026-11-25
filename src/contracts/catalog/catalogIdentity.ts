import canonicalize from "canonicalize";

import { contractsForToolFamilies } from "../toolFamilies.js";
import { promptsForToolFamilies } from "../promptToolFamilyScope.js";
import { PROMPT_CONTRACTS } from "../promptContracts.js";
import type { PromptContract } from "../promptContracts.js";
import { TOOL_CONTRACTS } from "../toolContracts.js";
import type { ToolContract } from "../toolContractTypes.js";
import { CLI_COMMANDS, cliCommandFor } from "../cliCommandNames.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import {
  advertisedInputJsonSchema,
  advertisedOutputJsonSchema,
} from "../toolSchemaMetadata.js";
import type { CompactInputSchemaPresentation } from "../compactInputSchema.js";
import {
  advertiseTool,
  type AdvertisedToolPresentation,
} from "../advertisedTool.js";
import {
  RECORDED_CATALOG_DIGEST_PROFILES,
  type CatalogDigestProfiles,
  type CatalogDigests,
} from "./recordedCatalogDigests.js";
import {
  advertisedToolPresentation,
  resolveMcpOutputSchemaProfile,
  type McpOutputSchemaProfile,
  COMPACT_INPUT_SCHEMA_PRESENTATION,
} from "../mcpSchemaPresentation.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

/**
 * Digested per-tool projection. Every contract field that changes what a
 * client receives belongs here, including `returns_target_content`: a server
 * that predates the untrusted-content framing must not digest equal to one
 * that emits `_meta.provenance`, or a stale process would report aligned.
 */
/**
 * Primary CLI command inventory, aliases excluded: the command of every
 * contract that declares `cli: true`, in catalog order, then the commands no
 * contract names.
 */
export const cliCommandNames = (
  contracts: readonly Pick<ToolContract, "name" | "cli">[],
): readonly string[] =>
  Object.freeze([
    ...contracts.flatMap(({ name, cli }) =>
      cli === true ? [cliCommandFor(name)] : [],
    ),
    ...Object.values(CLI_COMMANDS),
  ]);

/** The primary CLI command inventory of the public contract registry. */
export const CLI_COMMAND_NAMES = cliCommandNames(TOOL_CONTRACTS);

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

/**
 * The identity's view of each tool: what the selected presentation
 * advertises. An omitted output advertisement still digests the canonical
 * reply contract the server validates.
 */
const presentToolCatalog = (
  catalog: ReturnType<typeof createToolCatalog>,
  presentation: AdvertisedToolPresentation,
) =>
  catalog.map((tool) => {
    const advertised = advertiseTool(
      {
        description: tool.description,
        inputSchema: tool.input_schema,
        outputSchema: tool.output_schema,
      },
      presentation,
    );
    return {
      ...tool,
      description: advertised.description ?? tool.description,
      input_schema: advertised.inputSchema ?? tool.input_schema,
      output_schema: advertised.outputSchema ?? tool.output_schema,
    };
  });

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

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Catalog is not canonical JSON");
  return encoded;
};

/** Hash a generated catalog projection using its strict canonical JSON representation. */
export const digestCatalogProjection = (value: unknown): string =>
  sha256Hex(canonicalJson(value));

/** Digests of the presented tool and prompt catalog. */
const digestPresentedCatalogs = (
  catalog: ReturnType<typeof presentToolCatalog>,
  prompts: ReturnType<typeof createPromptCatalog>,
  outputSchemaProfile: McpOutputSchemaProfile,
) => {
  const tools = canonicalJson({
    output_schema_profile: outputSchemaProfile,
    catalog,
  });
  const promptCatalog = canonicalJson(prompts);
  // RFC 8785 writes an object as its members in key order, each value in its
  // own canonical form, so the combined document reuses the canonical tool and
  // prompt texts instead of canonicalizing the whole catalog a second time.
  const combined = `{"cli":${canonicalJson(CLI_COMMAND_NAMES)},"prompts":${promptCatalog},"tools":${tools}}`;
  return {
    tools_sha256: sha256Hex(tools),
    prompts_sha256: sha256Hex(promptCatalog),
    combined_sha256: sha256Hex(combined),
  } as const;
};

const digestCatalogs = (
  catalog: ReturnType<typeof createToolCatalog>,
  prompts: ReturnType<typeof createPromptCatalog>,
  compactPresentation: CompactInputSchemaPresentation,
  outputSchemaProfile: McpOutputSchemaProfile,
) =>
  digestPresentedCatalogs(
    presentToolCatalog(
      catalog,
      advertisedToolPresentation(outputSchemaProfile, compactPresentation),
    ),
    prompts,
    outputSchemaProfile,
  );

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
    createToolCatalog(sortByName(contracts)),
    createPromptCatalog(promptContracts),
    compactPresentation,
    outputSchemaProfile,
  );

/** Build-time identities share schema conversion across both output profiles. */
export const createCatalogDigestProfiles = (
  contracts: readonly ToolContract[] = TOOL_CONTRACTS,
  promptContracts: readonly PromptContract[] = PROMPT_CONTRACTS,
): CatalogDigestProfiles => {
  const catalog = createToolCatalog(sortByName(contracts));
  const prompts = createPromptCatalog(promptContracts);
  return {
    off: digestCatalogs(
      catalog,
      prompts,
      COMPACT_INPUT_SCHEMA_PRESENTATION,
      "off",
    ),
    compact: digestCatalogs(
      catalog,
      prompts,
      COMPACT_INPUT_SCHEMA_PRESENTATION,
      "compact",
    ),
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
