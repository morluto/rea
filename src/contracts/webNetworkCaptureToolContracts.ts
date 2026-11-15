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
import { webNetworkCaptureSummaryViewResultSchema } from "../domain/analysisView/analysisViewResult.js";

/** Historical inspection is distinct from live browser capture and runtime authority. */
export const WEB_NETWORK_CAPTURE_TOOL_CONTRACTS = [
  {
    name: "inspect_web_network_capture",
    ...toolContractMetadata("inspect_web_network_capture"),
    description:
      "Inspect a saved local HAR 1.2, mitmproxy, Fiddler SAZ or supported aioquic qlog capture without contacting recorded URLs. Returns source-linked records, preserved producer fields, precise numbers, exposed bytes and explicit coverage/limitations; transport credentials and explicitly marked sensitive values are excluded. Use inspect_web_page for a live CDP page. Preserve capture_path exactly as supplied; it names a path on the REA host, not a path to rebase onto the client workspace. Select format; record_ordinals selects records after full decoding and also decodes recognized protobuf/gRPC bodies. Optional protobuf selects body_pointers, framing and a local FileDescriptorSet/message_type; native gRPC and gRPC-web remain distinct, ambiguous readings stay candidates and compressed payloads stay unknown. Default complete delivery is inline. detail summary retains Evidence for inspect_analysis_view kind capture (preview/complete), protobuf (bodies/frames/fields), or qlog; large text/schema values require explicit fields. Qlog supports aioquic 1.5.0 JSON qlog 0.3 and reports STREAM interval unions/endpoint loss declarations, not recovered bodies or proved network loss. SAZ preserves encoded bytes without replay/HAR conversion; encrypted archives are unsupported. Mitmproxy requires caller-supplied mitmdump 12.2.3 on Linux. Malformed or oversized captures return no partial success; browser transaction attribution and HAR text’s original bytes remain unknown.",
    kind: "application",
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
