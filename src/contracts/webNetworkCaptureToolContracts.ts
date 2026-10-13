import {
  inspectWebNetworkCaptureInputSchema,
  webNetworkCaptureSchema,
} from "../domain/webNetworkCapture.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import {
  analysisDetailSchema,
  analysisDetailOutputSchemaOf,
} from "./analysisDetail.js";
import { webNetworkCaptureSummaryViewResultSchema } from "../domain/analysisView/analysisView.js";

/** Historical inspection is distinct from live browser capture and runtime authority. */
export const WEB_NETWORK_CAPTURE_TOOL_CONTRACTS = [
  {
    name: "inspect_web_network_capture",
    ...toolContractMetadata("inspect_web_network_capture"),
    description:
      "Request detail summary for capture identity and counts; then page retained records with inspect_analysis_view kind capture (preview or complete), avoiding repeated decoding. Default detail complete preserves existing inline delivery. Inspect retained local HAR 1.2, native mitmproxy, Fiddler SAZ or aioquic 1.5.0 JSON qlog 0.3 events without contacting recorded URLs. Returns original ordinals, pointers/byte ranges/archive member names, preserved producer fields, precise numeric representations and exact exposed binary bytes inline. Excludes known transport credentials and explicitly marked values. Decodes every record before optional ordinal selection; malformed or oversized captures return no partial success. Duplicate JSON members are invalid; prototype-named members such as __proto__ are preserved as ordinary own JSON members without prototype mutation. Qlog reports trace-scoped STREAM interval unions and endpoint loss declarations; it does not recover bodies, prove network loss or correlate PCAP. Other qlog layouts are unsupported. Uses pinned upstream parsers, owned temporary files and bounded offline processes. SAZ preserves HTTP fields, XML metadata and encoded body/message bytes without replay or HAR conversion; encrypted archives are unsupported. Native mitmproxy requires caller-supplied mitmdump 12.2.3 on Linux. Browser transaction IDs, runtime attribution and original bytes of HAR Unicode text remain unknown.",
    kind: "browser-provider",
    inputSchema: inspectWebNetworkCaptureInputSchema.extend({
      detail: analysisDetailSchema,
    }),
    outputSchema: analysisDetailOutputSchemaOf(
      webNetworkCaptureSchema,
      webNetworkCaptureSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Inspect retained aioquic qlog events",
        input: {
          capture_path: "/captures/origin.qlog",
          format: "qlog",
          record_ordinals: [0, 2],
        },
      },
      {
        title: "Inspect historical HAR entries",
        input: {
          capture_path: "/captures/session.har",
          format: "har",
          record_ordinals: [0, 2],
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
