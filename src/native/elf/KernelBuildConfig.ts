import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { crc32, inflateRaw } from "node:zlib";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import {
  KERNEL_BUILD_CONFIG_CODECS,
  KERNEL_BUILD_CONFIG_NUMBER,
  type InspectKernelBuildConfigInput,
  type KernelBuildConfig,
  type KernelBuildConfigEntry,
} from "../../domain/native/kernelBuildConfig.js";
import { kernelCompressionCodecAt } from "./KernelCompressionCodec.js";

type Report = KernelBuildConfig;
type Entry = KernelBuildConfigEntry;
type Space = "file" | "inflated_payload";
type Located = { space: Space; offset: number; bytes: number };
type Reason = NonNullable<Report["config"]["reason"]>;
type KernelBuildConfigBudgetKnob =
  | "max_entries"
  | "max_config_bytes"
  | "max_payload_bytes";

const IKCFG_ST = Buffer.from("IKCFG_ST");
const IKCFG_ED = Buffer.from("IKCFG_ED");
const BANNER_PREFIX = Buffer.from("Linux version ");
const BANNER_TEXT_BYTES = 512;
const MAX_NAME_BYTES = 256;
/** `# ` + a longest name + ` is not set`. */
const UNSET_LINE_BYTES = MAX_NAME_BYTES + 13;
/** IKCFG_ST + gzip candidates inflated per search; a kernel carries one. */
const MAX_CONFIG_CANDIDATES = 16;
/** Total inflated bytes across all candidates, as a multiple of max_config_bytes. */
const CONFIG_SEARCH_BUDGET_FACTOR = 4;
/** Bytes scanned between event-loop turns, so a live abort can be delivered. */
const TURN_STRIDE = 0x100000;
const UNTRUSTED = "target-derived-untrusted" as const;

const codeOf = (error: unknown): string | null =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;

/**
 * Let pending signals and requests run, then honor an abort they raised. The
 * scans are otherwise synchronous, so without a turn no abort could land.
 */
const yieldTurn = async (signal: AbortSignal | undefined): Promise<void> => {
  await nextTurn();
  assertArtifactReadActive(signal);
};

/** SHA-256 hashed one TURN_STRIDE window per event-loop turn. */
const sha256 = async (
  bytes: Buffer,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const hash = createHash("sha256");
  for (let start = 0; start < bytes.length; start += TURN_STRIDE) {
    if (start > 0) await yieldTurn(signal);
    hash.update(bytes.subarray(start, start + TURN_STRIDE));
  }
  return hash.digest("hex");
};

/** A caller-selected budget refused the image; `knob` names it as a typed fact. */
export class KernelBuildConfigBudgetFailure extends ArtifactReaderFailure {
  constructor(
    readonly knob: KernelBuildConfigBudgetKnob,
    limit: number,
  ) {
    super("limit", `Kernel build config exceeds ${knob} (${String(limit)}).`, {
      boundary: "capacity",
    });
  }
}

const budget = (knob: KernelBuildConfigBudgetKnob, limit: number): never => {
  throw new KernelBuildConfigBudgetFailure(knob, limit);
};

const isElf = (bytes: Buffer): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x7f &&
  bytes[1] === 0x45 &&
  bytes[2] === 0x4c &&
  bytes[3] === 0x46;

const codecAt = (bytes: Buffer, offset: number) =>
  kernelCompressionCodecAt(bytes, offset, KERNEL_BUILD_CONFIG_CODECS);

const located = (space: Space, offset: number, bytes: number): Located => ({
  space,
  offset,
  bytes,
});

type GzipMember =
  | { readonly kind: "member"; readonly output: Buffer; readonly end: number }
  /** The deflate stream ended but the CRC-32 or ISIZE trailer does not match. */
  | {
      readonly kind: "corrupt";
      readonly end: number;
      readonly inflated: number;
    }
  /**
   * `spent` bounds the output inflated before the failure: zero when only the
   * header was read, otherwise the output budget, since zlib does not report
   * partial output when it throws.
   */
  | { readonly kind: "truncated"; readonly spent: number }
  | { readonly kind: "invalid"; readonly spent: number }
  /** The member inflates past `maxOutput`. */
  | { readonly kind: "limit" };

const CM_DEFLATE = 0x08;
const FTEXT_RESERVED = 0xe0;
const FHCRC = 0x02;
const FEXTRA = 0x04;
const FNAME = 0x08;
const FCOMMENT = 0x10;

/**
 * Offset after an RFC 1952 member header, null when the header ends early, or
 * `invalid` when it is not deflate, sets reserved flags, or fails its FHCRC.
 */
const gzipHeaderEnd = (
  bytes: Buffer,
  start: number,
): number | "invalid" | null => {
  if (start + 10 > bytes.length) return null;
  if (bytes[start + 2] !== CM_DEFLATE) return "invalid";
  const flags = bytes[start + 3] ?? 0;
  if ((flags & FTEXT_RESERVED) !== 0) return "invalid";
  let cursor = start + 10;
  if ((flags & FEXTRA) !== 0) {
    if (cursor + 2 > bytes.length) return null;
    cursor += 2 + bytes.readUInt16LE(cursor);
  }
  for (const flag of [FNAME, FCOMMENT]) {
    if ((flags & flag) === 0) continue;
    const zero = bytes.indexOf(0, cursor);
    if (zero < 0) return null;
    cursor = zero + 1;
  }
  if ((flags & FHCRC) === 0) return cursor > bytes.length ? null : cursor;
  if (cursor + 2 > bytes.length) return null;
  // FHCRC is the low 16 bits of the CRC-32 of every header byte before it.
  if (
    bytes.readUInt16LE(cursor) !==
    (crc32(bytes.subarray(start, cursor)) & 0xffff)
  )
    return "invalid";
  return cursor + 2;
};

/**
 * Inflate exactly one gzip member at `start` with bounded output, verifying its
 * CRC-32 and ISIZE trailer. Only `bytes` is read, so the caller bounds the
 * input by passing a subarray. Bytes after the member are not consumed, so the
 * caller can require the next bytes to be a marker.
 */
interface Inflated {
  readonly buffer: Buffer;
  readonly engine: { readonly bytesWritten: number };
}

const inflateBounded = (
  input: Buffer,
  maxOutputLength: number,
): Promise<Inflated> =>
  new Promise((resolve, reject) => {
    inflateRaw(input, { maxOutputLength, info: true }, (error, result) => {
      if (error === null) resolve(result as unknown as Inflated);
      else reject(error);
    });
  });

const inflateGzipMember = async (
  bytes: Buffer,
  start: number,
  maxOutput: number,
  signal: AbortSignal | undefined,
): Promise<GzipMember> => {
  const body = gzipHeaderEnd(bytes, start);
  if (body === null) return { kind: "truncated", spent: 0 };
  if (body === "invalid") return { kind: "invalid", spent: 0 };
  let output: Buffer;
  let consumed: number;
  try {
    // zlib runs off the event loop, so an abort raised meanwhile is seen below.
    const inflated = await inflateBounded(bytes.subarray(body), maxOutput);
    output = inflated.buffer;
    consumed = inflated.engine.bytesWritten;
  } catch (error) {
    assertArtifactReadActive(signal);
    const code = codeOf(error);
    if (code === "ERR_BUFFER_TOO_LARGE") return { kind: "limit" };
    return code === "Z_BUF_ERROR"
      ? { kind: "truncated", spent: maxOutput }
      : { kind: "invalid", spent: maxOutput };
  }
  assertArtifactReadActive(signal);
  const trailer = body + consumed;
  if (trailer + 8 > bytes.length)
    return { kind: "truncated", spent: output.length };
  if (
    bytes.readUInt32LE(trailer) !== crc32(output) ||
    bytes.readUInt32LE(trailer + 4) !== output.length >>> 0
  )
    return { kind: "corrupt", end: trailer + 8, inflated: output.length };
  return { kind: "member", output, end: trailer + 8 };
};

const decoder = new TextDecoder("utf-8", { fatal: true });
/** C0 controls other than tab, LF and CR, plus DEL. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/**
 * Strict UTF-8 text with no control bytes besides tab, LF and CR. The native
 * decode is one linear pass; the control check then runs one TURN_STRIDE
 * window per event-loop turn.
 */
const decodeText = async (
  bytes: Buffer,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return null;
  }
  for (let start = 0; start < text.length; start += TURN_STRIDE) {
    if (start > 0) await yieldTurn(signal);
    if (CONTROL.test(text.slice(start, start + TURN_STRIDE))) return null;
  }
  return text;
};

const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** Line terminators other than LF that a `.config` value may not contain. */
const isLineBreak = (char: number): boolean =>
  char === 0x0d || char === 0x2028 || char === 0x2029;

/**
 * Decoded `"..."` value whose only escapes are `\"` and `\\`. The line is
 * validated in place first, yielding once per TURN_STRIDE characters, so the
 * decoded string is built once, no larger than the line, and only for a valid
 * value.
 */
const unquote = async (
  raw: string,
  signal: AbortSignal | undefined,
): Promise<string | null> => {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null;
  const end = raw.length - 1;
  let escaped = false;
  let turnAt = TURN_STRIDE;
  for (let index = 1; index < end; index += 1) {
    if (index >= turnAt) {
      turnAt = index + TURN_STRIDE;
      await yieldTurn(signal);
    }
    const char = raw.charCodeAt(index);
    if (char === QUOTE || isLineBreak(char)) return null;
    if (char !== BACKSLASH) continue;
    const next = raw.charCodeAt(index + 1);
    if (index + 1 >= end || (next !== QUOTE && next !== BACKSLASH)) return null;
    escaped = true;
    index += 1;
  }
  const body = raw.slice(1, end);
  return escaped ? body.replace(/\\(["\\])/gu, "$1") : body;
};

const classifyValue = async (
  raw: string,
  signal: AbortSignal | undefined,
): Promise<{ kind: Entry["kind"]; value: string } | null> => {
  if (raw === "y" || raw === "m") return { kind: raw, value: raw };
  if (KERNEL_BUILD_CONFIG_NUMBER.test(raw))
    return { kind: "number", value: raw };
  // Kconfig strings have no length limit; max_config_bytes bounds the line.
  const text = await unquote(raw, signal);
  return text === null ? null : { kind: "string", value: text };
};

/**
 * Strict `.config` grammar: every non-blank line is a comment, a
 * `# CONFIG_X is not set` line, or `CONFIG_X=value`. Anything else rejects the
 * whole candidate so ordinary marker strings never read as a config. Lines
 * are scanned one at a time, so no per-line array is built ahead of the
 * max_entries check.
 */
const parseConfigText = async (
  bytes: Buffer,
  maxEntries: number,
  signal: AbortSignal | undefined,
): Promise<readonly Entry[] | null> => {
  const text = await decodeText(bytes, signal);
  if (text === null || text.length === 0) return null;
  const entries: Entry[] = [];
  const push = (entry: Entry): void => {
    if (entries.length >= maxEntries) budget("max_entries", maxEntries);
    entries.push(entry);
  };
  let lines = 0;
  let turnAt = TURN_STRIDE;
  for (let start = 0; start < text.length;) {
    if ((lines++ & 0x3ff) === 0) assertArtifactReadActive(signal);
    if (start >= turnAt) {
      turnAt = start + TURN_STRIDE;
      await yieldTurn(signal);
    }
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(
      start,
      end > start && text.charCodeAt(end - 1) === 0x0d ? end - 1 : end,
    );
    start = end + 1;
    if (/^[ \t]*$/u.test(line)) continue;
    // Only a line short enough to hold a bounded name can be either form, so
    // the patterns never scan a long value.
    const unset =
      line.length <= UNSET_LINE_BYTES
        ? /^# (CONFIG_[A-Za-z0-9_]+) is not set$/u.exec(line)
        : null;
    if (unset !== null) {
      const name = unset[1] ?? "";
      if (name.length > MAX_NAME_BYTES) return null;
      push({ name, kind: "not_set", value: null, trust: UNTRUSTED });
      continue;
    }
    if (line.startsWith("#")) continue;
    const set = /^(CONFIG_[A-Za-z0-9_]+)=/u.exec(
      line.slice(0, MAX_NAME_BYTES + 1),
    );
    if (set === null) return null;
    const name = set[1] ?? "";
    if (name.length > MAX_NAME_BYTES) return null;
    const value = await classifyValue(line.slice(set[0].length), signal);
    if (value === null) return null;
    push({ name, kind: value.kind, value: value.value, trust: UNTRUSTED });
  }
  return entries.length === 0 ? null : entries;
};

interface ConfigBlob {
  readonly marker: number;
  readonly gzipStart: number;
  readonly memberBytes: number;
}

interface AcceptedConfig extends ConfigBlob {
  readonly kind: "present";
  readonly entries: readonly Entry[];
  readonly sha256: string;
}

/**
 * `IKCFG_ST`, gzip magic, and `IKCFG_ED` identify a config blob whose member
 * does not decode, fails its trailer check, or whose text fails the grammar.
 * For a member that does not decode, `memberBytes` runs to the closing marker.
 */
interface MalformedConfig extends ConfigBlob {
  readonly kind: "malformed";
  readonly reason: "config_gzip_invalid" | "config_text_invalid";
}

/**
 * The first accepted config wins. Otherwise a framed but unreadable blob,
 * including a deflate stream that is damaged or cut off by its closing marker,
 * is malformed and a member cut off by the searched bytes is truncated; neither
 * is reported as absent. Each candidate's inflate input ends at the next
 * `IKCFG_ED`, since `kernel/configs.c` places that marker right after the
 * member. At most MAX_CONFIG_CANDIDATES members and CONFIG_SEARCH_BUDGET_FACTOR
 * times `max_config_bytes` of inflated output are spent; past that the search
 * is `exhausted` rather than silently stopped.
 */
const findConfig = async (
  bytes: Buffer,
  maxOutput: number,
  maxEntries: number,
  signal: AbortSignal | undefined,
): Promise<
  AcceptedConfig | MalformedConfig | "absent" | "truncated" | "exhausted"
> => {
  let from = 0;
  let truncated = false;
  let malformed: MalformedConfig | null = null;
  let candidates = 0;
  let remaining = maxOutput * CONFIG_SEARCH_BUDGET_FACTOR;
  let oversized = false;
  // Next IKCFG_ED at or after the current candidate; -1 once none remains.
  let closing: number | null = null;
  let turnAt = TURN_STRIDE;
  for (;;) {
    assertArtifactReadActive(signal);
    const marker = bytes.indexOf(IKCFG_ST, from);
    if (marker < 0) break;
    if (marker >= turnAt) {
      turnAt = marker + TURN_STRIDE;
      await yieldTurn(signal);
    }
    from = marker + 1;
    const gzipAt = marker + IKCFG_ST.length;
    if (codecAt(bytes, gzipAt) !== "gzip") continue;
    if (closing === null || (closing >= 0 && closing < gzipAt))
      closing = bytes.indexOf(IKCFG_ED, gzipAt);
    // Without a closing marker nothing later can be framed; one truncated
    // member is enough to report the search incomplete.
    if (closing < 0 && truncated) break;
    if (candidates >= MAX_CONFIG_CANDIDATES || remaining === 0)
      return "exhausted";
    candidates += 1;
    const limit = Math.min(maxOutput, remaining);
    const span = closing < 0 ? bytes : bytes.subarray(0, closing);
    const member = await inflateGzipMember(span, gzipAt, limit, signal);
    if (member.kind === "limit") {
      if (limit < maxOutput) return "exhausted";
      // A member past max_config_bytes may be a decoy, so a later framed
      // config can still win; the budget failure is raised only if none does.
      oversized = true;
      remaining -= limit;
      continue;
    }
    if (member.kind === "member") remaining -= member.output.length;
    if (member.kind === "corrupt") remaining -= member.inflated;
    if (member.kind === "truncated" || member.kind === "invalid") {
      remaining -= member.spent;
      if (closing < 0) {
        if (member.kind === "truncated") truncated = true;
        continue;
      }
      // IKCFG_ST, gzip magic and a later IKCFG_ED frame bytes that do not
      // decode: an unreadable config, not an absent one.
      malformed ??= {
        kind: "malformed",
        marker,
        gzipStart: gzipAt,
        memberBytes: closing - gzipAt,
        reason: "config_gzip_invalid",
      };
      continue;
    }
    if (member.end !== closing) continue;
    const blob = {
      marker,
      gzipStart: gzipAt,
      memberBytes: member.end - gzipAt,
    };
    const entries =
      member.kind === "member"
        ? await parseConfigText(member.output, maxEntries, signal)
        : null;
    if (member.kind === "member" && entries !== null)
      return {
        kind: "present",
        ...blob,
        entries,
        sha256: await sha256(member.output, signal),
      };
    malformed ??= {
      kind: "malformed",
      ...blob,
      reason:
        member.kind === "corrupt"
          ? "config_gzip_invalid"
          : "config_text_invalid",
    };
  }
  if (oversized) budget("max_config_bytes", maxOutput);
  return malformed ?? (truncated ? "truncated" : "absent");
};

const parseBannerText = (
  text: string,
): {
  version: string;
  builder: string | null;
  compiler: string | null;
} | null => {
  let rest = text.slice(BANNER_PREFIX.length);
  const version = /^[0-9][0-9A-Za-z.+_~-]*/u.exec(rest)?.[0];
  if (version === undefined) return null;
  rest = rest.slice(version.length);
  let builder: string | null = null;
  let compiler: string | null = null;
  if (rest.startsWith(" (")) {
    const close = rest.indexOf(")");
    if (close > 2) {
      builder = rest.slice(2, close);
      rest = rest.slice(close + 1);
    }
  }
  if (rest.startsWith(" (")) {
    const marked = rest.lastIndexOf(") #");
    if (marked > 2) compiler = rest.slice(2, marked);
    else if (rest.endsWith(")") && rest.length > 3)
      compiler = rest.slice(2, -1);
  }
  return { version, builder, compiler };
};

const absentBanner = (status: "absent" | "unknown"): Report["banner"] => ({
  status,
  text: null,
  version: null,
  builder: null,
  compiler: null,
  location: null,
  trust: UNTRUSTED,
});

const isPrintable = (value: number): boolean => value >= 0x20 && value <= 0x7e;

/**
 * First printable, NUL- or newline-terminated `Linux version <digit>...`
 * string of at most BANNER_TEXT_BYTES. Every hit inside one printable run
 * shares that run's terminator, so each run is scanned once and the search
 * resumes after it: the scan is linear in the searched bytes.
 */
const findBanner = async (
  bytes: Buffer,
  space: Space,
  signal: AbortSignal | undefined,
): Promise<Report["banner"]> => {
  let from = 0;
  let turnAt = TURN_STRIDE;
  for (;;) {
    assertArtifactReadActive(signal);
    const at = bytes.indexOf(BANNER_PREFIX, from);
    if (at < 0) return absentBanner("absent");
    let end = at + BANNER_PREFIX.length;
    while (end < bytes.length && isPrintable(bytes[end] ?? 0)) {
      end += 1;
      if (end % TURN_STRIDE === 0) await yieldTurn(signal);
    }
    if (end >= turnAt) {
      turnAt = end + TURN_STRIDE;
      await yieldTurn(signal);
    }
    from = end + 1;
    if (end >= bytes.length || (bytes[end] !== 0 && bytes[end] !== 0x0a))
      continue;
    // Only hits within BANNER_TEXT_BYTES of the terminator fit the window.
    const run = bytes.subarray(0, end);
    for (
      let hit = run.indexOf(
        BANNER_PREFIX,
        Math.max(at, end - BANNER_TEXT_BYTES),
      );
      hit >= 0;
      hit = run.indexOf(BANNER_PREFIX, hit + 1)
    ) {
      const first = bytes[hit + BANNER_PREFIX.length] ?? 0;
      if (first < 0x30 || first > 0x39) continue;
      const text = bytes.toString("latin1", hit, end);
      const parsed = parseBannerText(text);
      if (parsed === null) continue;
      return {
        status: "present",
        text,
        version: parsed.version,
        builder: parsed.builder,
        compiler: parsed.compiler,
        location: located(space, hit, end - hit),
        trust: UNTRUSTED,
      };
    }
  }
};

const baseLimitations = (): string[] => [
  "This workflow does not execute the image or boot the kernel.",
  "Banner text and configuration values are target-derived and untrusted.",
  "A config is accepted only when IKCFG_ST is immediately followed by a gzip member that inflates to config text and is immediately followed by IKCFG_ED. An IKCFG_ST string without gzip magic is not a config. A framed member that does not decode, fails its trailer check, or fails the config grammar is malformed, not absent.",
  "An absent banner or config describes only the bytes that were searched; a kernel built without CONFIG_IKCONFIG carries no embedded config.",
  "Only a gzip payload inside an x86 bzImage setup header is inflated. Other codecs are named and left compressed.",
];

const emptyConfig = (
  input: InspectKernelBuildConfigInput,
  status: Report["config"]["status"],
  reason: Reason | null,
): Report["config"] => ({
  status,
  reason,
  marker: null,
  end_marker: null,
  gzip: null,
  sha256: null,
  option_count: 0,
  matched_count: 0,
  offset: input.offset,
  limit: input.limit,
  name: input.name ?? null,
  entries: [],
});

const blobRanges = (
  blob: ConfigBlob,
  space: Space,
): Pick<Report["config"], "marker" | "gzip" | "end_marker"> => ({
  marker: located(space, blob.marker, IKCFG_ST.length),
  gzip: located(space, blob.gzipStart, blob.memberBytes),
  end_marker: located(
    space,
    blob.gzipStart + blob.memberBytes,
    IKCFG_ED.length,
  ),
});

const acceptedConfig = (
  found: AcceptedConfig,
  input: InspectKernelBuildConfigInput,
  space: Space,
): Report["config"] => {
  const matched =
    input.name === undefined
      ? found.entries
      : found.entries.filter((entry) => entry.name === input.name);
  return {
    status: "present",
    reason: null,
    ...blobRanges(found, space),
    sha256: found.sha256,
    option_count: found.entries.length,
    matched_count: matched.length,
    offset: input.offset,
    limit: input.limit,
    name: input.name ?? null,
    entries: matched.slice(input.offset, input.offset + input.limit),
  };
};

interface SearchSpace {
  readonly bytes: Buffer;
  readonly space: Space;
  readonly payload: Report["payload"];
  readonly extraLimitations: readonly string[];
}

const reportFromSearch = async (
  artifact: Report["artifact"],
  format: Report["format"],
  input: InspectKernelBuildConfigInput,
  search: SearchSpace,
  signal: AbortSignal | undefined,
): Promise<Report> => {
  const found = await findConfig(
    search.bytes,
    input.max_config_bytes,
    input.max_entries,
    signal,
  );
  const config =
    found === "truncated"
      ? emptyConfig(input, "incomplete", "config_gzip_truncated")
      : found === "exhausted"
        ? emptyConfig(input, "incomplete", "config_search_exhausted")
        : found === "absent"
          ? emptyConfig(input, "absent", null)
          : found.kind === "malformed"
            ? {
                ...emptyConfig(input, "malformed", found.reason),
                ...blobRanges(found, search.space),
              }
            : acceptedConfig(found, input, search.space);
  const complete = found === "absent" || config.status === "present";
  const banner = await findBanner(search.bytes, search.space, signal);
  return {
    artifact,
    format,
    payload: search.payload,
    next_probe: null,
    banner,
    config,
    coverage: {
      status: complete ? "complete" : "incomplete",
      examined_bytes: search.bytes.length,
      examined_entries: config.option_count,
    },
    limitations: [
      ...baseLimitations(),
      ...search.extraLimitations,
      ...(found === "truncated"
        ? [
            "An IKCFG_ST gzip member runs past the searched bytes. The config is incomplete and is not reported as absent.",
          ]
        : []),
      ...(found === "exhausted"
        ? [
            `The config search stopped after ${String(MAX_CONFIG_CANDIDATES)} IKCFG_ST gzip candidates or ${String(CONFIG_SEARCH_BUDGET_FACTOR)} times max_config_bytes of inflated output without accepting a config. Candidates after that point were not inflated, so the config is incomplete and is not reported as absent.`,
          ]
        : []),
      ...(config.status === "malformed"
        ? [
            config.reason === "config_gzip_invalid"
              ? "An IKCFG_ST gzip member framed by IKCFG_ED does not decode or fails its CRC-32 or ISIZE check. The embedded config is unreadable and is not reported as absent."
              : "An IKCFG_ST gzip member framed by IKCFG_ED inflates to text that is not a .config. The embedded config is unreadable and is not reported as absent.",
          ]
        : []),
    ],
  };
};

interface BzImagePayload {
  readonly offset: number;
  readonly bytes: number;
}

/** x86 boot protocol: `HdrS` at 0x202, payload fields from version 2.08. */
const readBzImage = (
  bytes: Buffer,
):
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "truncated"; payload: BzImagePayload }
  | { kind: "payload"; payload: BzImagePayload } => {
  if (bytes.length < 0x206 || bytes.toString("latin1", 0x202, 0x206) !== "HdrS")
    return { kind: "none" };
  if (bytes.length < 0x250 || bytes.readUInt16LE(0x206) < 0x0208)
    return { kind: "unavailable" };
  const setupSects = bytes[0x1f1] === 0 ? 4 : (bytes[0x1f1] ?? 4);
  const payload = {
    offset: (setupSects + 1) * 512 + bytes.readUInt32LE(0x248),
    bytes: bytes.readUInt32LE(0x24c),
  };
  if (payload.bytes === 0) return { kind: "unavailable" };
  return payload.offset > bytes.length ||
    payload.bytes > bytes.length - payload.offset
    ? { kind: "truncated", payload }
    : { kind: "payload", payload };
};

const closedReport = (
  artifact: Report["artifact"],
  format: Report["format"],
  input: InspectKernelBuildConfigInput,
  payload: Report["payload"],
  reason: Reason,
  status: "incomplete" | "unsupported",
  limitation: string,
): Report => ({
  artifact,
  format,
  payload,
  next_probe:
    status === "unsupported"
      ? {
          operation: "external_decompression",
          rationale: `Decompress this ${payload.codec ?? "unrecognized"} payload with an external utility into a separate file, then call inspect_kernel_build_config on that file. REA inflates only a gzip payload inside an x86 bzImage.`,
        }
      : null,
  banner: absentBanner("unknown"),
  config: emptyConfig(input, status, reason),
  coverage: { status, examined_bytes: 0, examined_entries: 0 },
  limitations: [...baseLimitations(), limitation],
});

const NOT_SEARCHED =
  "The banner and embedded config were not searched and are not reported as absent.";

const bzImageReport = async (
  bytes: Buffer,
  artifact: Report["artifact"],
  input: InspectKernelBuildConfigInput,
  header: Exclude<ReturnType<typeof readBzImage>, { kind: "none" }>,
  signal: AbortSignal | undefined,
): Promise<Report> => {
  if (header.kind === "unavailable")
    return closedReport(
      artifact,
      "file",
      input,
      {
        container: "bzimage",
        codec: null,
        status: "unavailable",
        offset: null,
        bytes: null,
        inflated_bytes: null,
      },
      "setup_header_payload_unavailable",
      "incomplete",
      `The x86 setup header does not carry a usable payload_offset and payload_length (boot protocol 2.08 or later). ${NOT_SEARCHED}`,
    );
  if (header.kind === "truncated")
    return closedReport(
      artifact,
      "file",
      input,
      {
        container: "bzimage",
        codec: null,
        status: "truncated",
        offset: null,
        bytes: null,
        inflated_bytes: null,
      },
      "payload_truncated",
      "incomplete",
      `The bzImage payload declared by the setup header extends past the file. ${NOT_SEARCHED}`,
    );
  const { payload } = header;
  // Detection and inflation read only the declared payload range.
  const body = bytes.subarray(payload.offset, payload.offset + payload.bytes);
  const codec = codecAt(body, 0);
  const base = {
    container: "bzimage" as const,
    offset: payload.offset,
    bytes: payload.bytes,
  };
  if (codec !== "gzip")
    return closedReport(
      artifact,
      "file",
      input,
      { ...base, codec, status: "unsupported", inflated_bytes: null },
      codec === null
        ? "unrecognized_payload_codec"
        : "payload_codec_unsupported",
      "unsupported",
      `The bzImage payload codec is ${codec ?? "not recognized"} and was not inflated. ${NOT_SEARCHED}`,
    );
  // Only the leading gzip member is inflated; its own ISIZE trailer carries
  // the length. Bytes after the member inside the payload are not read.
  assertArtifactReadActive(signal);
  const member = await inflateGzipMember(
    body,
    0,
    input.max_payload_bytes,
    signal,
  );
  if (member.kind === "limit")
    budget("max_payload_bytes", input.max_payload_bytes);
  if (member.kind !== "member")
    return closedReport(
      artifact,
      "file",
      input,
      {
        ...base,
        codec,
        status: member.kind === "truncated" ? "truncated" : "malformed",
        inflated_bytes: null,
      },
      member.kind === "truncated"
        ? "payload_truncated"
        : "payload_gzip_invalid",
      "incomplete",
      member.kind === "truncated"
        ? `The bzImage gzip payload ends before its gzip member does. ${NOT_SEARCHED}`
        : `The bzImage gzip payload is not a valid gzip member or fails its CRC-32 or ISIZE check. ${NOT_SEARCHED}`,
    );
  return reportFromSearch(
    artifact,
    "file",
    input,
    {
      bytes: member.output,
      space: "inflated_payload",
      payload: {
        ...base,
        codec,
        status: "inflated",
        inflated_bytes: member.output.length,
      },
      extraLimitations: [
        "Banner and config locations with space inflated_payload are offsets in the inflated bzImage payload, not file offsets.",
      ],
    },
    signal,
  );
};

/**
 * Read a kernel version banner and an embedded IKCFG build config.
 * The caller supplies the already bounded file bytes. Scans yield to the event
 * loop once per TURN_STRIDE bytes and inflation runs off it, so an abort raised
 * while parsing is honored at the next check. One inflate call runs to its
 * output bound once started.
 */
export const parseKernelBuildConfig = async (
  bytes: Buffer,
  artifact: Report["artifact"],
  input: InspectKernelBuildConfigInput,
  signal?: AbortSignal,
): Promise<Report> => {
  const elf = isElf(bytes);
  if (!elf) {
    const header = readBzImage(bytes);
    if (header.kind !== "none")
      return bzImageReport(bytes, artifact, input, header, signal);
    const whole = codecAt(bytes, 0);
    if (whole !== null)
      return closedReport(
        artifact,
        "file",
        input,
        {
          container: "file",
          codec: whole,
          status: "unsupported",
          offset: 0,
          bytes: bytes.length,
          inflated_bytes: null,
        },
        "payload_codec_unsupported",
        "unsupported",
        `This file starts with a ${whole} stream and has no x86 setup header. It was not inflated. ${NOT_SEARCHED}`,
      );
  }
  return reportFromSearch(
    artifact,
    elf ? "elf" : "file",
    input,
    {
      bytes,
      space: "file",
      payload: {
        container: "file",
        codec: null,
        status: "uncompressed",
        offset: null,
        bytes: null,
        inflated_bytes: null,
      },
      extraLimitations: [],
    },
    signal,
  );
};
