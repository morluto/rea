import { gunzipSync } from "node:zlib";

import {
  MACOS_PKG_FORMAT,
  MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES,
  MACOS_PKG_MAX_CPIO_MEMBERS,
  MACOS_PKG_MAX_CPIO_NAME_BYTES,
  MACOS_PKG_MAX_SYMLINK_TARGET_BYTES,
  macosPkgLimitFailure,
  type MacosPkgParseError,
} from "../../domain/macosPkgFormat.js";
import {
  malformedInput,
  truncatedInput,
  unsupportedInput,
} from "../../domain/parseFailure.js";
import { err, ok, type Result } from "../../domain/result.js";

export const CPIO_ODC_MAGIC = "070707";
export const CPIO_ODC_HEADER_BYTES = 76;
export const PBZX_MAGIC = Buffer.from("pbzx");
export const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const TRAILER = "TRAILER!!!";

export type CpioMemberKind = "file" | "directory" | "symlink" | "other";

export interface CpioMember {
  readonly name: string;
  readonly kind: CpioMemberKind;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly symlinkTarget: string | null;
  readonly contents: Buffer | null;
}

export type PayloadCompression =
  | "gzip-cpio-odc"
  | "cpio-odc"
  | "pbzx"
  | "unsupported";

export const detectPayloadCompression = (bytes: Buffer): PayloadCompression => {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(PBZX_MAGIC))
    return "pbzx";
  if (bytes.length >= 2 && bytes.subarray(0, 2).equals(GZIP_MAGIC))
    return "gzip-cpio-odc";
  if (
    bytes.length >= CPIO_ODC_MAGIC.length &&
    bytes.subarray(0, CPIO_ODC_MAGIC.length).toString("ascii") ===
      CPIO_ODC_MAGIC
  )
    return "cpio-odc";
  return "unsupported";
};

const octalField = (
  header: Buffer,
  start: number,
  width: number,
  field: string,
): Result<number, MacosPkgParseError> => {
  const text = header.subarray(start, start + width).toString("ascii");
  if (!/^[0-7]+$/u.test(text))
    return err(
      malformedInput(MACOS_PKG_FORMAT, `cpio odc ${field} is not octal`, {
        field,
      }),
    );
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value))
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `cpio odc ${field} is not an exact nonnegative extent`,
        { field },
      ),
    );
  return ok(value);
};

const memberKind = (mode: number): CpioMemberKind => {
  const type = mode & S_IFMT;
  if (type === S_IFDIR) return "directory";
  if (type === S_IFREG) return "file";
  if (type === S_IFLNK) return "symlink";
  return "other";
};

const basenameOf = (name: string): string => {
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  return parts.at(-1) ?? name;
};

export const isInstallScriptName = (name: string): boolean => {
  const base = basenameOf(name);
  return base === "preinstall" || base === "postinstall";
};

const parseCpioOdcInto = (
  bytes: Buffer,
  members: CpioMember[],
): Result<readonly CpioMember[], MacosPkgParseError> => {
  let cursor = 0;
  for (;;) {
    if (cursor + CPIO_ODC_HEADER_BYTES > bytes.length)
      return err(
        truncatedInput(MACOS_PKG_FORMAT, "cpio odc header is truncated", {
          field: "cpio",
          offset: cursor,
        }),
      );
    const header = bytes.subarray(cursor, cursor + CPIO_ODC_HEADER_BYTES);
    const magic = header.subarray(0, 6).toString("ascii");
    if (magic !== CPIO_ODC_MAGIC)
      return err(
        malformedInput(
          MACOS_PKG_FORMAT,
          `cpio odc magic mismatch at offset ${String(cursor)}`,
          { field: "cpio", offset: cursor },
        ),
      );
    const mode = octalField(header, 18, 6, "mode");
    if (!mode.ok) return mode;
    const uid = octalField(header, 24, 6, "uid");
    if (!uid.ok) return uid;
    const gid = octalField(header, 30, 6, "gid");
    if (!gid.ok) return gid;
    const namesize = octalField(header, 59, 6, "namesize");
    if (!namesize.ok) return namesize;
    const filesize = octalField(header, 65, 11, "filesize");
    if (!filesize.ok) return filesize;
    if (namesize.value < 1 || namesize.value > MACOS_PKG_MAX_CPIO_NAME_BYTES)
      return err(
        macosPkgLimitFailure(
          `cpio odc namesize ${String(namesize.value)} is outside the ${String(MACOS_PKG_MAX_CPIO_NAME_BYTES)}-byte allowance`,
          {
            name: "macos_pkg_cpio_name_bytes",
            maximum: MACOS_PKG_MAX_CPIO_NAME_BYTES,
            required: namesize.value,
          },
          "namesize",
        ),
      );
    cursor += CPIO_ODC_HEADER_BYTES;
    if (cursor + namesize.value > bytes.length)
      return err(
        truncatedInput(MACOS_PKG_FORMAT, "cpio odc name is truncated", {
          field: "name",
          offset: cursor,
        }),
      );
    const nameBytes = bytes.subarray(cursor, cursor + namesize.value);
    cursor += namesize.value;
    const nul = nameBytes.indexOf(0);
    const name = nameBytes
      .subarray(0, nul === -1 ? nameBytes.length : nul)
      .toString("utf8");
    if (name === TRAILER) return ok(members);
    if (cursor + filesize.value > bytes.length)
      return err(
        truncatedInput(
          MACOS_PKG_FORMAT,
          `cpio odc member ${name} is truncated`,
          { field: "filesize", offset: cursor },
        ),
      );
    if (members.length >= MACOS_PKG_MAX_CPIO_MEMBERS)
      return err(
        macosPkgLimitFailure(
          `cpio odc archive declares more than ${String(MACOS_PKG_MAX_CPIO_MEMBERS)} members`,
          {
            name: "macos_pkg_cpio_members",
            maximum: MACOS_PKG_MAX_CPIO_MEMBERS,
            required: members.length + 1,
          },
          "cpio",
        ),
      );
    const kind = memberKind(mode.value);
    const body = bytes.subarray(cursor, cursor + filesize.value);
    cursor += filesize.value;
    let symlinkTarget: string | null = null;
    let contents: Buffer | null = null;
    if (kind === "symlink") {
      if (body.length > MACOS_PKG_MAX_SYMLINK_TARGET_BYTES)
        return err(
          macosPkgLimitFailure(
            `cpio odc symlink target for ${name} exceeds ${String(MACOS_PKG_MAX_SYMLINK_TARGET_BYTES)} bytes`,
            {
              name: "macos_pkg_symlink_target_bytes",
              maximum: MACOS_PKG_MAX_SYMLINK_TARGET_BYTES,
              required: body.length,
            },
            "link",
          ),
        );
      symlinkTarget = body.toString("utf8");
    } else if (kind === "file") contents = Buffer.from(body);
    members.push({
      name,
      kind,
      mode: mode.value,
      uid: uid.value,
      gid: gid.value,
      size: filesize.value,
      symlinkTarget,
      contents,
    });
  }
};

export interface CpioOdcPrefix {
  /** Members read completely before the archive ended or failed. */
  readonly members: readonly CpioMember[];
  /** Why parsing stopped before the trailer, or null when it reached it. */
  readonly failure: MacosPkgParseError | null;
}

/**
 * Parse an uncompressed odc (`070707`) cpio archive, keeping every member read
 * before a damaged or missing tail alongside the reason parsing stopped.
 */
export const parseCpioOdcPrefix = (bytes: Buffer): CpioOdcPrefix => {
  const members: CpioMember[] = [];
  const parsed = parseCpioOdcInto(bytes, members);
  return { members, failure: parsed.ok ? null : parsed.error };
};

/**
 * Parse an uncompressed odc (`070707`) cpio archive. Member bytes are retained
 * only for files and symlink targets so the reader can hash/extract them.
 */
export const parseCpioOdc = (
  bytes: Buffer,
): Result<readonly CpioMember[], MacosPkgParseError> => {
  const parsed = parseCpioOdcPrefix(bytes);
  return parsed.failure === null ? ok(parsed.members) : err(parsed.failure);
};

const cpioArchiveLimit = (maximum: number): MacosPkgParseError =>
  macosPkgLimitFailure(
    `cpio archive exceeds the ${String(maximum)}-byte decode allowance`,
    { name: "macos_pkg_cpio_archive_bytes", maximum },
    "cpio",
  );

/**
 * Inflates a gzip member without producing more than `maximum` bytes. Callers
 * that share an aggregate expansion budget pass what remains of it, so the
 * decoded size is accounted for before the output is allocated.
 */
export const gunzipBounded = (
  bytes: Buffer,
  maximum: number = MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES,
): Result<Buffer, MacosPkgParseError> => {
  const limit = Math.min(maximum, MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES);
  try {
    return ok(gunzipSync(bytes, { maxOutputLength: limit }));
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? cause.code
        : undefined;
    if (
      code === "ERR_BUFFER_TOO_LARGE" ||
      /exceeding/iu.test(message) ||
      /maxOutputLength/u.test(message)
    )
      return err(
        macosPkgLimitFailure(
          `gzip payload exceeds the ${String(limit)}-byte decode allowance`,
          {
            name: "macos_pkg_cpio_archive_bytes",
            maximum: limit,
          },
          "gzip",
        ),
      );
    return err(
      malformedInput(MACOS_PKG_FORMAT, `gzip payload is not valid gzip data`, {
        field: "gzip",
        cause,
      }),
    );
  }
};

export const parseGzipCpioOdc = (
  bytes: Buffer,
  maximum: number = MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES,
): Result<readonly CpioMember[], MacosPkgParseError> => {
  const inflated = gunzipBounded(bytes, maximum);
  if (!inflated.ok) return inflated;
  return parseCpioOdc(inflated.value);
};

export interface ArchiveInventory {
  readonly compression: PayloadCompression;
  readonly members: readonly CpioMember[];
  readonly decodedBytes: number;
  /** Set when members were read but the archive tail was damaged. */
  readonly partialFailure: MacosPkgParseError | null;
}

const inventoryParsedArchive = (
  compression: PayloadCompression,
  parsed: CpioOdcPrefix,
  decodedBytes: number,
): Result<ArchiveInventory, MacosPkgParseError> => {
  // A failure before any complete member has nothing to keep; otherwise the
  // members read safely stay in the inventory next to the refusal.
  if (parsed.failure !== null && parsed.members.length === 0)
    return err(parsed.failure);
  return ok({
    compression,
    members: parsed.members,
    decodedBytes,
    partialFailure: parsed.failure,
  });
};

/**
 * Inventories a Scripts or Payload archive. `maximum` caps the decoded cpio
 * bytes; `decodedBytes` reports what the decode produced so a caller can
 * charge it against a shared budget.
 */
export const inventoryCompressedArchive = (
  bytes: Buffer,
  maximum: number = MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES,
): Result<ArchiveInventory, MacosPkgParseError> => {
  const compression = detectPayloadCompression(bytes);
  if (compression === "pbzx")
    return err(
      unsupportedInput(
        MACOS_PKG_FORMAT,
        "Payload uses pbzx (xz-chunked) compression, which is unsupported",
        { field: "payload", undecodedContent: true },
      ),
    );
  if (compression === "unsupported")
    return err(
      unsupportedInput(MACOS_PKG_FORMAT, "Archive compression is unsupported", {
        field: "payload",
        undecodedContent: true,
      }),
    );
  if (compression === "gzip-cpio-odc") {
    const inflated = gunzipBounded(bytes, maximum);
    if (!inflated.ok) return inflated;
    return inventoryParsedArchive(
      compression,
      parseCpioOdcPrefix(inflated.value),
      inflated.value.length,
    );
  }
  if (bytes.length > Math.min(maximum, MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES))
    return err(
      cpioArchiveLimit(Math.min(maximum, MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES)),
    );
  return inventoryParsedArchive(
    compression,
    parseCpioOdcPrefix(bytes),
    bytes.length,
  );
};
