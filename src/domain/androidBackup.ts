import { err, ok, type Result } from "./result.js";

export const ANDROID_BACKUP_MAGIC = "ANDROID BACKUP\n";
export const ANDROID_BACKUP_DIRECTORY_BYTES = 8 * 1024 * 1024;

export interface AndroidBackupHeader {
  readonly version: number;
  readonly compressed: boolean;
  readonly encryption: string;
  /** Unknown when an encryption-specific header has not been parsed. */
  readonly payloadOffset: number | null;
}

export interface AndroidBackupDecodeFailure {
  readonly kind: "format" | "unsupported" | "limit";
  readonly message: string;
}

type Decoded<Value> = Result<Value, AndroidBackupDecodeFailure>;
const malformed = (message: string): Decoded<never> =>
  err({ kind: "format", message });
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
    if (end < 0) return malformed("truncated Android backup header");
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

const text = (bytes: Buffer): Decoded<string> => {
  try {
    return ok(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
  } catch {
    return malformed("TAR text is not valid UTF-8");
  }
};
const field = (
  header: Buffer,
  start: number,
  size: number,
): Decoded<string> => {
  const bytes = header.subarray(start, start + size);
  const end = bytes.indexOf(0);
  return text(end < 0 ? bytes : bytes.subarray(0, end));
};
const octal = (
  header: Buffer,
  start: number,
  size: number,
): Decoded<number> => {
  const source = field(header, start, size);
  if (!source.ok) return source;
  const digits = source.value.replace(/^ +| +$/gu, "");
  if (!/^[0-7]*$/u.test(digits)) return malformed("invalid TAR octal field");
  const value = digits === "" ? 0 : Number.parseInt(digits, 8);
  return Number.isSafeInteger(value)
    ? ok(value)
    : malformed("TAR integer exceeds the safe range");
};

const paxFields = (bytes: Buffer): Decoded<Record<string, string>> => {
  if (bytes.length > Math.floor(ANDROID_BACKUP_DIRECTORY_BYTES / 6))
    return err({
      kind: "limit",
      message: "PAX metadata exceeds the directory representation budget",
    });
  const fields: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let position = 0;
  while (position < bytes.length) {
    const space = bytes.indexOf(0x20, position);
    if (space < 0) return malformed("truncated PAX record length");
    const digits = bytes.subarray(position, space).toString("latin1");
    if (!/^[1-9][0-9]*$/u.test(digits))
      return malformed("invalid PAX record length");
    const length = Number(digits);
    const end = position + length;
    if (
      !Number.isSafeInteger(end) ||
      end > bytes.length ||
      end <= space + 2 ||
      bytes[end - 1] !== 10
    )
      return malformed("PAX record exceeds its declared extent");
    const decoded = text(bytes.subarray(space + 1, end - 1));
    if (!decoded.ok) return decoded;
    const equals = decoded.value.indexOf("=");
    if (equals < 1) return malformed("invalid PAX key/value record");
    const key = decoded.value.slice(0, equals);
    if (Object.hasOwn(fields, key)) return malformed("duplicate PAX key");
    if (
      ![
        "path",
        "size",
        "uid",
        "gid",
        "uname",
        "gname",
        "mtime",
        "atime",
        "ctime",
      ].includes(key)
    )
      return unsupported(`PAX attribute ${key}`);
    fields[key] = decoded.value.slice(equals + 1);
    position = end;
  }
  return ok(fields);
};

interface TarHeader {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly type: number;
}

const tarHeader = (header: Buffer): Decoded<TarHeader> => {
  const checksum = octal(header, 148, 8);
  if (!checksum.ok) return checksum;
  const sum = header.reduce(
    (total, byte, index) => total + (index >= 148 && index < 156 ? 0x20 : byte),
    0,
  );
  if (sum !== checksum.value) return malformed("TAR header checksum mismatch");
  const size = octal(header, 124, 12);
  if (!size.ok) return size;
  const mode = octal(header, 100, 8);
  if (!mode.ok) return mode;
  const name = field(header, 0, 100);
  if (!name.ok) return name;
  const prefix = field(header, 345, 155);
  if (!prefix.ok) return prefix;
  const type = header[156]!;
  const ustar = header.subarray(257, 263).toString("latin1");
  if (
    ustar !== "ustar\0" &&
    header.subarray(257, 263).some((byte) => byte !== 0)
  )
    return unsupported("TAR header dialect");
  if (type !== 0 && type !== 0x30 && type !== 0x35 && type !== 0x78)
    return unsupported(`TAR entry type ${String(type)}`);
  return ok({
    path:
      ustar === "ustar\0" && prefix.value !== ""
        ? `${prefix.value}/${name.value}`
        : name.value,
    type,
    size: size.value,
    mode: mode.value,
  });
};

const tarMemberSize = (
  header: TarHeader,
  pax: Record<string, string> | undefined,
): Decoded<number> => {
  if (header.type === 0x78 || pax?.size === undefined) return ok(header.size);
  if (
    !/^(0|[1-9][0-9]*)$/u.test(pax.size) ||
    !Number.isSafeInteger(Number(pax.size))
  )
    return malformed("invalid PAX size");
  return ok(Number(pax.size));
};

/** Validate each header and extent once; offsets address the decoded TAR stream. */
export function* androidBackupTarEntries(
  bytes: Buffer,
): Generator<Decoded<AndroidBackupTarEntry>> {
  if (bytes.length % 512 !== 0) {
    yield malformed("truncated TAR block");
    return;
  }
  let position = 0;
  let pax: Record<string, string> | undefined;
  while (position + 512 <= bytes.length) {
    const header = bytes.subarray(position, position + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        pax !== undefined ||
        bytes.length - position < 1024 ||
        bytes.subarray(position).some((byte) => byte !== 0)
      )
        yield malformed("invalid TAR end marker or trailing payload");
      return;
    }
    const parsedHeader = tarHeader(header);
    if (!parsedHeader.ok) {
      yield parsedHeader;
      return;
    }
    const facts = parsedHeader.value;
    const type = facts.type;
    const parsedSize = tarMemberSize(facts, pax);
    if (!parsedSize.ok) {
      yield parsedSize;
      return;
    }
    const memberSize = parsedSize.value;
    const dataOffset = position + 512;
    const next = dataOffset + Math.ceil(memberSize / 512) * 512;
    if (!Number.isSafeInteger(next) || next > bytes.length) {
      yield malformed("truncated TAR member or padding");
      return;
    }
    if (type === 0x78) {
      if (pax !== undefined) {
        yield malformed("consecutive local PAX headers");
        return;
      }
      const parsed = paxFields(
        bytes.subarray(dataOffset, dataOffset + memberSize),
      );
      if (!parsed.ok) {
        yield parsed;
        return;
      }
      pax = parsed.value;
    } else {
      if (type === 0x35 && memberSize !== 0) {
        yield malformed("TAR directory contains data");
        return;
      }
      yield ok({
        path: pax?.path ?? facts.path,
        kind: type === 0x35 ? "directory" : "file",
        headerOffset: position,
        dataOffset,
        size: memberSize,
        mode: facts.mode,
        pax: pax ?? {},
      });
      pax = undefined;
    }
    position = next;
  }
  yield malformed("missing complete TAR end marker");
}
