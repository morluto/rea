import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { digestSchema } from "../digests.js";

/**
 * Caller intent for packet-capture analysis through caller-supplied tshark
 * and capinfos. REA never installs Wireshark or its tools.
 */
export const pcapInputSchemas = {
  inspect_pcap_client: z.strictObject({}),
  inspect_pcap_capture: z.strictObject({
    path: localPathStringSchema.describe(
      "Local pcap or pcapng capture file to inspect",
    ),
  }),
} as const;

/** Supported pcap-backed operations. */
export type PcapOperation = keyof typeof pcapInputSchemas;
/** Validated pcap requests carry their selected operation. */
export type PcapRequest = {
  [Name in PcapOperation]: {
    operation: Name;
    input: z.infer<(typeof pcapInputSchemas)[Name]>;
  };
}[PcapOperation];

/** Validate operation and input together so their types remain correlated. */
export const pcapRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_pcap_client"),
    input: pcapInputSchemas.inspect_pcap_client,
  }),
  z.strictObject({
    operation: z.literal("inspect_pcap_capture"),
    input: pcapInputSchemas.inspect_pcap_capture,
  }),
]);

const client = z.strictObject({
  tshark_command: z.string().min(1),
  tshark_source: z.enum(["environment", "path"]),
  tshark_version: z.string().min(1).nullable(),
  capinfos_command: z.string().min(1),
  capinfos_source: z.enum(["environment", "path"]),
  capinfos_version: z.string().min(1).nullable(),
});

const endpoint = z.strictObject({
  address: z.string().min(1),
  port: z.number().int().positive().nullable(),
  packet_count: z.number().int().positive(),
});

const dnsQuery = z.strictObject({
  query: z.string().min(1),
  response_addresses: z.array(z.string().min(1)),
  response_address_count: z.number().int().nonnegative(),
});

const protocolCount = z.strictObject({
  protocol: z.string().min(1),
  packet_count: z.number().int().positive(),
});

/** Portable pcap observations with explicit coverage limitations. */
export const pcapResultSchemas = {
  inspect_pcap_client: z.strictObject({
    client,
  }),
  inspect_pcap_capture: z.strictObject({
    client,
    target: z.strictObject({
      path: localPathStringSchema,
      bytes: z.number().int().nonnegative(),
      sha256: digestSchema,
    }),
    /** File format as capinfos reports it (pcap vs pcapng). */
    file_type: z.string().min(1).nullable(),
    encapsulation: z.string().min(1).nullable(),
    packet_count: z.number().int().nonnegative().nullable(),
    capture_start: z.string().nullable(),
    capture_end: z.string().nullable(),
    capture_duration_seconds: z.number().nonnegative().nullable(),
    snapshot_length: z.number().int().positive().nullable(),
    /** Distinct endpoints with packet counts, bounded. */
    endpoints: z.array(endpoint),
    endpoint_count: z.number().int().nonnegative(),
    /** DNS queries with resolved addresses, bounded. */
    dns_queries: z.array(dnsQuery),
    dns_query_count: z.number().int().nonnegative(),
    /** TLS Server Name Indication values observed in handshakes. */
    tls_sni_values: z.array(z.string().min(1)),
    tls_sni_count: z.number().int().nonnegative(),
    /** Protocol distribution (frame.protocols column counts). */
    protocol_distribution: z.array(protocolCount),
    protocol_count: z.number().int().nonnegative(),
    /** HTTP request URIs seen on plain-text ports, bounded. */
    http_request_uris: z.array(z.string().min(1)),
    http_request_uri_count: z.number().int().nonnegative(),
    http_uri_redaction_count: z.number().int().nonnegative(),
    unattributed_dns_addresses: z.array(z.string().min(1)),
    unattributed_dns_address_count: z.number().int().nonnegative(),
    unattributed_dns_packet_count: z.number().int().nonnegative(),
    coverage: z.enum(["complete", "partial"]),
    diagnostics: z
      .strictObject({ capinfos_stderr: z.string(), tshark_stderr: z.string() })
      .optional(),
  }),
} as const;
