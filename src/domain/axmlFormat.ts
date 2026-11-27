/**
 * Android binary XML (AXML): a little-endian ResXMLTree document used for
 * AndroidManifest.xml and compiled resource XML inside APKs. The file opens
 * with an 8-byte RES_XML_TYPE chunk header: type 0x0003, headerSize 8 and
 * the declared document size. A string pool, optional resource map and the
 * element tree chunks follow. All multi-byte fields are little-endian.
 */
import { BinaryReader } from "./binaryContainer.js";

export const AXML_HEADER_BYTES = 8;
export const AXML_CHUNK_TYPE = 0x0003;
export const AXML_CHUNK_HEADER_BYTES = 8;

/** Declared header fields; support and extent admission belong to callers. */
export interface AxmlHeaderFacts {
  /** Declared document size in bytes, including the header. */
  readonly declaredSize: number;
}

/**
 * Whether bytes carry the AXML chunk preamble. Recognition is intentionally
 * separate from admission: a truncated document keeps its format identity and
 * the decoder rejects impossible extents as a typed format failure.
 */
export const hasAxmlHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= AXML_HEADER_BYTES &&
  bytes[0] === (AXML_CHUNK_TYPE & 0xff) &&
  bytes[1] === AXML_CHUNK_TYPE >> 8 &&
  bytes[2] === AXML_HEADER_BYTES &&
  bytes[3] === 0;

/**
 * Decode declared fields after the caller admits a prefix covering the fixed
 * header. Undefined means the admitted bytes cannot carry a plausible header.
 */
export const readAxmlHeaderFacts = (
  bytes: Uint8Array,
): AxmlHeaderFacts | undefined => {
  if (!hasAxmlHeader(bytes)) return undefined;
  const reader = new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    "axml",
  );
  const declaredSize = reader.u32(4);
  if (declaredSize < AXML_HEADER_BYTES) return undefined;
  return { declaredSize };
};
