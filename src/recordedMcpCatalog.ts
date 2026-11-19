import type {
  Implementation,
  Prompt,
  ServerCapabilities,
  Tool,
} from "@modelcontextprotocol/server";
import type { createCatalogIdentity } from "./contracts/catalog/catalogIdentity.js";
import type { PromptArgumentContract } from "./contracts/promptContracts.js";

/** Build-owned discovery data; canonical validators remain the runtime authority. */
export interface RecordedMcpCatalog {
  readonly version: 1;
  readonly info: Implementation;
  readonly capabilities: ServerCapabilities;
  readonly instructions: string;
  readonly identity: ReturnType<typeof createCatalogIdentity>;
  /** Output projections precede the SDK's negotiated root-result codec. */
  readonly tools: readonly Tool[];
  /** Tool names derived from canonical Evidence-input declarations at build time. */
  readonly evidenceReferenceAlternatives: readonly string[];
  readonly prompts: readonly (Prompt & {
    readonly parameters: Readonly<Record<string, PromptArgumentContract>>;
  })[];
}

/** Replaced after compilation by the recorder; source runs use eager composition. */
export const RECORDED_MCP_CATALOG_SHA256: string | undefined = undefined;
