import { err, ok, type Result } from "./result.js";

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
 * The member count is stored in the last four header bytes. Some producers
 * include those bytes in `indexLength`; others count only the rows that follow.
 */
const WXAPKG_MEMBER_COUNT_BYTES = 4;

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
  /**
   * Declared index length. This is either the row bytes or those rows plus
   * the 4-byte member count; {@link resolveWxapkgIndexLayouts} admits both.
   */
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

/**
 * Whether bytes carry the plain wxapkg marks. Recognition is intentionally
 * separate from admission: a damaged package keeps its format identity and the
 * reader rejects impossible table accounting as a typed format failure.
 */
export const hasWxapkgHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= WXAPKG_HEADER_BYTES &&
  bytes[0] === WXAPKG_FIRST_MARK &&
  bytes[13] === WXAPKG_LAST_MARK;

/** Row table and declared data region for one index-length convention. */
export interface WxapkgIndexLayout {
  /** Absolute offset of the first name/offset/size row. */
  readonly tableStart: number;
  /** Row bytes to read. The member count, when included, stays in the header. */
  readonly tableBytes: number;
  /** Inclusive start of the declared member-data region. */
  readonly dataStart: number;
  /** Exclusive end of the declared member-data region. */
  readonly dataEnd: number;
}

export type WxapkgIndexLayoutFailure =
  | { readonly _tag: "IndexExceedsFile" }
  | { readonly _tag: "DataRegionExceedsFile" };

const spanEnd = (start: number, length: number): number | undefined => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    length < 0
  )
    return undefined;
  const end = start + length;
  return Number.isSafeInteger(end) ? end : undefined;
};

const indexLayout = (
  facts: WxapkgHeaderFacts,
  fileSize: number,
  includedCountBytes: number,
): WxapkgIndexLayout | "index-outside" | "data-outside" | "too-small" => {
  if (
    !Number.isSafeInteger(facts.indexLength) ||
    !Number.isSafeInteger(facts.fileCount) ||
    facts.fileCount < 0 ||
    facts.indexLength < includedCountBytes
  )
    return "too-small";
  const tableBytes = facts.indexLength - includedCountBytes;
  if (tableBytes < facts.fileCount * WXAPKG_MIN_ROW_BYTES) return "too-small";
  const dataStart = spanEnd(WXAPKG_HEADER_BYTES, tableBytes);
  if (dataStart === undefined || dataStart > fileSize) return "index-outside";
  const dataEnd = spanEnd(dataStart, facts.dataLength);
  if (dataEnd === undefined || dataEnd > fileSize) return "data-outside";
  return { tableStart: WXAPKG_HEADER_BYTES, tableBytes, dataStart, dataEnd };
};

/**
 * Admit every index-length convention whose index and declared data region
 * both lie inside the carrier. Trailing bytes can make both fit, so callers
 * keep every candidate until the parsed rows and member ranges decide.
 */
export const resolveWxapkgIndexLayouts = (
  facts: WxapkgHeaderFacts,
  fileSize: number,
): Result<readonly WxapkgIndexLayout[], WxapkgIndexLayoutFailure> => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    return err({ _tag: "IndexExceedsFile" });
  const described = [WXAPKG_MEMBER_COUNT_BYTES, 0].map((included) =>
    indexLayout(facts, fileSize, included),
  );
  const admissible = described.filter(
    (layout): layout is WxapkgIndexLayout => typeof layout !== "string",
  );
  if (admissible.length === 0)
    return err({
      _tag: described.some((layout) => layout === "data-outside")
        ? "DataRegionExceedsFile"
        : "IndexExceedsFile",
    });
  return ok(admissible);
};

const memberFitsIndex = (
  layout: WxapkgIndexLayout,
  member: { readonly offset: number; readonly size: number },
): boolean => {
  const extentEnd = member.offset + member.size;
  return (
    member.offset >= layout.dataStart &&
    extentEnd <= layout.dataEnd &&
    extentEnd >= member.offset
  );
};

/**
 * Choose the admitted index that contains the parsed rows and every member
 * range. An index that ends on the last parsed row wins a tie. Neither the
 * carrier end nor the shorter table is enough on its own: four trailing bytes
 * can make the other convention land on EOF.
 */
export const selectWxapkgIndexLayout = (
  layouts: readonly WxapkgIndexLayout[],
  consumedRowBytes: number,
  members: readonly { readonly offset: number; readonly size: number }[],
): WxapkgIndexLayout | undefined => {
  const fitting = layouts.filter(
    (layout) =>
      layout.tableBytes >= consumedRowBytes &&
      members.every((member) => memberFitsIndex(layout, member)),
  );
  const exactRows = fitting.filter(
    (layout) => layout.tableBytes === consumedRowBytes,
  );
  const pool = exactRows.length > 0 ? exactRows : fitting;
  let selected: WxapkgIndexLayout | undefined;
  for (const layout of pool) {
    if (selected === undefined || layout.tableBytes < selected.tableBytes)
      selected = layout;
  }
  return selected;
};
