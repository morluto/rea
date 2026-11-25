import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  readTsharkJsonPackets,
  type TsharkJsonBudget,
  type TsharkPacketLayers,
} from "../domain/pcap/tsharkJsonPackets.js";
import {
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { parsePcapHttpUri } from "./PcapHttpUri.js";
import type { RecordedTransportUrl } from "../domain/recordedTransportUrl.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { parseDnsMessageRaw } from "./PcapDnsWire.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { isRecord as object } from "../kernel/isRecord.js";
import {
  PCAP_PRODUCER_LIMITS,
  PCAP_TSHARK_DECODED_BYTES,
  pcapProducerLimit,
  pcapProducerLimitRecovery,
} from "../domain/pcap/pcapAnalysis.js";

const OPERATION = "inspect_pcap_capture";
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_TARGET_CACHE_ENTRIES = 1024;
const MAX_REQUEST_TARGET_CACHE_KEY_LENGTH = 512;

const DNS_FAMILIES = ["dns", "mdns", "llmnr"] as const;
const DNS_RAW_FAMILIES = ["dns_raw", "mdns_raw", "llmnr_raw"] as const;
const DNS_LAYER_KEYS = new Set<string>([...DNS_FAMILIES, ...DNS_RAW_FAMILIES]);
const TARGET_FIELD_KEYS = new Set<string>([
  "frame.number",
  "frame.protocols",
  "ip.src",
  "ip.dst",
  "ipv6.src",
  "ipv6.dst",
  "tls.handshake.extensions_server_name",
  "http.request.full_uri",
  "http.request.uri",
  "http2.request.full_uri",
  "http2.headers.path",
]);
const EMPTY_STRINGS: readonly string[] = [];

const assertOutputReadActive = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw cancelledBy(OPERATION, signal);
};

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

/**
 * capinfos -S prints each packet timestamp as seconds since the Unix epoch
 * with the capture's own fractional precision, a leading minus for an instant
 * before the epoch. Its default spelling is a zone-less local wall-clock time,
 * so one capture reads differently on hosts in different time zones. Project
 * the exact value to an RFC 3339 UTC instant, keeping the fractional digit
 * count. "n/a" (an empty capture), a wall-clock spelling and a value outside
 * years 0000 to 9999 stay unknown.
 */
const captureInstant = (value: string | undefined): string | null => {
  // Wireshark formats at most 64-bit seconds and nine fractional digits.
  const match = /^(-?)(\d{1,20})(?:\.(\d{1,9}))?$/u.exec(value ?? "");
  if (match?.[2] === undefined) return null;
  const negative = match[1] === "-";
  let seconds = BigInt(match[2]);
  let fraction = match[3] ?? "";
  if (negative) {
    // -1.25 is one and a quarter seconds before the epoch: whole second
    // -2 plus 0.75, so the fraction is borrowed from the next whole second.
    const digits = fraction.length;
    const borrowed = digits > 0 && BigInt(fraction) > 0n;
    seconds = -seconds - (borrowed ? 1n : 0n);
    if (borrowed)
      fraction = (10n ** BigInt(digits) - BigInt(fraction))
        .toString()
        .padStart(digits, "0");
  }
  if (seconds < -62_167_219_200n || seconds > 253_402_300_799n) return null;
  const date = new Date(Number(seconds) * 1000);
  const year = date.getUTCFullYear();
  if (Number.isNaN(year) || year < 0 || year > 9999) return null;
  return `${date.toISOString().slice(0, 19)}${fraction === "" ? "" : `.${fraction}`}Z`;
};

/** capinfos -M with a C locale provides exact numbers instead of "20 k". */
export const parseCapinfosOutput = (stdout: string): CapinfosMetadata => {
  const lines = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const at = line.indexOf(":");
    if (at >= 0 && !/^\s/u.test(line)) {
      const key = line.slice(0, at);
      const value = line.slice(at + 1).trim();
      // capinfos repeats this label for inferred truncation lengths. They
      // describe captured packets, not the capture header's snapshot limit.
      if (key === "Packet size limit" && !value.startsWith("file hdr:"))
        continue;
      lines.set(key, value);
    }
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
  const durationSeconds = duration === null ? null : Number(duration[1]);
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
    captureStart: captureInstant(
      lines.get("Earliest packet time") ?? lines.get("First packet time"),
    ),
    captureEnd: captureInstant(
      lines.get("Latest packet time") ?? lines.get("Last packet time"),
    ),
    captureDurationSeconds:
      durationSeconds !== null && Number.isFinite(durationSeconds)
        ? durationSeconds
        : null,
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
    query_labels_hex: string[] | null;
    response_addresses: string[];
    response_address_count: number;
  }[];
  readonly dnsQueryCount: number;
  readonly dnsLimitations: string[];
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

/** Map a refused tshark document to the pcap operation's typed failure. */
const decodeTsharkPackets = async (
  stdout: string,
  budget: TsharkJsonBudget,
  signal: AbortSignal | undefined,
  acquisition: string,
): Promise<TsharkPacketLayers[]> => {
  const read = await readTsharkJsonPackets(stdout, budget, signal);
  if (read.ok) return read.value;
  const failure = read.error;
  switch (failure.kind) {
    case "cancelled":
      throw cancelledBy(OPERATION, carriedReason(failure.cause));
    case "json-bytes":
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        "tshark JSON exceeds the producer_limits.output_bytes budget",
        { max_json_bytes: failure.maxBytes },
        {
          retryable: false,
          limit: pcapProducerLimit("output_bytes", failure.maxBytes),
          remediationAction: pcapProducerLimitRecovery(
            "output_bytes",
            failure.maxBytes,
          ),
        },
      );
    case "json-expansion":
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "memory",
        "tshark JSON expansion exceeds the decoding budget",
        { max_decoded_bytes: failure.maxDecodedBytes },
        fixedAllowanceOptions(
          "The tshark JSON expansion allowance",
          "capture",
          {
            limit: failure.maxDecodedBytes,
            unit: "bytes",
          },
        ),
      );
    case "malformed-json":
      throw new AnalysisProtocolError("tshark emitted malformed JSON", {
        cause: failure.cause,
      });
    case "malformed-packet":
      return protocolFailure(`${acquisition}${failure.reason}`);
  }
};

const isStringArray = (items: readonly unknown[]): items is string[] => {
  for (let i = 0; i < items.length; i += 1) {
    if (typeof items[i] !== "string") return false;
  }
  return true;
};

const validateSelectedLayerFields = (
  packets: readonly TsharkPacketLayers[],
): void => {
  for (const layers of packets) {
    // Selected-field acquisitions have a flat frame.number key. Protocol-tree
    // acquisitions are separately parsed for producer goldens and DNS PDUs.
    if (!("frame.number" in layers)) continue;
    for (const key in layers) {
      if (!Object.hasOwn(layers, key) || DNS_LAYER_KEYS.has(key)) continue;
      const value = layers[key];
      if (!Array.isArray(value) || !isStringArray(value))
        protocolFailure(`selected field ${key} must be an array of strings`);
    }
  }
};

const joinDnsPackets = (
  packets: readonly TsharkPacketLayers[],
  dnsPackets: readonly TsharkPacketLayers[],
): number[] => {
  const seen = new Set<number>();
  const joinedIndices: number[] = [];
  for (const layers of dnsPackets) {
    const frame = object(layers.frame)
      ? layers.frame["frame.number"]
      : undefined;
    if (typeof frame !== "string" || !/^[1-9][0-9]*$/u.test(frame))
      return protocolFailure("DNS packet lacks a unique frame number");
    const number = Number(frame);
    const base = packets[number - 1];
    if (!Number.isSafeInteger(number) || seen.has(number) || base === undefined)
      return protocolFailure(
        "DNS frame is duplicated or outside the capture inventory",
      );
    seen.add(number);
    joinedIndices.push(number - 1);
    for (let i = 0; i < DNS_FAMILIES.length; i += 1) {
      const family = DNS_FAMILIES[i]!;
      const rawFamily = DNS_RAW_FAMILIES[i]!;
      base[family] = layers[family];
      base[rawFamily] = layers[rawFamily];
    }
  }
  return joinedIndices;
};

const appendFieldValue = (
  values: Map<string, string[]>,
  key: string,
  item: string,
): void => {
  const list = values.get(key);
  if (list === undefined) values.set(key, [item]);
  else list.push(item);
};

const appendFieldArray = (
  values: Map<string, string[]>,
  key: string,
  items: readonly string[],
): void => {
  let list = values.get(key);
  if (list === undefined) {
    list = [];
    values.set(key, list);
  }
  for (let i = 0; i < items.length; i += 1) list.push(items[i]!);
};

/** Walk only needed fields out of a nested protocol tree (or DNS subtrees). */
const collectTargetFieldsFromNodes = (
  roots: readonly unknown[],
  values: Map<string, string[]>,
): void => {
  const pending: unknown[] = [...roots];
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (let item = value.length - 1; item >= 0; item -= 1)
        pending.push(value[item]);
      continue;
    }
    if (!object(value)) continue;
    const keys = Object.keys(value);
    let nested: unknown[] | undefined;
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]!;
      if (key.endsWith("_raw")) continue;
      const child = value[key];
      if (typeof child === "string") {
        if (TARGET_FIELD_KEYS.has(key)) appendFieldValue(values, key, child);
      } else if (Array.isArray(child)) {
        if (isStringArray(child)) {
          if (TARGET_FIELD_KEYS.has(key)) appendFieldArray(values, key, child);
        } else {
          (nested ??= []).push(child);
        }
      } else if (object(child)) {
        (nested ??= []).push(child);
      }
    }
    if (nested !== undefined) {
      for (let i = nested.length - 1; i >= 0; i -= 1) pending.push(nested[i]);
    }
  }
};

type FieldReader = (name: string) => readonly string[];

const createPacketFieldReader = (layers: TsharkPacketLayers): FieldReader => {
  if ("frame.number" in layers) {
    const hasEmbeddedDns =
      layers.dns !== undefined ||
      layers.mdns !== undefined ||
      layers.llmnr !== undefined;
    if (!hasEmbeddedDns) {
      return (name) =>
        (layers[name] as readonly string[] | undefined) ?? EMPTY_STRINGS;
    }
    const extra = new Map<string, string[]>();
    const roots: unknown[] = [];
    for (const family of DNS_FAMILIES) {
      if (layers[family] !== undefined) roots.push(layers[family]);
    }
    collectTargetFieldsFromNodes(roots, extra);
    if (extra.size === 0) {
      return (name) =>
        (layers[name] as readonly string[] | undefined) ?? EMPTY_STRINGS;
    }
    return (name) => {
      const top = layers[name] as readonly string[] | undefined;
      const nested = extra.get(name);
      if (nested === undefined) return top ?? EMPTY_STRINGS;
      return top === undefined ? nested : [...top, ...nested];
    };
  }
  const values = new Map<string, string[]>();
  collectTargetFieldsFromNodes([layers], values);
  return (name) => values.get(name) ?? EMPTY_STRINGS;
};

interface DnsQueryEntry {
  readonly query: string;
  readonly labels: readonly string[] | null;
  readonly addresses: Set<string>;
}

interface NonDnsAccumulator {
  readonly endpoints: Map<string, number>;
  readonly sni: Set<string>;
  readonly protocols: Map<string, number>;
  readonly uris: Set<string>;
  readonly observedUris: Set<string>;
  readonly requestTargetCache: Map<string, RecordedTransportUrl>;
  readonly packetAddressScratch: Set<string>;
  uriRedactions: number;
  unresolvedHttpUriTarget: boolean;
  packetCount: number;
  retainedBytes: number;
}

interface DnsAccumulator {
  readonly dns: Map<string, DnsQueryEntry>;
  readonly unattributed: Set<string>;
  readonly dnsLimitations: Set<string>;
  unattributedPackets: number;
  unresolvedDnsOwnership: boolean;
}

const chargeRetainedString = (
  state: NonDnsAccumulator,
  value: string,
): void => {
  state.retainedBytes += 192 + 2 * Buffer.byteLength(value);
  if (state.retainedBytes > MAX_RETAINED_BYTES)
    throw new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      "Packet inventory exceeds the retained-fact budget",
      { max_retained_bytes: MAX_RETAINED_BYTES },
      fixedAllowanceOptions(
        "The packet-inventory retained-fact allowance",
        "capture",
        { limit: MAX_RETAINED_BYTES, unit: "bytes" },
      ),
    );
};

const addChargedString = (
  state: NonDnsAccumulator,
  set: Set<string>,
  value: string,
): void => {
  if (!set.has(value)) {
    chargeRetainedString(state, value);
    set.add(value);
  }
};

const createNonDnsAccumulator = (packetCount: number): NonDnsAccumulator => ({
  endpoints: new Map(),
  sni: new Set(),
  protocols: new Map(),
  uris: new Set(),
  observedUris: new Set(),
  requestTargetCache: new Map(),
  packetAddressScratch: new Set(),
  uriRedactions: 0,
  unresolvedHttpUriTarget: false,
  packetCount,
  retainedBytes: 0,
});

const createDnsAccumulator = (): DnsAccumulator => ({
  dns: new Map(),
  unattributed: new Set(),
  dnsLimitations: new Set(),
  unattributedPackets: 0,
  unresolvedDnsOwnership: false,
});

const recordPacketEndpoints = (
  state: NonDnsAccumulator,
  field: FieldReader,
): void => {
  // Count one occurrence per packet even for loopback or nested IP layers.
  let addr0: string | undefined;
  let addr1: string | undefined;
  let usingSet = false;
  const scratch = state.packetAddressScratch;
  const visit = (list: readonly string[]): void => {
    for (let i = 0; i < list.length; i += 1) {
      const address = list[i]!;
      if (address === "") continue;
      if (usingSet) {
        if (scratch.has(address)) continue;
        scratch.add(address);
      } else if (address === addr0 || address === addr1) {
        continue;
      } else if (addr0 === undefined) {
        addr0 = address;
      } else if (addr1 === undefined) {
        addr1 = address;
      } else {
        usingSet = true;
        scratch.clear();
        scratch.add(addr0);
        scratch.add(addr1);
        scratch.add(address);
      }
      const prev = state.endpoints.get(address);
      if (prev === undefined) {
        chargeRetainedString(state, address);
        state.endpoints.set(address, 1);
      } else {
        state.endpoints.set(address, prev + 1);
      }
    }
  };
  visit(field("ip.src"));
  visit(field("ip.dst"));
  visit(field("ipv6.src"));
  visit(field("ipv6.dst"));
};

const recordObservedHttpUri = (
  state: NonDnsAccumulator,
  value: string,
  role: "full-uri" | "request-target",
  preparsed?: RecordedTransportUrl,
): void => {
  if (value === "" || state.observedUris.has(value)) return;
  addChargedString(state, state.observedUris, value);
  const { credentials } = preparsed ?? parsePcapHttpUri(value, role);
  if (credentials !== null) state.uriRedactions += 1;
  if (credentials === "ambiguous") return;
  addChargedString(
    state,
    state.uris,
    credentials === null
      ? value
      : value.slice(0, credentials.start) + value.slice(credentials.end),
  );
};

const recordPacketHttpUris = (
  state: NonDnsAccumulator,
  field: FieldReader,
): void => {
  const fullUris = field("http.request.full_uri");
  const requestUris = field("http.request.uri");
  const http2FullUris = field("http2.request.full_uri");
  const http2Paths = field("http2.headers.path");
  if (
    fullUris.length === 0 &&
    requestUris.length === 0 &&
    http2FullUris.length === 0 &&
    http2Paths.length === 0
  )
    return;

  let absoluteRequests: Map<string, number> | undefined;
  let absoluteRequestItems:
    | { value: string; parsed: RecordedTransportUrl }[]
    | undefined;
  let relativeRequestCount = 0;
  for (let i = 0; i < requestUris.length; i += 1) {
    const value = requestUris[i]!;
    if (value === "") continue;
    if (value.startsWith("/")) {
      relativeRequestCount += 1;
      continue;
    }
    let parsed = state.requestTargetCache.get(value);
    if (parsed === undefined) {
      parsed = parsePcapHttpUri(value, "request-target");
      if (
        value.length <= MAX_REQUEST_TARGET_CACHE_KEY_LENGTH &&
        state.requestTargetCache.size < MAX_REQUEST_TARGET_CACHE_ENTRIES
      )
        state.requestTargetCache.set(value, parsed);
    }
    if (parsed.origin !== null) {
      absoluteRequests ??= new Map();
      absoluteRequests.set(value, (absoluteRequests.get(value) ?? 0) + 1);
      (absoluteRequestItems ??= []).push({ value, parsed });
    } else {
      relativeRequestCount += 1;
    }
  }

  let unmatchedFullUriCount = 0;
  for (let i = 0; i < fullUris.length; i += 1) {
    const value = fullUris[i]!;
    if (value === "") continue;
    const absoluteCount = absoluteRequests?.get(value) ?? 0;
    if (absoluteCount > 0) absoluteRequests!.set(value, absoluteCount - 1);
    else unmatchedFullUriCount += 1;
  }
  if (relativeRequestCount > unmatchedFullUriCount)
    state.unresolvedHttpUriTarget = true;

  let nonEmptyHttp2Full = 0;
  for (let i = 0; i < http2FullUris.length; i += 1) {
    if (http2FullUris[i] !== "") nonEmptyHttp2Full += 1;
  }
  let nonEmptyHttp2Paths = 0;
  for (let i = 0; i < http2Paths.length; i += 1) {
    if (http2Paths[i] !== "") nonEmptyHttp2Paths += 1;
  }
  if (nonEmptyHttp2Paths > nonEmptyHttp2Full)
    state.unresolvedHttpUriTarget = true;

  for (let i = 0; i < fullUris.length; i += 1)
    recordObservedHttpUri(state, fullUris[i]!, "full-uri");
  for (let i = 0; i < http2FullUris.length; i += 1)
    recordObservedHttpUri(state, http2FullUris[i]!, "full-uri");
  if (absoluteRequestItems !== undefined) {
    for (let i = 0; i < absoluteRequestItems.length; i += 1) {
      const item = absoluteRequestItems[i]!;
      recordObservedHttpUri(state, item.value, "request-target", item.parsed);
    }
  }
};

const processPacketNonDns = (
  state: NonDnsAccumulator,
  index: number,
  layers: TsharkPacketLayers,
): boolean => {
  const field = createPacketFieldReader(layers);
  const frame = field("frame.number");
  if (
    frame.length !== 1 ||
    !/^\d+$/u.test(frame[0]!) ||
    Number(frame[0]) !== index + 1
  )
    return protocolFailure(
      "frame inventory is missing, duplicated or out of order",
    );
  const protocolStack = field("frame.protocols");
  if (protocolStack.length !== 1)
    return protocolFailure("packet protocol inventory is missing or ambiguous");
  // TShark reports [""] for a frame with no dissected protocol, including
  // zero-length packets. Keep the frame without inventing a protocol row.
  const protocol = protocolStack[0]!;
  recordPacketEndpoints(state, field);
  const snis = field("tls.handshake.extensions_server_name");
  for (let i = 0; i < snis.length; i += 1) {
    if (snis[i] !== "") addChargedString(state, state.sni, snis[i]!);
  }
  if (protocol !== "") {
    const prev = state.protocols.get(protocol);
    if (prev === undefined) {
      chargeRetainedString(state, protocol);
      state.protocols.set(protocol, 1);
    } else {
      state.protocols.set(protocol, prev + 1);
    }
  }
  recordPacketHttpUris(state, field);
  return (
    layers.dns !== undefined ||
    layers.mdns !== undefined ||
    layers.llmnr !== undefined ||
    "dns.qry.name" in layers ||
    "dns.a" in layers ||
    "dns.aaaa" in layers
  );
};

const countValue = (counts: Map<string, number>, value: string): void => {
  counts.set(value, (counts.get(value) ?? 0) + 1);
};

const consumeCount = (counts: Map<string, number>, value: string): boolean => {
  const remaining = counts.get(value) ?? 0;
  if (remaining === 0) return false;
  if (remaining === 1) counts.delete(value);
  else counts.set(value, remaining - 1);
  return true;
};

const dnsQueryKey = (
  query: string,
  labelsHex: readonly string[] | null,
  index: number,
  pdu: number,
  occurrence: number,
): string => {
  if (labelsHex === null)
    return `unknown:${String(index)}:${String(pdu)}:${String(occurrence)}`;
  const joined = labelsHex.join(".");
  return `${String(joined.length)}:${joined}|${query}`;
};

const processEmbeddedDnsMessages = (
  chargeState: NonDnsAccumulator,
  dnsState: DnsAccumulator,
  index: number,
  layers: TsharkPacketLayers,
  treeQueries: Map<string, number> | undefined,
  treeAddresses: Map<string, number> | undefined,
): boolean => {
  let packetUnattributed = false;
  let pdu = 0;
  for (let f = 0; f < DNS_FAMILIES.length; f += 1) {
    const family = DNS_FAMILIES[f]!;
    const source = layers[family];
    if (source === undefined) continue;
    const raw = layers[DNS_RAW_FAMILIES[f]!];
    const sources = Array.isArray(source) ? source : [source];
    const raws =
      Array.isArray(raw) && typeof raw[0] !== "string"
        ? raw
        : raw === undefined
          ? EMPTY_STRINGS
          : [raw];
    for (let s = 0; s < sources.length; s += 1) {
      const facts = parseDnsMessageRaw(
        raws.length === sources.length ? raws[s] : undefined,
        sources[s],
        family,
      );
      if (treeQueries !== undefined && treeAddresses !== undefined) {
        for (const question of facts.questions)
          countValue(treeQueries, question.query);
        for (const [, address] of facts.assigned)
          countValue(treeAddresses, address);
        for (const address of facts.unattributed)
          countValue(treeAddresses, address);
      }
      let singleEntry: DnsQueryEntry | undefined;
      let entries: DnsQueryEntry[] | undefined;
      if (facts.questions.length > 1) entries = [];
      for (let occ = 0; occ < facts.questions.length; occ += 1) {
        const question = facts.questions[occ]!;
        const key = dnsQueryKey(
          question.query,
          question.labels_hex,
          index,
          pdu,
          occ,
        );
        let entry = dnsState.dns.get(key);
        if (entry === undefined) {
          chargeRetainedString(chargeState, question.query);
          for (const label of question.labels_hex ?? EMPTY_STRINGS)
            chargeRetainedString(chargeState, label);
          entry = {
            query: question.query,
            labels: question.labels_hex,
            addresses: new Set(),
          };
          dnsState.dns.set(key, entry);
        }
        if (entries !== undefined) entries.push(entry);
        else singleEntry = entry;
      }
      dnsState.unresolvedDnsOwnership ||= facts.incomplete;
      for (const reason of facts.incomplete_reasons ?? EMPTY_STRINGS)
        addChargedString(chargeState, dnsState.dnsLimitations, reason);
      for (const [questionIdx, address] of facts.assigned) {
        const target =
          entries !== undefined ? entries[questionIdx]! : singleEntry!;
        addChargedString(chargeState, target.addresses, address);
      }
      if (facts.unattributed.length > 0) {
        packetUnattributed = true;
        for (const address of facts.unattributed)
          addChargedString(chargeState, dnsState.unattributed, address);
      }
      pdu += 1;
    }
  }
  return packetUnattributed;
};

const reconcileSelectedDns = (
  chargeState: NonDnsAccumulator,
  dnsState: DnsAccumulator,
  index: number,
  layers: TsharkPacketLayers,
  treeQueries: Map<string, number>,
  treeAddresses: Map<string, number>,
): boolean => {
  const selected = (name: string): readonly string[] =>
    (layers[name] as readonly string[] | undefined) ?? EMPTY_STRINGS;
  let packetUnattributed = false;
  let mismatch = false;
  const queries = selected("dns.qry.name");
  for (let occurrence = 0; occurrence < queries.length; occurrence += 1) {
    const query = queries[occurrence]!;
    if (consumeCount(treeQueries, query)) continue;
    mismatch = true;
    if (query === "") continue;
    chargeRetainedString(chargeState, query);
    dnsState.dns.set(`selected:${String(index)}:${String(occurrence)}`, {
      query,
      labels: null,
      addresses: new Set(),
    });
  }
  const consumeSelectedAddress = (list: readonly string[]): void => {
    for (let i = 0; i < list.length; i += 1) {
      const address = list[i]!;
      if (consumeCount(treeAddresses, address)) continue;
      mismatch = true;
      if (address === "") continue;
      packetUnattributed = true;
      addChargedString(chargeState, dnsState.unattributed, address);
    }
  };
  consumeSelectedAddress(selected("dns.a"));
  consumeSelectedAddress(selected("dns.aaaa"));
  if (mismatch || treeQueries.size > 0 || treeAddresses.size > 0) {
    dnsState.unresolvedDnsOwnership = true;
    addChargedString(
      chargeState,
      dnsState.dnsLimitations,
      "Selected DNS observations and per-message trees differ in query or address occurrences; unmatched selected facts are retained without wire identity or ownership",
    );
  }
  return packetUnattributed;
};

const processPacketDns = (
  chargeState: NonDnsAccumulator,
  dnsState: DnsAccumulator,
  index: number,
  layers: TsharkPacketLayers,
  hasDnsAcquisition: boolean,
): void => {
  const hasEmbedded =
    layers.dns !== undefined ||
    layers.mdns !== undefined ||
    layers.llmnr !== undefined;
  const hasSelected =
    hasDnsAcquisition ||
    "dns.qry.name" in layers ||
    "dns.a" in layers ||
    "dns.aaaa" in layers;
  if (!hasEmbedded && !hasSelected) return;

  const treeQueries = hasSelected ? new Map<string, number>() : undefined;
  const treeAddresses = hasSelected ? new Map<string, number>() : undefined;
  let packetUnattributed = hasEmbedded
    ? processEmbeddedDnsMessages(
        chargeState,
        dnsState,
        index,
        layers,
        treeQueries,
        treeAddresses,
      )
    : false;
  if (hasSelected) {
    const selectedUnattributed = reconcileSelectedDns(
      chargeState,
      dnsState,
      index,
      layers,
      treeQueries!,
      treeAddresses!,
    );
    packetUnattributed ||= selectedUnattributed;
  }
  if (packetUnattributed) dnsState.unattributedPackets += 1;
};

const hasTargetFieldInDnsSubtrees = (
  packets: readonly TsharkPacketLayers[],
  joinedIndices: readonly number[],
): boolean => {
  const check = new Map<string, string[]>();
  for (let i = 0; i < joinedIndices.length; i += 1) {
    const layers = packets[joinedIndices[i]!]!;
    const roots: unknown[] = [];
    for (const family of DNS_FAMILIES) {
      if (layers[family] !== undefined) roots.push(layers[family]);
    }
    if (roots.length === 0) continue;
    collectTargetFieldsFromNodes(roots, check);
    if (check.size > 0) return true;
  }
  return false;
};

const projectTsharkFields = (
  state: NonDnsAccumulator,
  dnsState: DnsAccumulator,
): TsharkFields => ({
  endpoints: [...state.endpoints]
    .sort((a, b) => b[1] - a[1] || compareUnicodeCodePoints(a[0], b[0]))
    .map(([address, packet_count]) => ({
      address,
      port: null,
      packet_count,
    })),
  endpointCount: state.endpoints.size,
  dnsQueries: [...dnsState.dns.values()].map(
    ({ query, labels, addresses }) => ({
      query,
      query_labels_hex: labels === null ? null : [...labels],
      response_addresses: [...addresses],
      response_address_count: addresses.size,
    }),
  ),
  dnsQueryCount: dnsState.dns.size,
  dnsLimitations: [...dnsState.dnsLimitations],
  tlsSniValues: [...state.sni],
  tlsSniCount: state.sni.size,
  protocolDistribution: [...state.protocols]
    .sort((a, b) => b[1] - a[1] || compareUnicodeCodePoints(a[0], b[0]))
    .map(([protocol, packet_count]) => ({ protocol, packet_count })),
  protocolCount: state.protocols.size,
  httpRequestUris: [...state.uris],
  httpRequestUriCount: state.observedUris.size,
  httpUriRedactionCount: state.uriRedactions,
  unattributedDnsAddresses: [...dnsState.unattributed],
  unattributedDnsAddressCount: dnsState.unattributed.size,
  unattributedDnsPackets: dnsState.unattributedPackets,
  packetCount: state.packetCount,
  partial:
    state.observedUris.size > state.uris.size ||
    dnsState.unresolvedDnsOwnership ||
    state.unresolvedHttpUriTarget,
});

const DNS_FAMILY_PROTOCOL_PATTERN = /(?:^|:)(?:dns|mdns|llmnr)(?::|$)/iu;

export interface PreparedTsharkBaseOutput {
  readonly packets: TsharkPacketLayers[];
  readonly baseDecodedBytes: number;
  /** The selected `producer_limits.output_bytes`, which also bounds the DNS pass. */
  readonly outputBytes: number;
  readonly state: NonDnsAccumulator;
  readonly nonDnsRetainedBytes: number;
  readonly dnsFrameIndices: readonly number[];
  readonly hasDnsProtocol: boolean;
  readonly fallback: TsharkFields;
}

/** Decode and aggregate the selected-field pass once so DNS join need not re-parse it. */
export const prepareTsharkBaseOutput = async (
  stdout: string,
  signal?: AbortSignal,
  outputBytes: number = PCAP_PRODUCER_LIMITS.output_bytes,
): Promise<PreparedTsharkBaseOutput> => {
  const budget: TsharkJsonBudget = {
    maxBytes: outputBytes,
    maxDecodedBytes: PCAP_TSHARK_DECODED_BYTES,
    decodedBytes: 0,
  };
  const packets = await decodeTsharkPackets(stdout, budget, signal, "");
  validateSelectedLayerFields(packets);
  const state = createNonDnsAccumulator(packets.length);
  const dnsFrameIndices: number[] = [];
  for (let index = 0; index < packets.length; index += 1) {
    if (index % 256 === 0) {
      await yieldToEventLoop();
      assertOutputReadActive(signal);
    }
    if (processPacketNonDns(state, index, packets[index]!))
      dnsFrameIndices.push(index);
  }
  assertOutputReadActive(signal);
  const nonDnsRetainedBytes = state.retainedBytes;
  const fallbackDns = createDnsAccumulator();
  for (let i = 0; i < dnsFrameIndices.length; i += 1) {
    const index = dnsFrameIndices[i]!;
    processPacketDns(state, fallbackDns, index, packets[index]!, false);
  }
  const fallback = projectTsharkFields(state, fallbackDns);
  state.retainedBytes = nonDnsRetainedBytes;
  let hasDnsProtocol = dnsFrameIndices.length > 0;
  if (!hasDnsProtocol) {
    for (const protocol of state.protocols.keys()) {
      if (DNS_FAMILY_PROTOCOL_PATTERN.test(protocol)) {
        hasDnsProtocol = true;
        break;
      }
    }
  }
  return {
    packets,
    baseDecodedBytes: budget.decodedBytes,
    outputBytes,
    state,
    nonDnsRetainedBytes,
    dnsFrameIndices,
    hasDnsProtocol,
    fallback,
  };
};

/** Join DNS wire PDUs onto an already-prepared base capture without re-parsing base JSON. */
export const finalizeTsharkWithDns = async (
  prepared: PreparedTsharkBaseOutput,
  dnsStdout: string,
  signal?: AbortSignal,
): Promise<TsharkFields> => {
  const budget: TsharkJsonBudget = {
    maxBytes: prepared.outputBytes,
    maxDecodedBytes: PCAP_TSHARK_DECODED_BYTES,
    decodedBytes: prepared.baseDecodedBytes,
  };
  const dnsPackets = await decodeTsharkPackets(
    dnsStdout,
    budget,
    signal,
    "DNS ",
  );
  const joinedIndices = joinDnsPackets(prepared.packets, dnsPackets);
  if (hasTargetFieldInDnsSubtrees(prepared.packets, joinedIndices)) {
    const fullState = createNonDnsAccumulator(prepared.packets.length);
    const fullDns = createDnsAccumulator();
    for (let index = 0; index < prepared.packets.length; index += 1) {
      if (index % 256 === 0) {
        await yieldToEventLoop();
        assertOutputReadActive(signal);
      }
      const layers = prepared.packets[index]!;
      processPacketNonDns(fullState, index, layers);
      processPacketDns(fullState, fullDns, index, layers, true);
    }
    assertOutputReadActive(signal);
    return projectTsharkFields(fullState, fullDns);
  }
  const activeSet = new Set<number>(prepared.dnsFrameIndices);
  for (let i = 0; i < joinedIndices.length; i += 1)
    activeSet.add(joinedIndices[i]!);
  const activeIndices = [...activeSet].sort((a, b) => a - b);
  prepared.state.retainedBytes = prepared.nonDnsRetainedBytes;
  const dnsState = createDnsAccumulator();
  for (let i = 0; i < activeIndices.length; i += 1) {
    if (i % 256 === 0) {
      await yieldToEventLoop();
      assertOutputReadActive(signal);
    }
    const index = activeIndices[i]!;
    processPacketDns(
      prepared.state,
      dnsState,
      index,
      prepared.packets[index]!,
      true,
    );
  }
  assertOutputReadActive(signal);
  return projectTsharkFields(prepared.state, dnsState);
};

/** Decode each bounded acquisition, then join DNS PDUs by unique capture frame. */
export const parseTsharkJsonOutput = async (
  stdout: string,
  signal?: AbortSignal,
  dnsStdout?: string,
  outputBytes: number = PCAP_PRODUCER_LIMITS.output_bytes,
): Promise<TsharkFields> => {
  const budget: TsharkJsonBudget = {
    maxBytes: outputBytes,
    maxDecodedBytes: PCAP_TSHARK_DECODED_BYTES,
    decodedBytes: 0,
  };
  const packets = await decodeTsharkPackets(stdout, budget, signal, "");
  validateSelectedLayerFields(packets);
  if (dnsStdout !== undefined) {
    const dnsPackets = await decodeTsharkPackets(
      dnsStdout,
      budget,
      signal,
      "DNS ",
    );
    joinDnsPackets(packets, dnsPackets);
  }
  const state = createNonDnsAccumulator(packets.length);
  const dnsState = createDnsAccumulator();
  const hasDnsAcquisition = dnsStdout !== undefined;
  for (let index = 0; index < packets.length; index += 1) {
    if (index % 256 === 0) {
      await yieldToEventLoop();
      assertOutputReadActive(signal);
    }
    const layers = packets[index]!;
    const hasDns = processPacketNonDns(state, index, layers);
    if (hasDns || hasDnsAcquisition)
      processPacketDns(state, dnsState, index, layers, hasDnsAcquisition);
  }
  assertOutputReadActive(signal);
  return projectTsharkFields(state, dnsState);
};
