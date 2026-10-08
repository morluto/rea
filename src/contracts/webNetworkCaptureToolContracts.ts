import {
  inspectWebNetworkCaptureInputSchema,
  webNetworkCaptureSchema,
} from "../domain/webNetworkCapture.js";
import type { ToolContract } from "./toolContracts.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemas.js";

/** Historical inspection is distinct from live browser capture and runtime authority. */
export const WEB_NETWORK_CAPTURE_TOOL_CONTRACTS = [
  {
    name: "inspect_web_network_capture",
    ...toolContractMetadata("inspect_web_network_capture"),
    description:
      "Inspect retained local HAR 1.2 or native mitmproxy capture records without contacting recorded URLs. Returns original ordinals, pointers/byte ranges, preserved producer fields, precise numeric representations and exact exposed binary bytes inline. Excludes known transport credentials and explicitly marked values. Decodes every record before optional ordinal selection; malformed or oversized captures return no partial success. Duplicate HAR members are invalid; prototype-named __proto__ members are preserved as ordinary own properties. Uses pinned upstream parsers, owned temporary files and bounded offline processes. Native mitmproxy requires caller-supplied mitmdump 12.2.3 on Linux. Browser transaction IDs, runtime attribution and original bytes of HAR Unicode text remain unknown.",
    kind: "browser-provider",
    inputSchema: inspectWebNetworkCaptureInputSchema,
    outputSchema: evidenceResultOf(webNetworkCaptureSchema),
    examples: [
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
