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
const EVENT_TYPES_SECTION_FIELD = 0x38;

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
  /** Some input was left unexamined; an informational diagnostic is not that. */
  incomplete: boolean;
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

/**
 * Whether [offset, offset + size) overlaps any byte another section owns. An
 * empty extent owns nothing, so it can be shared without conflict.
 */
const overlapsOwned = (
  offset: number,
  size: number,
  owners: readonly Section[],
): boolean =>
  size > 0 &&
  owners.some(
    (owner) =>
      owner.size > 0 &&
      offset < owner.offset + owner.size &&
      owner.offset < offset + size,
  );

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
  // `empty-attribute-section` states the recording carries no events; nothing
  // was left unexamined, so it must not turn a complete inventory partial.
  if (code !== "empty-attribute-section") state.incomplete = true;
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

/** A zero extent the parser reports when it never trusted a section header. */
const INERT_SECTION: Section = { offset: 0, size: 0, within_file: false };

interface Section {
  readonly offset: number;
  readonly size: number;
  readonly within_file: boolean;
}

/**
 * A section header as it was read. A fully present extent above
 * Number.MAX_SAFE_INTEGER is read, just not comparable, so it is reported back
 * as its own fact instead of as a header that could not be read at all.
 */
type SectionRead = {
  readonly section: Section | null;
  readonly unrepresentable: boolean;
};

const sectionAt = (bytes: Buffer, read: Reader, field: number): SectionRead => {
  const offset = read.u64(bytes, field);
  const size = read.u64(bytes, field + 8);
  if (offset === null || size === null)
    return { section: null, unrepresentable: true };
  return {
    section: {
      offset,
      size,
      within_file: withinFile(bytes.length, offset, size),
    },
    unrepresentable: false,
  };
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
  // Ranges the header already owns. An ids extent inside one of them would
  // decode those bytes as identifiers, so it is rejected instead.
  ownedSections: readonly Section[],
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
      // The unread entries can carry identifiers this pass never saw, so the
      // retained list is a prefix, not the recording's identifier inventory.
      // Leaving `identifiersPresent` set would publish "identifiers are here"
      // alongside a count that only covers the retained prefix.
      state.identifiersPresent = false;
      return;
    }
    if (cursor + stride > end) {
      diagnose(
        state,
        null,
        "truncated-event-attribute",
        `The attribute section ends ${stride - (end - cursor)} bytes into the entry at ${cursor}; it was not read.`,
      );
      // The walk stopped early: later entries can carry identifiers this pass
      // never saw, so the retained list is a prefix rather than the inventory.
      state.identifiersPresent = false;
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
      // Same early stop as a truncated entry: the entries behind this one were
      // never examined, so the identifier inventory stays incomplete.
      state.identifiersPresent = false;
      return;
    }
    const ordinal = state.events.length;
    const idsRead = sectionAt(
      bytes,
      read,
      cursor + stride - PERF_FILE_SECTION_BYTES,
    );
    const ids = idsRead.section;
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
    if (ids === null) {
      // The entry names an ids section, so this group's identifiers exist even
      // though the extent that locates them could not be read.
      state.identifiersPresent = false;
    } else {
      // The writer places the id arrays outside the attribute entries, so an
      // offset inside the entry is not required; containment in the file is.
      if (overlapsOwned(ids.offset, ids.size, ownedSections)) {
        // Entries may share one ids extent, which stays legitimate, but bytes
        // the header already assigned to the header, attributes, data or event
        // types are not an identifier array.
        diagnose(
          state,
          ordinal,
          "invalid-ids-section",
          `The entry at ${cursor} declares ids at ${ids.offset} for ${ids.size} bytes, which overlaps a section the header already owns.`,
        );
      } else if (ids.size % 8 !== 0 || !ids.within_file) {
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
            state.identifiersPresent = false;
            diagnose(
              state,
              ordinal,
              "identifier-inventory-truncated",
              `The retained identifier inventory reached its ${String(MAX_RETAINED_IDENTIFIERS)}-identifier allowance, so this and later identifiers in the extent were not retained.`,
            );
            break;
          }
          const id = read.u64(bytes, at);
          // An identifier above a safe integer is still an identifier; stopping
          // here silently would publish a shorter extent as the whole one.
          if (id === null) {
            diagnose(
              state,
              ordinal,
              "unsafe-identifier",
              `The identifier at ${at} exceeds Number.MAX_SAFE_INTEGER, so this and later identifiers in the extent were not retained.`,
            );
            idsTruncated = true;
            state.identifiersPresent = false;
            break;
          }
          idsList.push(id);
          state.identified.push(id);
        }
      }
      // An extent that was rejected rather than decoded leaves this group's
      // identifiers unknown, the same as one that is not a whole number of
      // identifiers, so the summary cannot report a complete inventory.
      if (
        ids.size % 8 !== 0 ||
        !ids.within_file ||
        overlapsOwned(ids.offset, ids.size, ownedSections)
      )
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

/**
 * A recording whose magic was not found: the byte order, header extent and
 * stride were never observed, so each stays unknown instead of naming the
 * layout the caller happened to expect.
 */
const noHeaderRecording = (
  artifact: PerfDataArtifact,
  diagnostics: Diagnostic[],
): PerfData => ({
  recording_id: digest("perf_data", artifact.sha256),
  format: "perf-data",
  artifact,
  file_header: {
    // A file that failed the magic check stated no layout, so reporting the
    // expected magic here would pair a rejection with a value never observed.
    magic: null,
    byte_order: null,
    header_bytes: null,
    attribute_bytes: null,
    feature_bitmap: null,
  },
  attribute_section: INERT_SECTION,
  data_section: INERT_SECTION,
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
 * A recording whose header was read but whose sections were not walked: the
 * magic and byte order are kept, and the extents are stated as 0 because this
 * inventory published no attribute or data section from them.
 */
const emptyRecording = (
  artifact: PerfDataArtifact,
  diagnostics: Diagnostic[],
  byteOrder: "little-endian" | "big-endian",
): PerfData => ({
  ...noHeaderRecording(artifact, diagnostics),
  file_header: {
    magic: "PERFILE2",
    byte_order: byteOrder,
    header_bytes: 0,
    attribute_bytes: 0,
    feature_bitmap: "absent",
  },
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
    incomplete: false,
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
    return ok(noHeaderRecording(artifact, state.diagnostics));
  }
  const read = readerFor(little);
  const order = little ? "little-endian" : "big-endian";
  const headerBytes = read.u64(bytes, HEADER_SIZE_FIELD);
  // A present-but-unrepresentable size is not a truncation: every byte the
  // field occupies is there, so the file is reported as an unsupported layout
  // instead of claiming it ended before a field it actually carries. A field
  // that is not there at all is a truncation, and `u64` cannot say which it
  // saw because both cases return null, so test presence on the raw field.
  const headerSizePresent = read.u64Bits(bytes, HEADER_SIZE_FIELD) !== null;
  const headerUnrepresentable = headerSizePresent && headerBytes === null;
  if (
    !headerSizePresent ||
    headerUnrepresentable ||
    bytes.length < (headerBytes ?? 0) ||
    (headerBytes !== HEADER_BYTES_WITHOUT_FEATURES &&
      headerBytes !== HEADER_BYTES_WITH_FEATURES)
  ) {
    diagnose(
      state,
      null,
      "truncated-header",
      !headerSizePresent
        ? `The file ends before its ${HEADER_SIZE_FIELD + 8}-byte header size field, so its sections were not read.`
        : headerUnrepresentable
          ? `The header size exceeds Number.MAX_SAFE_INTEGER, so the declared layout cannot be compared and its sections were not read.`
          : bytes.length < (headerBytes ?? 0)
            ? `The header declares ${headerBytes} bytes but the file ends at ${bytes.length}, so its sections were not read.`
            : `The header declares ${headerBytes} bytes; this inventory accepts the ${HEADER_BYTES_WITHOUT_FEATURES}- and ${HEADER_BYTES_WITH_FEATURES}-byte layouts.`,
    );
    return ok(emptyRecording(artifact, state.diagnostics, order));
  }
  const rawStride = read.u64(bytes, ATTR_SIZE_FIELD);
  // A present-but-unrepresentable field stays unknown instead of becoming the
  // zero-byte stride a different diagnostic would report.
  const stride = rawStride ?? 0;
  // The stride is a header fact independent of the section extents below, so
  // report it before any extent branch can return early; otherwise a rejected
  // attribute extent hides that the recorded stride itself is unreadable.
  if (rawStride === null)
    diagnose(
      state,
      null,
      "unsafe-attribute-size",
      `The attribute entry stride exceeds Number.MAX_SAFE_INTEGER, so the recorded value cannot be represented and the events were not read.`,
    );
  const attributeRead = sectionAt(bytes, read, ATTRS_SECTION_FIELD);
  const dataRead = sectionAt(bytes, read, DATA_SECTION_FIELD);
  const attributeSection = attributeRead.section;
  const dataSection = dataRead.section;
  if (
    attributeSection === null ||
    dataSection === null ||
    attributeRead.unrepresentable ||
    dataRead.unrepresentable
  ) {
    diagnose(
      state,
      null,
      "unsafe-section-extent",
      "The attribute or data section extent exceeds Number.MAX_SAFE_INTEGER, so its range cannot be compared with the file.",
    );
    return ok(emptyRecording(artifact, state.diagnostics, order));
  }
  const attributeInHeader =
    attributeSection.size > 0 &&
    attributeSection.offset < (headerBytes ?? HEADER_BYTES_WITHOUT_FEATURES);
  // `event_types` is its own header section; bytes it owns are not attribute
  // entries, so an attribute walk over them would publish event-type bytes as
  // events. Only a readable, nonempty extent can conflict.
  const eventTypesRead = sectionAt(bytes, read, EVENT_TYPES_SECTION_FIELD);
  const eventTypes = eventTypesRead.section;
  // `sectionAt` reports the whole extent as unrepresentable when either half
  // is, so the serialized size is read again to tell a zero-byte section from
  // one whose size could not be read at all.
  const eventTypesSize = read.u64(bytes, EVENT_TYPES_SECTION_FIELD + 8);
  // An unrepresentable `event_types` extent with a nonzero size owns unknown
  // bytes, so whether the walk publishes its contents cannot be decided:
  // treating it as absent is what the overlap predicate below would do, and the
  // walk would then publish contested attribute bytes as events while still
  // reporting complete scope.
  //
  // A serialized zero size proves the section owns no bytes, so its offset
  // cannot create an overlap. The offset is still unrepresentable and worth
  // reporting, but dropping otherwise readable attributes would state less
  // than the file does.
  if (eventTypesRead.unrepresentable && eventTypesSize !== 0) {
    diagnose(
      state,
      null,
      "unsafe-section-extent",
      eventTypesSize === null
        ? "The event-types section size exceeds Number.MAX_SAFE_INTEGER, so its range cannot be compared with the attribute section."
        : "The event-types section offset exceeds Number.MAX_SAFE_INTEGER while it declares bytes, so its range cannot be compared with the attribute section.",
    );
    return ok(emptyRecording(artifact, state.diagnostics, order));
  }
  if (eventTypesRead.unrepresentable)
    diagnose(
      state,
      null,
      "unsafe-section-extent",
      "The event-types section offset exceeds Number.MAX_SAFE_INTEGER, so its position cannot be compared with the attribute section; it declares no bytes.",
    );
  const attributeOverlapsEventTypes =
    eventTypes !== null &&
    attributeSection.size > 0 &&
    eventTypes.size > 0 &&
    attributeSection.offset < eventTypes.offset + eventTypes.size &&
    eventTypes.offset < attributeSection.offset + attributeSection.size;
  const attributeFits =
    attributeSection.within_file &&
    // The file header precedes the sections; bytes inside it are not attributes.
    !attributeInHeader &&
    !attributeOverlapsEventTypes &&
    // An empty extent owns no bytes, so it cannot overlap another section:
    // a zero-length data section between attribute entries is not a conflict.
    !(
      attributeSection.size > 0 &&
      dataSection.size > 0 &&
      ((attributeSection.offset <= dataSection.offset &&
        attributeSection.offset + attributeSection.size > dataSection.offset) ||
        (attributeSection.offset > dataSection.offset &&
          dataSection.offset + dataSection.size > attributeSection.offset))
    );
  // A rejected attribute extent means no entry was examined, so the recording
  // states no identifier inventory this pass can defend. Reporting `true` with
  // a zero count would present an unread section as a complete empty one.
  if (!attributeFits && attributeSection.size > 0)
    state.identifiersPresent = false;
  if (!attributeSection.within_file)
    diagnose(
      state,
      null,
      "invalid-attribute-section",
      `The attribute section declares bytes ${attributeSection.offset}..${attributeSection.offset + attributeSection.size}, past the ${bytes.length}-byte file.`,
    );
  else if (attributeInHeader)
    diagnose(
      state,
      null,
      "header-attribute-overlap",
      `The attribute section declares bytes ${attributeSection.offset}..${attributeSection.offset + attributeSection.size} inside the ${String(headerBytes)}-byte file header, so the attribute extent is not trusted.`,
    );
  else if (!attributeFits)
    diagnose(
      state,
      null,
      "attribute-section-overlap",
      attributeOverlapsEventTypes
        ? "The attribute and event-types sections overlap, so the attribute extent is not trusted."
        : "The attribute and data sections overlap, so neither extent is trusted.",
    );
  else {
    // The stride is a fact about the header too, so an unusable one is
    // reported whatever the section holds: an empty section alone leaves scope
    // complete, and a malformed stride would then read as a legitimate empty
    // recording.
    const strideFitsEntry =
      rawStride !== null && stride >= ATTR_SIZE_MIN + PERF_FILE_SECTION_BYTES;
    if (rawStride !== null && !strideFitsEntry)
      diagnose(
        state,
        null,
        "unsupported-attribute-size",
        `The attribute entry stride is ${stride} bytes, which cannot hold an attribute and its ids section.`,
      );
    if (attributeSection.size === 0)
      diagnose(
        state,
        null,
        "empty-attribute-section",
        "The attribute section is empty; the recording states no events.",
      );
    else if (strideFitsEntry)
      readEvents(bytes, read, state, attributeSection, stride, [
        {
          offset: 0,
          size: headerBytes ?? HEADER_BYTES_WITHOUT_FEATURES,
          within_file: true,
        },
        attributeSection,
        dataSection,
        ...(eventTypes === null ? [] : [eventTypes]),
      ]);
  }
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
      attribute_bytes: rawStride,
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
    source_coverage: coverage(!state.incomplete),
    limitations: LIMITATIONS,
  });
};
