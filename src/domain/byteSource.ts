/**
 * Random-access bytes of one admitted artifact. Streaming parsers read only
 * the ranges they need; `prefix`, when present, holds the file's leading bytes
 * so header reads need no I/O.
 */
export interface ByteSource {
  readonly size: number;
  readonly prefix?: Buffer;
  readRange(offset: number, length: number): Promise<Buffer>;
}

/** Read up to the end of a source, borrowing its retained prefix when it covers the whole slice. */
export const readByteSourceSlice = (
  source: ByteSource,
  offset: number,
  length: number,
): Promise<Buffer> => {
  if (length <= 0 || offset >= source.size)
    return Promise.resolve(Buffer.alloc(0));
  const clamped = Math.min(length, source.size - offset);
  if (source.prefix !== undefined && offset + clamped <= source.prefix.length)
    return Promise.resolve(source.prefix.subarray(offset, offset + clamped));
  return source.readRange(offset, clamped);
};

/** A byte source whose leading bytes were retained during admission. */
export interface PrefixedByteSource extends ByteSource {
  readonly prefix: Buffer;
}

/**
 * Serve an in-memory buffer as a byte source. Reads outside the buffer return
 * the bytes that exist (possibly none), as a short positional file read would.
 * `prefixBytes` models how much of the file admission retained.
 */
export const bufferByteSource = (
  data: Uint8Array,
  prefixBytes = data.length,
): PrefixedByteSource => {
  // A Buffer view over the same memory; no bytes are copied.
  const bytes = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    size: bytes.length,
    prefix: bytes.subarray(0, prefixBytes),
    readRange: (offset, length) =>
      Promise.resolve(
        offset < 0 || length <= 0 || offset >= bytes.length
          ? Buffer.alloc(0)
          : bytes.subarray(offset, Math.min(bytes.length, offset + length)),
      ),
  };
};
