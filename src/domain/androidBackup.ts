import { err, ok, type Result } from "./result.js";
import { decodeStrictUtf8 } from "./strictUtf8.js";
import {
  isZeroBlock,
  parsePaxRecords,
  parsePaxUnsignedDecimal,
  parseTarHeaderBlock,
  type TarPaxRecords,
  TAR_BLOCK_BYTES,
  TAR_TYPEFLAGS,
  tarPaddedSize,
} from "./tarFormat.js";

export const ANDROID_BACKUP_MAGIC = "ANDROID BACKUP\n";

export interface AndroidBackupHeader {
  readonly version: number;
  readonly compressed: boolean;
  readonly encryption: string;
  /** Unknown when an encryption-specific header has not been parsed. */
  readonly payloadOffset: number | null;
}

export type AndroidBackupDecodeFailure =
  | {
      readonly kind: "malformed" | "truncated" | "unsupported";
      readonly message: string;
    }
  | { readonly kind: "limit"; readonly requiredBytes: number };

type Decoded<Value> = Result<Value, AndroidBackupDecodeFailure>;
const malformed = (message: string): Decoded<never> =>
  err({ kind: "malformed", message });
const truncated = (message: string): Decoded<never> =>
  err({ kind: "truncated", message });
const unsupported = (message: string): Decoded<never> =>
  err({ kind: "unsupported", message });

/** Recognition does not claim that the remainder of the header is valid. */
export const hasAndroidBackupMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= ANDROID_BACKUP_MAGIC.length &&
  [...ANDROID_BACKUP_MAGIC].every(
    (character, index) => bytes[index] === character.charCodeAt(0),
  );

/** Unencrypted AOSP backup versions 1 through 5 share this envelope. */
export const parseAndroidBackupHeader = (
  bytes: Buffer,
): Decoded<AndroidBackupHeader> => {
  if (!hasAndroidBackupMagic(bytes))
    return malformed("missing Android backup magic");
  const lines: string[] = [];
  let position = ANDROID_BACKUP_MAGIC.length;
  for (let index = 0; index < 3; index++) {
    const end = bytes.indexOf(10, position);
    if (end < 0) return truncated("truncated Android backup header");
    const line = bytes.subarray(position, end);
    if (line.some((byte) => byte < 0x20 || byte > 0x7e))
      return malformed("non-ASCII Android backup header field");
    lines.push(line.toString("ascii"));
    position = end + 1;
  }
  const [version, compression, encryption] = lines;
  if (version === undefined || !/^[1-9][0-9]*$/u.test(version))
    return malformed("invalid Android backup version");
  if (!/^[1-5]$/u.test(version))
    return unsupported(`Android backup version ${version}`);
  if (compression !== "0" && compression !== "1")
    return malformed("compression flag must be 0 or 1");
  if (encryption === undefined || encryption === "")
    return malformed("missing encryption method");
  return ok({
    version: Number(version),
    compressed: compression === "1",
    encryption,
    payloadOffset: encryption === "none" ? position : null,
  });
};

export interface AndroidBackupTarEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly headerOffset: number;
  readonly dataOffset: number;
  readonly size: number;
  readonly mode: number;
  readonly pax: Readonly<Record<string, string>>;
}

const BACKUP_PAX_KEYS = new Set([
  "path",
  "size",
  "uid",
  "gid",
  "uname",
  "gname",
  "mtime",
  "atime",
  "ctime",
]);

const paxFields = (
  bytes: Buffer,
  directoryLimit: number,
): Decoded<TarPaxRecords> => {
  if (bytes.length > Math.floor(directoryLimit / 6))
    return err({ kind: "limit", requiredBytes: bytes.length * 6 });
  const parsed = parsePaxRecords(bytes, { strict: true });
  if ("reason" in parsed) return malformed(parsed.reason);
  for (const key of parsed.records.keys())
    if (!BACKUP_PAX_KEYS.has(key)) return unsupported(`PAX attribute ${key}`);
  return ok(parsed.records);
};

/** Validate each header and extent once; offsets address the decoded TAR stream. */
export function* androidBackupTarEntries(
  bytes: Buffer,
  directoryLimit: number,
): Generator<Decoded<AndroidBackupTarEntry>> {
  if (bytes.length % TAR_BLOCK_BYTES !== 0) {
    yield truncated("truncated TAR block");
    return;
  }
  let position = 0;
  let pax: TarPaxRecords | undefined;
  while (position + TAR_BLOCK_BYTES <= bytes.length) {
    const parsedHeader = parseTarHeaderBlock(
      bytes.subarray(position, position + TAR_BLOCK_BYTES),
      true,
    );
    if (parsedHeader.state === "zero") {
      if (
        pax !== undefined ||
        bytes.length - position < 2 * TAR_BLOCK_BYTES ||
        !isZeroBlock(bytes.subarray(position))
      )
        yield malformed("invalid TAR end marker or trailing payload");
      return;
    }
    if (parsedHeader.state === "invalid") {
      yield malformed(parsedHeader.reason);
      return;
    }
    const { dialect, name, mode, size, typeflag: type } = parsedHeader.header;
    if (dialect === "gnu") {
      yield unsupported("GNU TAR header dialect");
      return;
    }
    if (
      type !== 0 &&
      type !== 0x30 &&
      type !== TAR_TYPEFLAGS.directory &&
      type !== TAR_TYPEFLAGS.paxLocal
    ) {
      yield unsupported(`TAR entry type ${String(type)}`);
      return;
    }
    let headerPath: string;
    try {
      headerPath = decodeStrictUtf8(name, "preserve");
    } catch {
      yield malformed("TAR path is not valid UTF-8");
      return;
    }
    const override =
      type === TAR_TYPEFLAGS.paxLocal ? undefined : pax?.get("size");
    const declaredSize =
      override === undefined ? size : parsePaxUnsignedDecimal(override);
    if (declaredSize === undefined) {
      yield malformed("invalid PAX size");
      return;
    }
    const dataOffset = position + TAR_BLOCK_BYTES;
    if (declaredSize > BigInt(bytes.length - dataOffset)) {
      yield truncated("truncated TAR member");
      return;
    }
    const memberSize = Number(declaredSize);
    const next = dataOffset + tarPaddedSize(memberSize);
    if (next > bytes.length) {
      yield truncated("truncated TAR member padding");
      return;
    }
    if (type === TAR_TYPEFLAGS.paxLocal) {
      if (pax !== undefined) {
        yield malformed("consecutive local PAX headers");
        return;
      }
      const parsed = paxFields(
        bytes.subarray(dataOffset, dataOffset + memberSize),
        directoryLimit,
      );
      if (!parsed.ok) {
        yield parsed;
        return;
      }
      pax = parsed.value;
    } else {
      if (type === TAR_TYPEFLAGS.directory && memberSize !== 0) {
        yield malformed("TAR directory contains data");
        return;
      }
      yield ok({
        path: pax?.get("path") ?? headerPath,
        kind: type === TAR_TYPEFLAGS.directory ? "directory" : "file",
        headerOffset: position,
        dataOffset,
        size: memberSize,
        mode,
        pax: pax === undefined ? {} : Object.fromEntries(pax),
      });
      pax = undefined;
    }
    position = next;
  }
  yield truncated("missing complete TAR end marker");
}
