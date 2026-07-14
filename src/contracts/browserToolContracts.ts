import type { ToolContract } from "./toolContracts.js";
import { evidenceSchema } from "../domain/evidence.js";
import {
  browserTargetListSchema,
  inspectWebPageInputSchema,
  listBrowserTargetsInputSchema,
  webPageInspectionSchema,
} from "../domain/browserObservation.js";

const evidenceResult = (schema: typeof browserTargetListSchema) =>
  evidenceSchema
    .omit({ normalized_result: true })
    .extend({ normalized_result: schema });
const listOutputSchema = evidenceResult(browserTargetListSchema);
const inspectionOutputSchema = evidenceSchema
  .omit({ normalized_result: true })
  .extend({ normalized_result: webPageInspectionSchema });

const endpoint = "http://127.0.0.1:9222";
const origin = "https://app.example.test";

/** Origin-scoped, passive browser reverse-engineering contracts. */
export const BROWSER_TOOL_CONTRACTS = [
  {
    name: "list_browser_targets",
    description:
      "List bounded page targets from an approved user-owned loopback Chrome DevTools Protocol endpoint. Only targets whose current URL matches an approved exact origin are returned; URL credentials, query values, and fragments are redacted.",
    kind: "browser-provider",
    inputSchema: listBrowserTargetsInputSchema,
    outputSchema: listOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    examples: [
      {
        title: "List approved browser page targets",
        input: {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          approved: true,
          offset: 0,
          limit: 100,
        },
      },
    ],
  },
  {
    name: "inspect_web_page",
    description:
      "Passively inspect one approved page target through CDP without evaluating JavaScript, navigating, clicking, closing, or mutating the page. Returns bounded DOM structure, accessibility, scripts, resources, attach-window network and console metadata, workers, and redacted storage inventory as Evidence v2.",
    kind: "browser-provider",
    inputSchema: inspectWebPageInputSchema,
    outputSchema: inspectionOutputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    examples: [
      {
        title: "Inspect one approved browser page",
        input: {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          approved: true,
          target_id: "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
          observation_ms: 500,
          include_script_sources: false,
          include_storage_keys: false,
          limits: {
            max_frames: 200,
            max_dom_nodes: 2_000,
            max_ax_nodes: 2_000,
            max_scripts: 200,
            max_resources: 2_000,
            max_workers: 500,
            max_storage_keys: 1_000,
            max_script_source_bytes: 1_048_576,
            max_total_script_source_bytes: 4_194_304,
            max_network_events: 1_000,
            max_console_events: 200,
            max_websocket_events: 500,
          },
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
