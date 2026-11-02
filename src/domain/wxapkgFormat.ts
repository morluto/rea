/**
 * WeChat mini-program package (wxapkg): an 18-byte big-endian header, a
 * name/offset/size member table, then verbatim member data. Members are stored
 * uncompressed at absolute file offsets. All multi-byte fields are big-endian.
 */
export const WXAPKG_FIRST_MARK = 0xbe;
export const WXAPKG_LAST_MARK = 0xed;
export const WXAPKG_HEADER_BYTES = 18;

/** Minimum fixed row fields: name length, offset and size without name bytes. */
export const WXAPKG_MIN_ROW_BYTES = 12;

/**
 * Encrypted PC-client packages start with this ASCII magic instead of the
 * plain header. Their member data is ciphertext; no decryption is supported.
 */
export const WXAPKG_ENCRYPTED_MAGIC = Buffer.from("V1MMWX", "latin1");

/** Whether bytes start with the encrypted PC-client magic. */
export const hasWxapkgEncryptedMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= WXAPKG_ENCRYPTED_MAGIC.length &&
  Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    WXAPKG_ENCRYPTED_MAGIC.length,
  ).equals(WXAPKG_ENCRYPTED_MAGIC);

/** Declared header fields; support and extent admission belong to callers. */
export interface WxapkgHeaderFacts {
  /** Unknown header field after the first mark; producers write zero. */
  readonly info: number;
  /** Declared byte length of the member table region. */
  readonly indexLength: number;
  /** Declared byte length of the member data region. */
  readonly dataLength: number;
  readonly fileCount: number;
}

/**
 * Decode declared fields after the caller admits a prefix covering the fixed
 * header. Undefined means the admitted bytes cannot carry a plausible header;
 * both mark checks and minimal row accounting must hold.
 */
export const readWxapkgHeaderFacts = (
  bytes: Uint8Array,
): WxapkgHeaderFacts | undefined => {
  if (
    bytes.length < WXAPKG_HEADER_BYTES ||
    bytes[0] !== WXAPKG_FIRST_MARK ||
    bytes[13] !== WXAPKG_LAST_MARK
  )
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = view.getUint32(1);
  const indexLength = view.getUint32(5);
  const dataLength = view.getUint32(9);
  const fileCount = view.getUint32(14);
  // Every row carries at least its fixed fields; a table too small for the
  // declared count cannot be a wxapkg index.
  if (fileCount === 0 || indexLength < fileCount * WXAPKG_MIN_ROW_BYTES)
    return undefined;
  return { info, indexLength, dataLength, fileCount };
};

/** Whether bytes start with a plausible plain wxapkg header. */
export const hasWxapkgHeader = (bytes: Uint8Array): boolean =>
  readWxapkgHeaderFacts(bytes) !== undefined;
