/**
 * Unity WebGL `.data` container ("UnityWebData1.0"): a 16-byte signature, a
 * little-endian u32 directory end, then `offset, size, nameLength, name`
 * records up to that end. Member bytes follow the directory and are stored
 * without compression; the browser may have removed an outer gzip or Brotli
 * transfer encoding while keeping a `.gz` or `.br` file name.
 */
export const UNITY_WEB_DATA_SIGNATURE = Buffer.from(
  "UnityWebData1.0\0",
  "latin1",
);

/** Signature plus the directory-end field. */
export const UNITY_WEB_DATA_PREFIX_BYTES = UNITY_WEB_DATA_SIGNATURE.length + 4;

/** Resource policy, not a format maximum: real directories are a few KiB. */
export const UNITY_WEB_DATA_MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;

/** Whether bytes start with the UnityWebData1.0 signature. */
export const hasUnityWebDataHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= UNITY_WEB_DATA_SIGNATURE.length &&
  Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    UNITY_WEB_DATA_SIGNATURE.length,
  ).equals(UNITY_WEB_DATA_SIGNATURE);

export interface UnityWebDataMember {
  readonly index: number;
  readonly path: string;
  readonly offset: number;
  readonly size: number;
}

export interface UnityWebDataDirectory {
  readonly directoryEnd: number;
  readonly members: readonly UnityWebDataMember[];
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Declared directory end; callers admit it before reading the directory. */
export const readUnityWebDataDirectoryEnd = (
  prefix: Uint8Array,
): number | undefined =>
  prefix.length < UNITY_WEB_DATA_PREFIX_BYTES || !hasUnityWebDataHeader(prefix)
    ? undefined
    : Buffer.from(prefix.buffer, prefix.byteOffset, prefix.length).readUInt32LE(
        UNITY_WEB_DATA_SIGNATURE.length,
      );

/**
 * Decode every directory record from the complete directory bytes. Returns a
 * reason string for malformed input; members must lie after the directory and
 * inside the file.
 */
export const parseUnityWebDataDirectory = (
  directory: Uint8Array,
  fileSize: number,
): UnityWebDataDirectory | string => {
  const directoryEnd = readUnityWebDataDirectoryEnd(directory);
  if (directoryEnd === undefined)
    return "signature or directory end is missing";
  if (directoryEnd < UNITY_WEB_DATA_PREFIX_BYTES || directoryEnd > fileSize)
    return `directory end ${String(directoryEnd)} lies outside the ${String(fileSize)}-byte file`;
  if (directory.length !== directoryEnd)
    return "directory bytes do not match the declared directory end";
  const bytes = Buffer.from(
    directory.buffer,
    directory.byteOffset,
    directory.length,
  );
  const members: UnityWebDataMember[] = [];
  let cursor = UNITY_WEB_DATA_PREFIX_BYTES;
  while (cursor < directoryEnd) {
    if (cursor + 12 > directoryEnd)
      return `record ${String(members.length)} is truncated`;
    const offset = bytes.readUInt32LE(cursor);
    const size = bytes.readUInt32LE(cursor + 4);
    const nameLength = bytes.readUInt32LE(cursor + 8);
    cursor += 12;
    if (nameLength === 0 || nameLength > directoryEnd - cursor)
      return `record ${String(members.length)} name exceeds the directory`;
    let path: string;
    try {
      path = UTF8.decode(bytes.subarray(cursor, cursor + nameLength));
    } catch {
      return `record ${String(members.length)} name is not valid UTF-8`;
    }
    cursor += nameLength;
    if (path.includes("\0"))
      return `record ${String(members.length)} name contains NUL`;
    if (offset < directoryEnd || offset + size > fileSize)
      return `member ${path} lies outside the data area`;
    members.push({ index: members.length, path, offset, size });
  }
  return { directoryEnd, members };
};
