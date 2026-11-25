import {
  decodeLimit,
  malformedInput,
  truncatedInput,
  unsupportedInput,
  type AnyParseFailureError,
} from "./parseFailure.js";
import { err, ok, type Result } from "./result.js";
import { decodeStrictUtf8 } from "./strictUtf8.js";
import {
  effectivePaxValue,
  isZeroBlock,
  parsePaxRecords,
  parsePaxUnsignedDecimal,
  parseTarHeaderBlock,
  type TarPaxRecords,
  TAR_BLOCK_BYTES,
  TAR_TYPEFLAGS,
  tarPaddedSize,
} from "./tarFormat.js";

export const ANDROID_BACKUP_FORMAT = "android-backup";
export const ANDROID_BACKUP_MAGIC = "ANDROID BACKUP\n";

export interface AndroidBackupHeader {
  readonly version: number;
  readonly compressed: boolean;
  readonly encryption: "none" | "AES-256";
  /** Unknown when an encryption-specific header has not been parsed. */
  readonly payloadOffset: number | null;
}

type Decoded<Value> = Result<Value, AnyParseFailureError>;

type ParseSite = {
  readonly offset: number;
  readonly field: string;
  readonly cause?: unknown;
};

const malformed = (detail: string, at: ParseSite) =>
  err(malformedInput(ANDROID_BACKUP_FORMAT, detail, at));

const truncated = (detail: string, at: Parameters<typeof truncatedInput>[2]) =>
  err(truncatedInput(ANDROID_BACKUP_FORMAT, detail, at));

const unsupported = (detail: string, at: ParseSite) =>
  err(
    unsupportedInput(ANDROID_BACKUP_FORMAT, detail, {
      ...at,
      undecodedContent: true,
    }),
  );

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
    return malformed("Missing Android backup magic", {
      offset: 0,
      field: "magic",
    });
  const lines: { value: string; at: ParseSite }[] = [];
  let position = ANDROID_BACKUP_MAGIC.length;
  for (const field of ["version", "compression", "encryption"]) {
    const end = bytes.indexOf(10, position);
    const at = { offset: position, field };
    if (end < 0) return truncated("Truncated Android backup header", at);
    const line = bytes.subarray(position, end);
    if (line.some((byte) => byte < 0x20 || byte > 0x7e))
      return malformed("Non-ASCII Android backup header field", at);
    lines.push({ value: line.toString("ascii"), at });
    position = end + 1;
  }
  const version = lines[0]!;
  const compression = lines[1]!;
  const encryption = lines[2]!;
  if (!/^[1-9][0-9]*$/u.test(version.value))
    return malformed("Invalid Android backup version", version.at);
  if (!/^[1-5]$/u.test(version.value))
    return unsupported(`Android backup version ${version.value}`, version.at);
  if (compression.value !== "0" && compression.value !== "1")
    return malformed("Compression flag must be 0 or 1", compression.at);
  if (encryption.value === "")
    return malformed("Missing encryption method", encryption.at);
  if (encryption.value !== "none" && encryption.value !== "AES-256")
    return unsupported(
      `Unsupported Android backup encryption method: ${encryption.value}`,
      encryption.at,
    );
  return ok({
    version: Number(version.value),
    compressed: compression.value === "1",
    encryption: encryption.value,
    payloadOffset: encryption.value === "none" ? position : null,
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
  at: ParseSite,
): Decoded<TarPaxRecords> => {
  if (bytes.length > Math.floor(directoryLimit / 6))
    return err(
      decodeLimit(
        ANDROID_BACKUP_FORMAT,
        "PAX metadata exceeds the directory representation allowance",
        {
          name: "artifact_limits.android_backup.directory_bytes",
          maximum: directoryLimit,
          required: bytes.length * 6,
        },
        at,
      ),
    );
  const parsed = parsePaxRecords(bytes, { strict: true });
  if ("reason" in parsed) return malformed(parsed.reason, at);
  for (const key of parsed.records.keys())
    if (!BACKUP_PAX_KEYS.has(key))
      return unsupported(`PAX attribute ${key}`, at);
  return ok(parsed.records);
};

/** Member offsets address the TAR bytes. Failure offsets use the available source. */
export function* androidBackupTarEntries(
  bytes: Buffer,
  directoryLimit: number,
  sourceOffset: number | null,
): Generator<Decoded<AndroidBackupTarEntry>> {
  const at = (offset: number, field: string) => ({
    offset: (sourceOffset ?? 0) + offset,
    field: `${sourceOffset === null ? "decoded TAR" : "TAR"} ${field}`,
  });
  const tail = bytes.length % TAR_BLOCK_BYTES;
  if (tail !== 0) {
    yield truncated("Truncated TAR block", {
      ...at(bytes.length - tail, "block"),
      extent: { availableBytes: tail, requiredBytes: TAR_BLOCK_BYTES },
    });
    return;
  }
  let position = 0;
  let pax:
    | { readonly records: TarPaxRecords; readonly offset: number }
    | undefined;
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
        yield malformed(
          "Invalid TAR end marker or trailing payload",
          at(position, "end marker"),
        );
      return;
    }
    if (parsedHeader.state === "invalid") {
      yield malformed(parsedHeader.reason, at(position, "header"));
      return;
    }
    const { dialect, name, mode, size, typeflag: type } = parsedHeader.header;
    if (dialect === "gnu") {
      yield unsupported(
        "GNU TAR header dialect",
        at(position, "header dialect"),
      );
      return;
    }
    if (
      type !== 0 &&
      type !== 0x30 &&
      type !== TAR_TYPEFLAGS.directory &&
      type !== TAR_TYPEFLAGS.paxLocal
    ) {
      yield unsupported(
        `TAR entry type ${String(type)}`,
        at(position, "typeflag"),
      );
      return;
    }
    let headerPath: string;
    try {
      headerPath = decodeStrictUtf8(name, "preserve");
    } catch (cause: unknown) {
      yield malformed("TAR path is not valid UTF-8", {
        ...at(position, "header path"),
        cause,
      });
      return;
    }
    const override =
      type === TAR_TYPEFLAGS.paxLocal
        ? undefined
        : effectivePaxValue(pax?.records.get("size"));
    const declaredSize =
      override === undefined ? size : parsePaxUnsignedDecimal(override);
    if (declaredSize === undefined) {
      yield malformed("Invalid PAX size", at(pax!.offset, "PAX records"));
      return;
    }
    const dataOffset = position + TAR_BLOCK_BYTES;
    const availableBytes = bytes.length - dataOffset;
    if (declaredSize > BigInt(availableBytes)) {
      yield truncated("Truncated TAR member", {
        ...at(dataOffset, "member data"),
        ...(declaredSize > BigInt(Number.MAX_SAFE_INTEGER)
          ? {}
          : {
              extent: { availableBytes, requiredBytes: Number(declaredSize) },
            }),
      });
      return;
    }
    const memberSize = Number(declaredSize);
    const next = dataOffset + tarPaddedSize(memberSize);
    if (type === TAR_TYPEFLAGS.paxLocal) {
      if (pax !== undefined) {
        yield malformed(
          "Consecutive local PAX headers",
          at(position, "PAX header"),
        );
        return;
      }
      const parsed = paxFields(
        bytes.subarray(dataOffset, dataOffset + memberSize),
        directoryLimit,
        at(dataOffset, "PAX records"),
      );
      if (!parsed.ok) {
        yield parsed;
        return;
      }
      pax = { records: parsed.value, offset: dataOffset };
    } else {
      if (type === TAR_TYPEFLAGS.directory && memberSize !== 0) {
        yield malformed(
          "TAR directory contains data",
          at(position, "directory header"),
        );
        return;
      }
      yield ok({
        path: effectivePaxValue(pax?.records.get("path")) ?? headerPath,
        kind: type === TAR_TYPEFLAGS.directory ? "directory" : "file",
        headerOffset: position,
        dataOffset,
        size: memberSize,
        mode,
        pax: pax === undefined ? {} : Object.fromEntries(pax.records),
      });
      pax = undefined;
    }
    position = next;
  }
  yield truncated(
    "Missing complete TAR end marker",
    at(position, "end marker"),
  );
}
