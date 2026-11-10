/**
 * Android compiled resource table (resources.arsc): a little-endian
 * ResTable document mapping numeric resource IDs to typed values across
 * packages, types and configuration variants. The file opens with a
 * ResTable_header chunk: type 0x0002, headerSize covering the chunk header
 * and the declared package count, and the declared document size. A global
 * string pool and the package chunks follow. All multi-byte fields are
 * little-endian.
 */
export const ARSC_HEADER_BYTES = 12;
export const ARSC_CHUNK_TYPE = 0x0002;
export const ARSC_CHUNK_HEADER_BYTES = 8;

/** Declared header fields; support and extent admission belong to callers. */
export interface ArscHeaderFacts {
  /** Declared document size in bytes, including the header. */
  readonly declaredSize: number;
  /** Declared number of package chunks in the table. */
  readonly packageCount: number;
}

/**
 * Whether bytes carry the ResTable chunk preamble. Recognition is
 * intentionally separate from admission: a truncated table keeps its format
 * identity and the decoder rejects impossible extents as a typed format
 * failure.
 */
export const hasArscHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= ARSC_HEADER_BYTES &&
  bytes[0] === (ARSC_CHUNK_TYPE & 0xff) &&
  bytes[1] === ARSC_CHUNK_TYPE >> 8 &&
  (bytes[2] ?? 0) + (bytes[3] ?? 0) * 0x100 >= ARSC_HEADER_BYTES;

/**
 * Decode declared fields after the caller admits a prefix covering the fixed
 * header. Undefined means the admitted bytes cannot carry a plausible header.
 */
export const readArscHeaderFacts = (
  bytes: Uint8Array,
): ArscHeaderFacts | undefined => {
  if (!hasArscHeader(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredSize = view.getUint32(4, true);
  if (declaredSize < ARSC_HEADER_BYTES) return undefined;
  return { declaredSize, packageCount: view.getUint32(8, true) };
};
