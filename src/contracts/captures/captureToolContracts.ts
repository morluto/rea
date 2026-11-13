import {
  inspectPacketFieldsInputSchema,
  packetFieldsCatalogSchema,
} from "../../domain/captures/packetFields.js";
import {
  inspectPacketCaptureInputSchema,
  packetCaptureSchema,
} from "../../domain/captures/packetCapture.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
export const CAPTURE_TOOL_CONTRACTS = [
  {
    name: "inspect_packet_fields",
    ...toolContractMetadata("inspect_packet_fields"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Find protocols or field definitions registered in installed TShark 4.x. kind defaults to protocols; use fields with an optional exact protocol abbreviation, then pass selected names to inspect_packet_capture. query is a case-insensitive literal substring. Returns definitions, duplicate registrations, source lines, tool identity and coverage; offset/limit pages matches (default 50; null means all remaining). Requires Linux, prlimit and TShark on PATH or absolute REA_TSHARK_COMMAND. Each call rereads the glossary. No capture/target is needed; registrations describe capabilities, not observed traffic.",
    inputSchema: inspectPacketFieldsInputSchema,
    outputSchema: evidenceResultOf(packetFieldsCatalogSchema),
    examples: [
      { title: "Find USB protocol registrations", input: { query: "usb" } },
      {
        title: "Find the installed USB vendor-ID field",
        input: { kind: "fields", protocol: "usb", query: "idVendor" },
      },
    ],
  },
  {
    name: "inspect_packet_capture",
    ...toolContractMetadata("inspect_packet_capture"),
    kind: "artifact-provider",
    requiresActiveTarget: true,
    description:
      "Extract caller-selected TShark fields from a saved packet capture, with display filters, decode-as rules and pass mode preserved. Returns frame numbers, repeated values, coverage and diagnostics; use inspect_pcap_capture for a prepared endpoint/DNS/TLS/HTTP summary. Defaults to 50 matching frames; match_offset/match_limit page output and null requests all remaining. packet_limit counts input packets before filtering; output paging does not shorten dissection or reassembly. Requires Linux, prlimit and TShark 4.x on PATH or absolute REA_TSHARK_COMMAND. No live capture/device communication; no matches does not prove absence of traffic.",
    inputSchema: inspectPacketCaptureInputSchema,
    outputSchema: evidenceResultOf(packetCaptureSchema),
    examples: [
      {
        title: "Inspect UDP exchanges in a recording",
        input: {
          path: "/artifacts/device.pcapng",
          fields: ["ip.addr", "udp.port", "data.data"],
          display_filter: "udp",
          decode_as: [],
          packet_limit: null,
          two_pass: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
