import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { parseRecordedTransportUrl } from "../domain/recordedTransportUrl.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";

const OPERATION = "inspect_pcap_capture";
/** Bounds JSON decoding plus its expanded object graph before JSON.parse. */
export const TSHARK_JSON_MAX_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;

const protocolFailure = (reason: string): never => {
  throw new AnalysisProtocolError(`Invalid packet-capture output: ${reason}`);
};

export interface CapinfosMetadata {
  readonly fileType: string;
  readonly encapsulation: string;
  readonly packetCount: number;
  readonly captureStart: string | null;
  readonly captureEnd: string | null;
  readonly captureDurationSeconds: number | null;
  readonly snapshotLength: number | null;
  readonly sha256: string | null;
}

/** capinfos -M with a C locale provides exact numbers instead of "20 k". */
export const parseCapinfosOutput = (stdout: string): CapinfosMetadata => {
  const lines = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const at = line.indexOf(":");
    if (at >= 0 && !/^\s/u.test(line))
      lines.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  const fileType = lines.get("File type");
  const encapsulation = lines.get("File encapsulation");
  const countText = lines.get("Number of packets");
  if (
    !fileType ||
    !encapsulation ||
    countText === undefined ||
    !/^\d+$/u.test(countText)
  )
    return protocolFailure(
      "capinfos did not provide machine-readable type, encapsulation and packet count",
    );
  const packetCount = Number(countText);
  if (!Number.isSafeInteger(packetCount))
    return protocolFailure("packet count is not representable");
  const durationText = lines.get("Capture duration");
  const duration =
    durationText === undefined
      ? null
      : /^(\d+(?:\.\d+)?)(?:\s+seconds?)?$/u.exec(durationText);
  const snapshot = /^file hdr:\s*(\d+) bytes$/u.exec(
    lines.get("Packet size limit") ?? "",
  );
  const snapshotLength = snapshot === null ? null : Number(snapshot[1]);
  const sha256 = lines.get("SHA256") ?? null;
  if (sha256 !== null && !/^[0-9a-f]{64}$/u.test(sha256))
    return protocolFailure("capinfos SHA256 is malformed");
  return {
    fileType,
    encapsulation,
    packetCount,
    captureStart: lines.get("Earliest packet time") ?? null,
    captureEnd: lines.get("Latest packet time") ?? null,
    captureDurationSeconds: duration === null ? null : Number(duration[1]),
    snapshotLength:
      snapshotLength !== null &&
      Number.isSafeInteger(snapshotLength) &&
      snapshotLength > 0
        ? snapshotLength
        : null,
    sha256,
  };
};

export interface TsharkFields {
  readonly endpoints: { address: string; port: null; packet_count: number }[];
  readonly endpointCount: number;
  readonly dnsQueries: {
    query: string;
    response_addresses: string[];
    response_address_count: number;
  }[];
  readonly dnsQueryCount: number;
  readonly tlsSniValues: string[];
  readonly tlsSniCount: number;
  readonly protocolDistribution: { protocol: string; packet_count: number }[];
  readonly protocolCount: number;
  readonly httpRequestUris: string[];
  readonly httpRequestUriCount: number;
  readonly httpUriRedactionCount: number;
  readonly unattributedDnsAddresses: string[];
  readonly unattributedDnsAddressCount: number;
  readonly unattributedDnsPackets: number;
  readonly packetCount: number;
  readonly partial: boolean;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate the fixed JSON field representation before retaining aggregate facts. */
export const parseTsharkJsonOutput = async (
  stdout: string,
  signal?: AbortSignal,
): Promise<TsharkFields> => {
  signal?.throwIfAborted();
  if (Buffer.byteLength(stdout) > TSHARK_JSON_MAX_BYTES)
    throw new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      "tshark JSON exceeds the bounded decoding budget",
      { max_json_bytes: TSHARK_JSON_MAX_BYTES },
    );
  // The selected-field protocol has five container levels. Reject deeper
  // graphs before materializing them; quoted brackets are string data.
  let depth = 0,
    quoted = false,
    escaped = false;
  let decodedBytes = stdout.length * 2;
  for (let index = 0; index < stdout.length; index += 1) {
    if (index % 65536 === 0) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    const char = stdout[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      decodedBytes += 64;
    } else if (char === "{" || char === "[") {
      decodedBytes += 128;
      if (++depth > 5) protocolFailure("unexpected JSON nesting");
    } else if (char === "}" || char === "]") depth -= 1;
    else if (char === ":" || char === ",") decodedBytes += 128;
    if (decodedBytes > MAX_DECODED_BYTES)
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        "tshark JSON expansion exceeds the decoding budget",
        { max_decoded_bytes: MAX_DECODED_BYTES },
      );
  }
  let packets: unknown;
  try {
    packets = JSON.parse(stdout) as unknown;
  } catch (cause) {
    throw new AnalysisProtocolError("tshark emitted malformed JSON", { cause });
  }
  if (!Array.isArray(packets))
    return protocolFailure("tshark packet root must be an array");
  const endpoints = new Map<string, number>();
  const dns = new Map<string, Set<string>>();
  const sni = new Set<string>();
  const protocols = new Map<string, number>();
  const uris = new Set<string>();
  const observedUris = new Set<string>();
  let uriRedactions = 0;
  const unattributed = new Set<string>();
  let unattributedPackets = 0;
  let retainedBytes = 0;
  const charge = (value: string): void => {
    retainedBytes += 192 + 2 * Buffer.byteLength(value);
    if (retainedBytes > MAX_RETAINED_BYTES)
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        "Packet inventory exceeds the retained-fact budget",
        { max_retained_bytes: MAX_RETAINED_BYTES },
      );
  };
  const add = (set: Set<string>, value: string): void => {
    if (!set.has(value)) {
      charge(value);
      set.add(value);
    }
  };
  for (let index = 0; index < packets.length; index += 1) {
    if (index % 256 === 0) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    const packet: unknown = packets[index];
    if (
      !object(packet) ||
      !object(packet._source) ||
      !object(packet._source.layers)
    )
      return protocolFailure(
        `packet ${String(index + 1)} lacks _source.layers`,
      );
    const layers = packet._source.layers;
    for (const [key, value] of Object.entries(layers))
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string")
      )
        return protocolFailure(
          `packet ${String(index + 1)} field ${key} must be an array of strings`,
        );
    const field = (name: string): readonly string[] =>
      (layers[name] as string[] | undefined) ?? [];
    const frame = field("frame.number");
    if (
      frame.length !== 1 ||
      !/^\d+$/u.test(frame[0]!) ||
      Number(frame[0]) !== index + 1
    )
      return protocolFailure(
        "frame inventory is missing, duplicated or out of order",
      );
    if (
      field("frame.protocols").length !== 1 ||
      field("frame.protocols")[0] === ""
    )
      return protocolFailure(
        "packet protocol inventory is missing or ambiguous",
      );
    // Count one occurrence per packet even for loopback or nested IP layers.
    for (const address of new Set([
      ...field("ip.src"),
      ...field("ip.dst"),
      ...field("ipv6.src"),
      ...field("ipv6.dst"),
    ])) {
      if (address === "") continue;
      if (!endpoints.has(address)) charge(address);
      endpoints.set(address, (endpoints.get(address) ?? 0) + 1);
    }
    const questions = new Set(
      field("dns.qry.name").filter((value) => value !== ""),
    );
    for (const question of questions)
      if (!dns.has(question)) {
        charge(question);
        dns.set(question, new Set());
      }
    const addresses = [...field("dns.a"), ...field("dns.aaaa")].filter(
      (value) => value !== "",
    );
    const response = field("dns.flags.response");
    if (addresses.length > 0) {
      if (
        questions.size === 1 &&
        response.length > 0 &&
        response.every((value) => value === "True" || value === "1")
      ) {
        const values = dns.get(questions.values().next().value!)!;
        for (const address of addresses) add(values, address);
      } else {
        unattributedPackets += 1;
        for (const address of addresses) add(unattributed, address);
      }
    }
    for (const value of field("tls.handshake.extensions_server_name"))
      if (value !== "") add(sni, value);
    for (const value of new Set(field("frame.protocols"))) {
      if (value === "") continue;
      if (!protocols.has(value)) charge(value);
      protocols.set(value, (protocols.get(value) ?? 0) + 1);
    }
    for (const value of field("http.request.full_uri")) {
      if (value === "" || observedUris.has(value)) continue;
      add(observedUris, value);
      const { credentials } = parseRecordedTransportUrl(value);
      if (credentials !== null) uriRedactions += 1;
      if (credentials === "ambiguous") continue;
      add(
        uris,
        credentials === null
          ? value
          : value.slice(0, credentials.start) + value.slice(credentials.end),
      );
    }
  }
  signal?.throwIfAborted();
  return {
    endpoints: [...endpoints]
      .sort((a, b) => b[1] - a[1] || compareUnicodeCodePoints(a[0], b[0]))
      .map(([address, packet_count]) => ({
        address,
        port: null,
        packet_count,
      })),
    endpointCount: endpoints.size,
    dnsQueries: [...dns].map(([query, addresses]) => ({
      query,
      response_addresses: [...addresses],
      response_address_count: addresses.size,
    })),
    dnsQueryCount: dns.size,
    tlsSniValues: [...sni],
    tlsSniCount: sni.size,
    protocolDistribution: [...protocols]
      .sort((a, b) => b[1] - a[1] || compareUnicodeCodePoints(a[0], b[0]))
      .map(([protocol, packet_count]) => ({ protocol, packet_count })),
    protocolCount: protocols.size,
    httpRequestUris: [...uris],
    httpRequestUriCount: observedUris.size,
    httpUriRedactionCount: uriRedactions,
    unattributedDnsAddresses: [...unattributed],
    unattributedDnsAddressCount: unattributed.size,
    unattributedDnsPackets: unattributedPackets,
    packetCount: packets.length,
    partial: observedUris.size > uris.size || unattributedPackets > 0,
  };
};
