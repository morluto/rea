import type {
  Implementation,
  Prompt,
  ServerCapabilities,
  Tool,
} from "@modelcontextprotocol/server";
import type { createCatalogIdentity } from "./contracts/catalog/catalogIdentity.js";
import type { PromptArgumentContract } from "./contracts/promptContracts.js";
import type { ToolFamilyId } from "./contracts/toolFamilyIds.js";

/** Build-owned discovery data; canonical validators remain the runtime authority. */
export interface RecordedMcpCatalog {
  readonly version: 1;
  readonly info: Implementation;
  readonly capabilities: ServerCapabilities;
  readonly instructions: string;
  readonly identity: ReturnType<typeof createCatalogIdentity>;
  /** Private result-codec projections; binary_session retains its schema for doctor. */
  readonly tools: readonly Tool[];
  readonly toolFamilies: Readonly<Record<string, ToolFamilyId>>;
  readonly promptRequirements: Readonly<Record<string, readonly string[]>>;
  /** Tool names derived from canonical Evidence-input declarations at build time. */
  readonly evidenceReferenceAlternatives: readonly string[];
  readonly prompts: readonly (Prompt & {
    readonly parameters: Readonly<Record<string, PromptArgumentContract>>;
  })[];
}

/** Replaced after compilation by the recorder; source runs use eager composition. */
export const RECORDED_MCP_CATALOG_SHA256: string | undefined = undefined;
