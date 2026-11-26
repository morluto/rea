import { z } from "zod";
import { knownCoverageStatusSchema } from "../coverage.js";
import {
  absoluteLocalPathStringSchema,
  localPathStringSchema,
} from "../localPath.js";
import { digestSchema } from "../digests.js";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import { analysisParameterLimitSchema } from "../analysisSettingDefinitions.js";

/** Summary capture admission and discovery share this native-bound host profile. */
export const pcapCaptureHostSupported = (platform: string): boolean =>
  platform === "linux" || platform === "win32";
export const PCAP_CAPTURE_UNSUPPORTED_HOST_REASON =
  "Packet summaries require an enforceable native memory bound: Linux with util-linux prlimit, or Windows with owned Job Objects. This host's capture boundary remains unsupported.";
/** Repair for an unsupported capture host; no setting on this host changes it. */
export const PCAP_CAPTURE_HOST_REMEDIATION =
  "Run packet-capture summaries on Linux with util-linux prlimit, or on Windows with owned Job Objects.";

/**
 * Decoded JSON work admitted across both tshark passes. It bounds the
 * in-process parse, so the tshark stdout budget cannot usefully exceed it.
 */
export const PCAP_TSHARK_DECODED_BYTES = 128 * 1024 * 1024;

/**
 * Per-call producer budgets for `inspect_pcap_capture`. `input_bytes` bounds
 * the owned capture snapshot, which is streamed to disk in fixed chunks, so
 * raising it costs disk, not memory. `output_bytes` bounds each tshark JSON
 * stdout that is buffered and parsed in memory; its maximum is the decoded
 * work allowance, which stays fixed.
 */
export const PCAP_PRODUCER_LIMITS = {
  input_bytes: 2 * 1024 ** 3,
  output_bytes: 8 * 1024 * 1024,
} as const;

/** The largest accepted value of each `inspect_pcap_capture` producer limit. */
export const PCAP_PRODUCER_LIMIT_MAXIMA = {
  input_bytes: Number.MAX_SAFE_INTEGER,
  output_bytes: PCAP_TSHARK_DECODED_BYTES,
} as const;

/**
 * One accepted `inspect_pcap_capture` producer limit, as a request parameter,
 * with the bytes the refused capture needs when they were measured.
 */
export const pcapProducerLimit = (
  field: keyof typeof PCAP_PRODUCER_LIMITS,
  effectiveValue: number,
  requiredValue?: number,
): AnalysisParameterLimit => ({
  control_kind: "parameter",
  parameter: `producer_limits.${field}`,
  effective_value: effectiveValue,
  unit: "bytes",
  minimum: 1,
  maximum: PCAP_PRODUCER_LIMIT_MAXIMA[field],
  default_value: PCAP_PRODUCER_LIMITS[field],
  applies_at: "next_call",
  ...(requiredValue === undefined ? {} : { required_value: requiredValue }),
});

const pcapProducerLimitsSchema = z
  .strictObject({
    input_bytes: z
      .int()
      .positive()
      .max(PCAP_PRODUCER_LIMIT_MAXIMA.input_bytes)
      .optional(),
    output_bytes: z
      .int()
      .positive()
      .max(PCAP_PRODUCER_LIMIT_MAXIMA.output_bytes)
      .optional(),
  })
  .optional()
  .describe(
    `Per-call producer limits in bytes. input_bytes bounds the private capture copy (default ${String(PCAP_PRODUCER_LIMITS.input_bytes)}); output_bytes bounds the combined stdout and stderr of each tshark JSON pass (default ${String(PCAP_PRODUCER_LIMITS.output_bytes)}, at most ${String(PCAP_PRODUCER_LIMIT_MAXIMA.output_bytes)}, the fixed decoded-JSON allowance). Omitted fields keep defaults; changes apply on the next call without restart.`,
  );

/**
 * Caller intent for packet-capture analysis through caller-supplied tshark
 * and capinfos. REA never installs Wireshark or its tools.
 */
export const pcapInputSchemas = {
  inspect_pcap_client: z.strictObject({}),
  inspect_pcap_capture: z.strictObject({
    path: absoluteLocalPathStringSchema.describe(
      "Absolute local pcap or pcapng capture file to inspect",
    ),
    producer_limits: pcapProducerLimitsSchema,
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
  tshark_resolved_path: localPathStringSchema.nullable(),
  tshark_sha256: digestSchema.nullable(),
  tshark_identity_status: z.enum(["verified", "unresolved"]),
  capinfos_command: z.string().min(1),
  capinfos_source: z.enum(["environment", "path"]),
  capinfos_version: z.string().min(1).nullable(),
  capinfos_resolved_path: localPathStringSchema.nullable(),
  capinfos_sha256: digestSchema.nullable(),
  capinfos_identity_status: z.enum(["verified", "unresolved"]),
});

const endpoint = z.strictObject({
  address: z.string().min(1),
  port: z.int().positive().nullable(),
  packet_count: z.int().positive(),
});

const dnsQuery = z.strictObject({
  query: z.string().min(1),
  query_labels_hex: z
    .array(z.string().regex(/^(?:[0-9a-f]{2}){1,63}$/u))
    .nullable()
    .describe(
      "Original DNS wire label bytes in order, as lowercase hex strings; the root terminator is excluded. Null means unknown wire identity; display text alone does not establish identity.",
    ),
  response_addresses: z.array(z.string().min(1)),
  response_address_count: z.int().nonnegative(),
});

const protocolCount = z.strictObject({
  protocol: z.string().min(1),
  packet_count: z.int().positive(),
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
      bytes: z.int().nonnegative(),
      sha256: digestSchema,
    }),
    /** File format as capinfos reports it (pcap vs pcapng). */
    file_type: z.string().min(1).nullable(),
    encapsulation: z.string().min(1).nullable(),
    packet_count: z.int().nonnegative().nullable(),
    capture_start: z.string().nullable(),
    capture_end: z.string().nullable(),
    capture_duration_seconds: z.number().nonnegative().nullable(),
    snapshot_length: z.int().positive().nullable(),
    /** Distinct endpoints with packet counts, bounded. */
    endpoints: z.array(endpoint),
    endpoint_count: z.int().nonnegative(),
    /** DNS queries with resolved addresses, bounded. */
    dns_queries: z.array(dnsQuery),
    dns_query_count: z.int().nonnegative(),
    /** TLS Server Name Indication values observed in handshakes. */
    tls_sni_values: z.array(z.string().min(1)),
    tls_sni_count: z.int().nonnegative(),
    /** Protocol distribution (frame.protocols column counts). */
    protocol_distribution: z.array(protocolCount),
    protocol_count: z.int().nonnegative(),
    /** HTTP request URIs seen on plain-text ports, bounded. */
    http_request_uris: z.array(z.string().min(1)),
    http_request_uri_count: z.int().nonnegative(),
    http_uri_redaction_count: z.int().nonnegative(),
    unattributed_dns_addresses: z.array(z.string().min(1)),
    unattributed_dns_address_count: z.int().nonnegative(),
    unattributed_dns_packet_count: z.int().nonnegative(),
    coverage: knownCoverageStatusSchema,
    /**
     * The producer limit that stopped the DNS wire-identity pass, when that
     * pass alone exceeded it; the summary is then partial and raising the
     * named control on the next call runs the pass.
     */
    dns_identity_limit: analysisParameterLimitSchema.optional(),
    diagnostics: z
      .strictObject({ capinfos_stderr: z.string(), tshark_stderr: z.string() })
      .optional(),
  }),
} as const;
