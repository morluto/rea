import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import {
  analysisDetailOutputSchemaOf,
  analysisDetailSchema,
} from "./analysisDetail.js";
import { browserScenarioSummaryViewResultSchema } from "../domain/analysisView/analysisView.js";
import { browserScenarioInputSchema } from "../domain/browserScenario.js";
import { browserScenarioCaptureSchema } from "../domain/browserScenarioCapture.js";
import type { JsonValue } from "../domain/jsonValue.js";

const example: Record<string, JsonValue> = {
  browser: {
    mode: "launch",
    executable_path: "/opt/chromium/chrome",
  },
  start_url: { url: "https://app.example.test/", query: [] },
  actions: [
    {
      step_id: "settle",
      action: "wait_for_timeout",
      duration_ms: 250,
    },
  ],
};

/** Controlled browser scenario contract shared by MCP and catalog generation. */
export const BROWSER_SCENARIO_TOOL_CONTRACTS = [
  {
    name: "capture_browser_scenario",
    ...toolContractMetadata("capture_browser_scenario"),
    description:
      'Drive a browser scenario when passive observation cannot exercise the app. Launch the selected executable or connect to a loopback CDP target; actions can change application state and make network requests. Supply browser, start_url and actions, e.g. {browser:{mode:"launch",executable_path:"/opt/chromium/chrome"},start_url:{url:"https://app.example.test/"},actions:[{step_id:"settle",action:"wait_for_timeout",duration_ms:250}]}. Empty storage and a URL-only final capture are defaults. Request actions use page fetch on the start origin; capture.network independently opts into request_body, response_body and header_values. Credentials and declared secrets are redacted. capture.limits controls retained event/content budgets; omissions identify affected events/transactions. Actions wait for completion or cancellation; per-action timeout_ms bounds a step. Default complete delivery returns Evidence inline. detail summary retains it and returns step outcomes, final/first-unsuccessful accessibility, and counts; inspect_analysis_view kind browser-scenario pages steps, events, transactions and UTF-16 text. Use inspect_web_page for observation without actions.',
    kind: "browser-provider",
    inputSchema: browserScenarioInputSchema.extend({
      detail: analysisDetailSchema,
    }),
    outputSchema: analysisDetailOutputSchemaOf(
      browserScenarioCaptureSchema,
      browserScenarioSummaryViewResultSchema,
    ),
    examples: [
      { title: "Capture a deterministic browser scenario", input: example },
    ],
  },
] as const satisfies readonly ToolContract[];
