import { setImmediate } from "node:timers/promises";
import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  PE_RICH_HEADER_ABSENT_LIMITATION,
  PE_RICH_HEADER_ENTRY_BYTES,
  PE_RICH_HEADER_FOOTER_BYTES,
  PE_RICH_HEADER_LIMITATIONS,
  PE_RICH_HEADER_START_BYTES,
  type InspectPeRichHeaderInput,
  type PeRichHeader,
  type PeRichHeaderEntry,
  type PeRichHeaderRecord,
} from "../../domain/native/peRichHeader.js";
import { readPeHeaders } from "./PeResourceLayout.js";

const DOS_HEADER_BYTES = 0x40;
const E_LFANEW_OFFSET = 0x3c;
const RICH_MARKER = Buffer.from("Rich", "latin1");
/** `DanS` read as a little-endian DWORD before the key is applied. */
const DANS = 0x536e6144;
/** Bytes scanned or summed between event-loop yields and cancellation checks. */
const BYTES_PER_YIELD = 1 << 20;

const rotateLeft = (value: number, shift: number): number => {
  const bits = shift & 31;
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
};

const pause = async (signal: AbortSignal | undefined): Promise<void> => {
  await setImmediate();
  assertArtifactReadActive(signal);
};

/**
 * The last DWORD-aligned `Rich` marker whose key ends at or before the PE
 * signature. A custom DOS stub can embed another image with its own footer;
 * the linker writes the image's record directly before the PE header.
 */
const footerOffset = (bytes: Buffer, peOffset: number): number | null => {
  const last = peOffset - PE_RICH_HEADER_FOOTER_BYTES;
  if (last < DOS_HEADER_BYTES) return null;
  let at = bytes.lastIndexOf(RICH_MARKER, last);
  while (at >= DOS_HEADER_BYTES && at % 4 !== 0)
    at = bytes.lastIndexOf(RICH_MARKER, at - 1);
  return at >= DOS_HEADER_BYTES ? at : null;
};

/** Walk back from the footer to the nearest `DanS` encoded with this key. */
const startOffset = async (
  bytes: Buffer,
  footer: number,
  key: number,
  signal: AbortSignal | undefined,
): Promise<number | null> => {
  const marker = (DANS ^ key) >>> 0;
  let scanned = 0;
  for (
    let at = footer - PE_RICH_HEADER_START_BYTES;
    at >= DOS_HEADER_BYTES;
    at -= 4
  ) {
    if (bytes.readUInt32LE(at) === marker) return at;
    scanned += 4;
    if (scanned % BYTES_PER_YIELD === 0) await pause(signal);
  }
  return null;
};

/**
 * The linker's checksum: the record's offset, plus every byte before it
 * except e_lfanew rotated left by its offset, plus every `@comp.id` rotated
 * left by its use count.
 */
const richChecksum = async (
  bytes: Buffer,
  start: number,
  entries: readonly PeRichHeaderEntry[],
  signal: AbortSignal | undefined,
): Promise<number> => {
  let checksum = start;
  for (let at = 0; at < start; at++) {
    if (at >= E_LFANEW_OFFSET && at < DOS_HEADER_BYTES) continue;
    checksum = (checksum + rotateLeft(bytes[at]!, at)) >>> 0;
    if ((at + 1) % BYTES_PER_YIELD === 0) await pause(signal);
  }
  for (const { product_id, build, count } of entries)
    checksum =
      (checksum + rotateLeft(((product_id << 16) | build) >>> 0, count)) >>> 0;
  return checksum;
};

const richRecord = async (
  bytes: Buffer,
  peOffset: number,
  input: InspectPeRichHeaderInput,
  signal: AbortSignal | undefined,
): Promise<PeRichHeaderRecord> => {
  const footer = footerOffset(bytes, peOffset);
  if (footer === null) return { state: "absent" };
  const key = bytes.readUInt32LE(footer + 4);
  const footerLocation = { offset: footer, bytes: PE_RICH_HEADER_FOOTER_BYTES };
  const start = await startOffset(bytes, footer, key, signal);
  if (start === null)
    return {
      state: "malformed",
      reason: "start_marker_missing",
      footer_location: footerLocation,
      key,
    };
  const span = footer - start - PE_RICH_HEADER_START_BYTES;
  if (span % PE_RICH_HEADER_ENTRY_BYTES !== 0)
    return {
      state: "malformed",
      reason: "partial_entry",
      footer_location: footerLocation,
      key,
    };
  const count = span / PE_RICH_HEADER_ENTRY_BYTES;
  if (count > input.max_entries)
    throw new ArtifactReaderFailure(
      "limit",
      `PE Rich header holds ${String(count)} entries, over the ${String(input.max_entries)}-entry budget.`,
      { boundary: "capacity" },
    );
  const decode = (at: number): number => (bytes.readUInt32LE(at) ^ key) >>> 0;
  const entries: PeRichHeaderEntry[] = [];
  for (
    let at = start + PE_RICH_HEADER_START_BYTES;
    at < footer;
    at += PE_RICH_HEADER_ENTRY_BYTES
  ) {
    const compId = decode(at);
    entries.push({
      product_id: compId >>> 16,
      build: compId & 0xffff,
      count: decode(at + 4),
    });
  }
  const computed = await richChecksum(bytes, start, entries, signal);
  return {
    state: "present",
    location: {
      offset: start,
      bytes: footer + PE_RICH_HEADER_FOOTER_BYTES - start,
    },
    footer_location: footerLocation,
    key,
    checksum: { computed, matches: computed === key },
    padding: [decode(start + 4), decode(start + 8), decode(start + 12)],
    entries,
  };
};

/** Read the Rich header between the DOS stub and the PE signature without executing the image. */
export const parsePeRichHeader = async (
  bytes: Buffer,
  artifact: PeRichHeader["artifact"],
  input: InspectPeRichHeaderInput,
  signal?: AbortSignal,
): Promise<PeRichHeader> => {
  assertArtifactReadActive(signal);
  const { machine, format, optionalHeaderOffset } = readPeHeaders(bytes);
  const peOffset = optionalHeaderOffset - 24;
  const record = await richRecord(bytes, peOffset, input, signal);
  return {
    artifact,
    format,
    machine,
    pe_header_offset: peOffset,
    rich_header: record,
    limitations:
      record.state === "absent"
        ? [...PE_RICH_HEADER_LIMITATIONS, PE_RICH_HEADER_ABSENT_LIMITATION]
        : [...PE_RICH_HEADER_LIMITATIONS],
  };
};
