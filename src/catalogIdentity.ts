import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import type { PromptContract } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import type { ToolContract } from "./contracts/toolContractTypes.js";
import { CLI_COMMAND_NAMES } from "./cliCommandNames.js";
import { compareUnicodeCodePoints } from "./domain/unicodeCodePointOrder.js";
import {
  advertisedInputJsonSchema,
  toolOutputSchemaWithMetadata,
} from "./contracts/toolSchemaMetadata.js";
import {
  presentAdvertisedInputSchema,
  type CompactInputSchemaPresentation,
} from "./contracts/compactInputSchema.js";
import { resolveMcpOutputSchemaProfile } from "./config/mcpOutputSchemaProfile.js";
import type { McpOutputSchemaProfile } from "./config/mcpOutputSchemaProfile.js";
import {
  COMPACT_INPUT_SCHEMA_BUDGET_BYTES,
  compactPresentationForMcpInputSchemaProfile,
  type McpInputSchemaProfile,
} from "./config/mcpInputSchemaProfile.js";
import { RECORDED_CATALOG_DIGEST_PROFILES } from "./recordedCatalogDigests.js";

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
    input_schema: advertisedInputJsonSchema(contract),
    output_schema: toolOutputSchemaWithMetadata(contract)[
      "~standard"
    ].jsonSchema.output({ target: "draft-2020-12" }),
  }));

const presentToolCatalog = (
  catalog: ReturnType<typeof createToolCatalog>,
  presentation: CompactInputSchemaPresentation | undefined,
) =>
  presentation === undefined
    ? catalog
    : catalog.map((tool) => ({
        ...tool,
        input_schema: presentAdvertisedInputSchema(
          tool.input_schema,
          presentation,
        ),
      }));

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

const promptCatalog = createPromptCatalog(PROMPT_CONTRACTS);

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Catalog is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

const digestCatalogs = (
  catalog: ReturnType<typeof createToolCatalog>,
  prompts: ReturnType<typeof createPromptCatalog>,
  outputSchemaProfile: McpOutputSchemaProfile,
) => {
  const tools = {
    output_schema_profile: outputSchemaProfile,
    catalog,
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
 * {@link FULL_CATALOG_IDENTITY}.
 */
export const createCatalogDigests = (
  contracts: readonly ToolContract[] = TOOL_CONTRACTS,
  promptContracts: readonly PromptContract[] = PROMPT_CONTRACTS,
  compactPresentation: CompactInputSchemaPresentation | undefined = undefined,
  outputSchemaProfile: McpOutputSchemaProfile = "full",
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
  Record<
    McpInputSchemaProfile,
    Readonly<Record<McpOutputSchemaProfile, CatalogDigests>>
  >
>;

/** Build-time identities share schema conversion across the four supported profiles. */
export const createCatalogDigestProfiles = (
  contracts: readonly ToolContract[] = TOOL_CONTRACTS,
  promptContracts: readonly PromptContract[] = PROMPT_CONTRACTS,
): CatalogDigestProfiles => {
  const full = createToolCatalog(sortByName(contracts));
  const compact = presentToolCatalog(full, {
    budgetBytes: COMPACT_INPUT_SCHEMA_BUDGET_BYTES,
  });
  const prompts = createPromptCatalog(promptContracts);
  const outputProfiles = (catalog: typeof full) => ({
    full: digestCatalogs(catalog, prompts, "full"),
    off: digestCatalogs(catalog, prompts, "off"),
  });
  return { full: outputProfiles(full), compact: outputProfiles(compact) };
};

export const createCatalogIdentity = (
  compactPresentation: CompactInputSchemaPresentation | undefined = undefined,
  outputSchemaProfile: McpOutputSchemaProfile = "full",
) => {
  const selectedPresentation =
    compactPresentation === undefined
      ? undefined
      : { budgetBytes: compactPresentation.budgetBytes };
  // Only the exact built-in presentations have build-time identities. Source
  // runs and custom budgets still compute from their selected schemas lazily.
  const inputProfile =
    selectedPresentation === undefined
      ? "full"
      : selectedPresentation.budgetBytes === COMPACT_INPUT_SCHEMA_BUDGET_BYTES
        ? "compact"
        : undefined;
  let catalogDigests: CatalogDigests | undefined =
    inputProfile === undefined
      ? undefined
      : RECORDED_CATALOG_DIGEST_PROFILES?.[inputProfile][outputSchemaProfile];
  return {
    counts: {
      cli_commands: CLI_COMMAND_NAMES.length,
      mcp_tools: sortedToolContracts.length,
      mcp_prompts: promptCatalog.length,
    },
    get digests() {
      return (catalogDigests ??= createCatalogDigests(
        TOOL_CONTRACTS,
        PROMPT_CONTRACTS,
        selectedPresentation,
        outputSchemaProfile,
      ));
    },
  } as const;
};

/**
 * Full input/output advertisement identity. Digests are recorded at build time
 * or computed on first use; this is independent of the configured default.
 */
export const FULL_CATALOG_IDENTITY = createCatalogIdentity();

/** Default MCP advertisement; explicit full/custom selections have their own identity. */
export const DEFAULT_CATALOG_IDENTITY = createCatalogIdentity(
  compactPresentationForMcpInputSchemaProfile(undefined),
  resolveMcpOutputSchemaProfile(undefined),
);
