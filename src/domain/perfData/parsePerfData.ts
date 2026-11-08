import { createHash } from "node:crypto";
import { ok, type Result } from "../result.js";
import {
  PERF_DATA_MAX_DIAGNOSTICS,
  type PerfData,
  type PerfDataArtifact,
  type PerfEvent,
} from "./perfData.js";

/**
 * `struct perf_file_header` (tools/perf/util/header.h):
 *   u64 magic, u64 size, u64 attr_size,
 *   perf_file_section attrs, data, event_types,
 *   unsigned long adds_features[HEADER_FEAT_BITS / BITS_PER_LONG].
 * Little- and big-endian recordings share the field order and differ only in
 * byte order, so one reader with an explicit endianness covers both.
 */
const MAGIC = "PERFILE2";
/** Offset of `size`; the header extent is the writer's own `sizeof(header)`. */
const HEADER_SIZE_FIELD = 0x08;
/** `sizeof(perf_file_header)` up to (not including) `adds_features`. */
const HEADER_BYTES_WITHOUT_FEATURES = 0x48;
/** `sizeof(perf_file_header)` with a 256-bit feature bitmap. */
const HEADER_BYTES_WITH_FEATURES = 0x68;
const ATTR_SIZE_FIELD = 0x10;
const ATTRS_SECTION_FIELD = 0x18;
const DATA_SECTION_FIELD = 0x28;

/**
 * `struct perf_event_attr` common prefix. Fields past the common prefix depend
 * on the selected `type`, so only the part every event shares is read.
 */
const ATTR_TYPE_OFFSET = 0x00;
const ATTR_SIZE_OFFSET = 0x04;
const ATTR_CONFIG_OFFSET = 0x08;
const ATTR_SAMPLE_PERIOD_OFFSET = 0x10;
const ATTR_SAMPLE_TYPE_OFFSET = 0x18;
const ATTR_READ_FORMAT_OFFSET = 0x20;
const ATTR_FLAGS_OFFSET = 0x28;
/**
 * `PERF_ATTR_SIZE_VER0` is 64 bytes; `perf_event_attr.size` below that cannot
 * describe an event, and no later version shortened it.
 */
const ATTR_SIZE_MIN = 64;
/** Bit 10 of the little-endian flag word is `freq`: sample_period is a frequency. */
const ATTR_FLAG_FREQ = 0x400n;
/**
 * Entries may share one ids extent, so the per-entry reading asks the whole
 * file again for each group; the retained list is what bounds the reply.
 */
const MAX_RETAINED_IDENTIFIERS = 200_000;
/**
 * `attr_size` is `sizeof(struct perf_event_attr) + sizeof(perf_file_section)`:
 * each entry ends with the offset/size of that event's id array.
 */
const PERF_FILE_SECTION_BYTES = 16;

type Diagnostic = Omit<PerfData["diagnostics"][number], "diagnostic_id">;

interface DecodeState {
  /** Binds every derived fact id to the recording it was read from. */
  readonly recording: string;
  readonly events: PerfEvent[];
  readonly diagnostics: Diagnostic[];
  readonly maxEvents: number;
  eventLimitReported: boolean;
  diagnosticsSuppressed: boolean;
  /** Identifiers read so far; an unusable section leaves a group's count unknown. */
  identifiers: number;
  /** Every retained identifier, to bound the total across entries. */
  readonly identified: number[];
  /** False once any entry's ids section could not be read as declared. */
  identifiersPresent: boolean;
}

const digest = (prefix: string, ...parts: (string | number)[]) =>
  `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex")}`;

const withinFile = (fileBytes: number, offset: number, size: number): boolean =>
  offset + size <= fileBytes;

const diagnose = (
  state: DecodeState,
  ordinal: number | null,
  code: Diagnostic["code"],
  message: string,
): void => {
  if (state.diagnostics.length >= PERF_DATA_MAX_DIAGNOSTICS) {
    state.diagnosticsSuppressed = true;
    return;
  }
  state.diagnostics.push({ ordinal, code, message });
};

/** Endianness-aware fixed-width field readers over the whole file. */
interface Reader {
  readonly little: boolean;
  u64(bytes: Buffer, offset: number): number | null;
  /** The flag word itself, which can exceed a safe integer and is never numeric. */
  u64Bits(bytes: Buffer, offset: number): bigint | null;
  u32(bytes: Buffer, offset: number): number;
}

const readerFor = (little: boolean): Reader => ({
  little,
  u64(bytes, offset) {
    if (offset + 8 > bytes.length) return null;
    const value = little
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
  },
  u64Bits(bytes, offset) {
    if (offset + 8 > bytes.length) return null;
    return little
      ? bytes.readBigUInt64LE(offset)
      : bytes.readBigUInt64BE(offset);
  },
  u32(bytes, offset) {
    if (offset + 4 > bytes.length) return 0;
    return little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  },
});

/**
 * `perf_event_attr` stores `freq` and its siblings in a C bitfield. A
 * big-endian host allocates those bits from the high end of the 64-bit word
 * and `perf` reorders them with `swap_bitfield` on read, so bit 10 is `freq`
 * only in the little-endian word the on-disk layout is defined around. The raw
 * big-endian word has to be mirrored before the same mask applies.
 */
const flagBitSet = (flags: bigint, little: boolean): boolean => {
  const word = little ? flags : swapBitfield(flags);
  return (word & ATTR_FLAG_FREQ) !== 0n;
};

const swapBitfield = (word: bigint): bigint => {
  let swapped = 0n;
  for (let bit = 0n; bit < 64n; bit += 1n)
    if (((word >> bit) & 1n) === 1n) swapped |= 1n << (63n - bit);
  return swapped;
};

interface Section {
  readonly offset: number;
  readonly size: number;
  readonly within_file: boolean;
}

const sectionAt = (
  bytes: Buffer,
  read: Reader,
  field: number,
): Section | null => {
  const offset = read.u64(bytes, field);
  const size = read.u64(bytes, field + 8);
  if (offset === null || size === null) return null;
  return { offset, size, within_file: withinFile(bytes.length, offset, size) };
};

/**
 * Walks the attribute section. Each entry is `attr_size` bytes: a
 * `perf_event_attr` followed by the `perf_file_section` locating its ids.
 */
const readEvents = (
  bytes: Buffer,
  read: Reader,
  state: DecodeState,
  section: Section,
  stride: number,
): void => {
  const end = section.offset + section.size;
  let cursor = section.offset;
  while (cursor < end) {
    if (state.events.length >= state.maxEvents) {
      if (!state.eventLimitReported)
        diagnose(
          state,
          null,
          "event-limit-reached",
          `Stopped at max_events=${state.maxEvents}; later event attributes are not listed.`,
        );
      state.eventLimitReported = true;
      return;
    }
    if (cursor + stride > end) {
      diagnose(
        state,
        null,
        "truncated-event-attribute",
        `The attribute section ends ${stride - (end - cursor)} bytes into the entry at ${cursor}; it was not read.`,
      );
      return;
    }
    const declared = read.u32(bytes, cursor + ATTR_SIZE_OFFSET);
    if (
      declared < ATTR_SIZE_MIN ||
      declared + PERF_FILE_SECTION_BYTES > stride
    ) {
      diagnose(
        state,
        null,
        "unsupported-attribute-size",
        `The entry at ${cursor} declares a ${declared}-byte attribute, which cannot fit the ${stride}-byte stride.`,
      );
      return;
    }
    const ordinal = state.events.length;
    const ids = sectionAt(
      bytes,
      read,
      cursor + stride - PERF_FILE_SECTION_BYTES,
    );
    if (ids === null) {
      diagnose(
        state,
        ordinal,
        "invalid-ids-section",
        `The entry at ${cursor} has no readable ids section.`,
      );
    }
    const idsList: number[] = [];
    let idsTruncated = false;
    if (ids !== null) {
      // The writer places the id arrays outside the attribute entries, so an
      // offset inside the entry is not required; containment in the file is.
      if (ids.size % 8 !== 0 || !ids.within_file) {
        diagnose(
          state,
          ordinal,
          "invalid-ids-section",
          `The entry at ${cursor} declares ids at ${ids.offset} for ${ids.size} bytes, which is not a whole number of in-file identifiers.`,
        );
      } else {
        // Entries can all point at one large extent, so the retained identifier
        // count is bounded independently of the file and event allowances.
        for (let at = ids.offset; at < ids.offset + ids.size; at += 8) {
          if (state.identified.length >= MAX_RETAINED_IDENTIFIERS) {
            idsTruncated = true;
            break;
          }
          const id = read.u64(bytes, at);
          // An identifier above a safe integer is still an identifier; stopping
          // here silently would publish a shorter extent as the whole one.
          if (id === null) {
            idsTruncated = true;
            state.identifiersPresent = false;
            break;
          }
          idsList.push(id);
          state.identified.push(id);
        }
      }
      if (ids.size % 8 !== 0 || !ids.within_file)
        state.identifiersPresent = false;
      else state.identifiers += idsList.length;
    }
    const flags = read.u64Bits(bytes, cursor + ATTR_FLAGS_OFFSET);
    state.events.push({
      event_id: digest("perf_event", state.recording, section.offset, cursor),
      ordinal,
      type: read.u32(bytes, cursor + ATTR_TYPE_OFFSET),
      config: read.u64(bytes, cursor + ATTR_CONFIG_OFFSET),
      sample_type:
        stride >= ATTR_SAMPLE_TYPE_OFFSET + 8
          ? read.u64(bytes, cursor + ATTR_SAMPLE_TYPE_OFFSET)
          : null,
      read_format:
        stride >= ATTR_READ_FORMAT_OFFSET + 8
          ? read.u64(bytes, cursor + ATTR_READ_FORMAT_OFFSET)
          : null,
      sample_period:
        stride >= ATTR_SAMPLE_PERIOD_OFFSET + 8
          ? read.u64(bytes, cursor + ATTR_SAMPLE_PERIOD_OFFSET)
          : null,
      sample_freq: flags === null ? null : flagBitSet(flags, read.little),
      attr_bytes: declared,
      ids_section: ids,
      ids: idsList,
      ids_truncated: idsTruncated,
      file_offset: cursor,
    });
    cursor += stride;
  }
};

const coverage = (complete: boolean): PerfData["source_coverage"] => ({
  scope: "header-and-event-attributes",
  status: complete ? "complete-within-scope" : "partial",
  features: "not-decoded",
  sample_records: "not-decoded",
  sample_attribution: "not-derived",
  callchains: "not-decoded",
  symbols: "not-resolved",
  build_ids: "not-decoded",
  network: "not-contacted",
});

const LIMITATIONS = [
  "Only the file header, its two data sections and the event attribute entries are inventoried; feature payloads and sample records are not decoded in this step.",
  "Sample periods and frequencies are the declared sampling settings, not an execution count, CPU time, or proof that the target ran.",
  "Callchains, sampled instruction addresses, module build identities and symbol names are absent; resolved functions require a later step.",
];

const emptyRecording = (
  artifact: PerfDataArtifact,
  diagnostics: Diagnostic[],
  byteOrder: "little-endian" | "big-endian",
): PerfData => ({
  recording_id: digest("perf_data", artifact.sha256),
  format: "perf-data",
  artifact,
  file_header: {
    magic: "PERFILE2",
    byte_order: byteOrder,
    header_bytes: 0,
    attribute_bytes: 0,
    feature_bitmap: "absent",
  },
  attribute_section: { offset: 0, size: 0, within_file: false },
  data_section: { offset: 0, size: 0, within_file: false },
  events: [],
  diagnostics: withIds(diagnostics, artifact.sha256, 0),
  summary: {
    events: 0,
    identifiers: 0,
    identifiers_present: false,
    diagnostics: diagnostics.length,
  },
  source_coverage: coverage(false),
  limitations: LIMITATIONS,
});

/**
 * Every fact id is bound to the recording it was read from. Two different
 * recordings can hold identical attribute sections — the same ordinary
 * event layout at the same offsets — so hashing offsets alone would give
 * their events the same id and alias unrelated facts across artifacts.
 */
const withIds = (
  diagnostics: readonly Diagnostic[],
  recording: string,
  allowance: number,
) =>
  diagnostics.map((entry, index) => ({
    ...entry,
    diagnostic_id: digest(
      "perf_diagnostic",
      recording,
      allowance,
      index,
      entry.code,
    ),
  }));

/**
 * The magic encodes the recording host's byte order and reads `PERFILE2` in
 * it, so both spellings are accepted and the chosen order drives every read.
 */
const byteOrder = (bytes: Buffer): boolean | null => {
  if (bytes.length < 8) return null;
  const magic = bytes.toString("latin1", 0, 8);
  if (magic === MAGIC) return true;
  return magic === [...MAGIC].reverse().join("") ? false : null;
};

export const parsePerfData = (
  bytes: Buffer,
  artifact: PerfDataArtifact,
  options: { readonly maxEvents: number },
): Result<PerfData, never> => {
  const state: DecodeState = {
    recording: artifact.sha256,
    events: [],
    diagnostics: [],
    maxEvents: options.maxEvents,
    eventLimitReported: false,
    diagnosticsSuppressed: false,
    identifiers: 0,
    identified: [],
    identifiersPresent: true,
  };
  const little = byteOrder(bytes);
  if (little === null) {
    diagnose(
      state,
      null,
      "not-a-perf-data-file",
      "The file does not start with the PERFILE2 magic in either byte order.",
    );
    return ok(emptyRecording(artifact, state.diagnostics, "little-endian"));
  }
  const read = readerFor(little);
  const order = little ? "little-endian" : "big-endian";
  const headerBytes = read.u64(bytes, HEADER_SIZE_FIELD);
  if (
    headerBytes === null ||
    bytes.length < headerBytes ||
    (headerBytes !== HEADER_BYTES_WITHOUT_FEATURES &&
      headerBytes !== HEADER_BYTES_WITH_FEATURES)
  ) {
    diagnose(
      state,
      null,
      "truncated-header",
      headerBytes === null
        ? `The file ends at ${bytes.length} bytes, before the size field of the perf_file_header.`
        : bytes.length < headerBytes
          ? `The header declares ${headerBytes} bytes but the file ends at ${bytes.length}, so its sections were not read.`
          : `The header declares ${headerBytes} bytes; this inventory accepts the ${HEADER_BYTES_WITHOUT_FEATURES}- and ${HEADER_BYTES_WITH_FEATURES}-byte layouts.`,
    );
    return ok(emptyRecording(artifact, state.diagnostics, order));
  }
  const stride = read.u64(bytes, ATTR_SIZE_FIELD) ?? 0;
  const attributeSection = sectionAt(bytes, read, ATTRS_SECTION_FIELD);
  const dataSection = sectionAt(bytes, read, DATA_SECTION_FIELD);
  if (attributeSection === null || dataSection === null) {
    diagnose(
      state,
      null,
      "truncated-header",
      "The attribute or data section header could not be read.",
    );
    return ok(emptyRecording(artifact, state.diagnostics, order));
  }
  const attributeFits =
    attributeSection.within_file &&
    // The file header precedes the sections; bytes inside it are not attributes.
    !(
      attributeSection.size > 0 &&
      attributeSection.offset < (headerBytes ?? HEADER_BYTES_WITHOUT_FEATURES)
    ) &&
    !(
      attributeSection.offset <= dataSection.offset &&
      attributeSection.offset + attributeSection.size > dataSection.offset
    ) &&
    !(
      attributeSection.offset > dataSection.offset &&
      dataSection.offset + dataSection.size > attributeSection.offset
    );
  if (!attributeSection.within_file)
    diagnose(
      state,
      null,
      "invalid-attribute-section",
      `The attribute section declares bytes ${attributeSection.offset}..${attributeSection.offset + attributeSection.size}, past the ${bytes.length}-byte file.`,
    );
  else if (!attributeFits)
    diagnose(
      state,
      null,
      "attribute-section-overlap",
      "The attribute and data sections overlap, so neither extent is trusted.",
    );
  else if (attributeSection.size === 0)
    diagnose(
      state,
      null,
      "empty-attribute-section",
      "The attribute section is empty; the recording states no events.",
    );
  else if (stride <= 0 || stride < ATTR_SIZE_MIN + PERF_FILE_SECTION_BYTES)
    diagnose(
      state,
      null,
      "unsupported-attribute-size",
      `The attribute entry stride is ${stride} bytes, which cannot hold an attribute and its ids section.`,
    );
  else readEvents(bytes, read, state, attributeSection, stride);
  if (state.diagnosticsSuppressed)
    state.diagnostics.push({
      ordinal: null,
      code: "diagnostic-limit-reached",
      message: `More than ${PERF_DATA_MAX_DIAGNOSTICS} diagnostics; the rest were summarised.`,
    });
  return ok({
    recording_id: digest("perf_data", artifact.sha256),
    format: "perf-data",
    artifact,
    file_header: {
      magic: "PERFILE2",
      byte_order: order,
      header_bytes: headerBytes,
      attribute_bytes: stride,
      feature_bitmap:
        headerBytes === HEADER_BYTES_WITH_FEATURES ? "present" : "absent",
    },
    attribute_section: attributeSection,
    data_section: dataSection,
    events: state.events,
    diagnostics: withIds(state.diagnostics, artifact.sha256, options.maxEvents),
    summary: {
      events: state.events.length,
      identifiers: state.identifiers,
      identifiers_present: state.identifiersPresent,
      diagnostics: state.diagnostics.length,
    },
    source_coverage: coverage(
      !state.eventLimitReported &&
        !state.diagnosticsSuppressed &&
        state.diagnostics.length === 0,
    ),
    limitations: LIMITATIONS,
  });
};
