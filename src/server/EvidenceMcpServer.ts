import type {
  Implementation,
  McpServerOptions,
} from "@modelcontextprotocol/server";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  catalogIdentityForToolFamilies,
  type createCatalogIdentity,
} from "../contracts/catalog/catalogIdentity.js";
import { toolFamilyId } from "../contracts/toolFamilies.js";
import { isToolFamilyAdvertised } from "../contracts/toolFamilyIds.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import { EvidenceMcpServerCore } from "./EvidenceMcpServerCore.js";
import type { CompactInputSchemaPresentation } from "../contracts/compactInputSchema.js";
import {
  resolveMcpOutputSchemaProfile,
  type McpOutputSchemaProfile,
  COMPACT_INPUT_SCHEMA_PRESENTATION,
} from "../contracts/mcpSchemaPresentation.js";
import {
  DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET,
  type McpToolsListPageBudget,
} from "../config/mcpToolsListPageBudget.js";

/** Canonical composition retains the constructor's existing identity defaults. */
export class EvidenceMcpServer extends EvidenceMcpServerCore {
  constructor(
    info: Implementation,
    options: McpServerOptions,
    recordEvidence: EvidenceWriter["recordEvidence"] | undefined,
    delivery: ToolResultDelivery,
    compactPresentation: CompactInputSchemaPresentation = COMPACT_INPUT_SCHEMA_PRESENTATION,
    outputSchemaProfile: McpOutputSchemaProfile = resolveMcpOutputSchemaProfile(
      undefined,
    ),
    identity?: ReturnType<typeof createCatalogIdentity>,
    advertisedToolFamilies: ReadonlySet<string> | undefined = undefined,
    toolsListPageBudget: McpToolsListPageBudget = DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET,
  ) {
    super(
      info,
      options,
      recordEvidence,
      delivery,
      compactPresentation,
      outputSchemaProfile,
      identity ??
        catalogIdentityForToolFamilies(
          compactPresentation,
          outputSchemaProfile,
          advertisedToolFamilies,
        ),
      advertisedToolFamilies,
      toolsListPageBudget,
    );
  }

  /**
   * Out-of-scope tools stay registered but disabled: `tools/list` omits them
   * and calls fail with the SDK's disabled-tool error, so status reports
   * cannot direct agents to calls that always fail.
   */
  override advertisesTool(name: string): boolean {
    return isToolFamilyAdvertised(
      this.advertisedToolFamilies,
      toolFamilyId(name),
    );
  }
}
