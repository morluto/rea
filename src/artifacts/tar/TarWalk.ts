import { setImmediate } from "node:timers/promises";

import { Budget } from "../../domain/budget.js";
import { malformedInput } from "../../domain/parseFailure.js";
import { isStrictUtf8 } from "../../domain/strictUtf8.js";
import {
  parsePaxRecords,
  parseTarHeaderBlock,
  TAR_BLOCK_BYTES,
  TAR_TYPEFLAGS,
  tarPaddedSize,
  type TarHeaderBlock,
  type TarHeaderDialect,
  type TarPaxRecords,
} from "../../domain/tarFormat.js";
import type { ArtifactTraversalOmissionKind } from "../../domain/artifactGraph.js";
import {
  artifactFixedLimitFailure,
  artifactParseFailure,
  assertArtifactReadActive,
} from "../../resources/index.js";
import { TarStreamEnded, type TarByteStream } from "./TarByteStream.js";

/**
 * Largest pax extended header or GNU long-name record read into memory. Real
 * records hold one path or a few attributes; the allowance only stops a
 * declared size from forcing an arbitrary allocation.
 */
export const TAR_EXTENDED_HEADER_BYTES = 1024 * 1024;
/**
 * Retained member metadata: a fixed per-member charge plus decoded path and
 * link bytes. It bounds memory for tar streams of many tiny members.
 */
export const TAR_RETAINED_METADATA_BYTES = 64 * 1024 * 1024;
const MEMBER_OVERHEAD_BYTES = 512;
const SCAN_CHUNK_BYTES = 64 * 1024;

export interface TarMember {
  readonly kind: "file" | "directory" | "symlink";
  readonly path: string;
  /** Declared name before a leading `./` is dropped. */
  readonly sourcePath: string;
  readonly headerOffset: number;
  readonly dataOffset: number;
  readonly size: number;
  readonly typeflag: string;
  readonly mode: number;
  readonly uid: number | null;
  readonly gid: number | null;
  readonly mtime: number | null;
  readonly uname: string | null;
  readonly gname: string | null;
  readonly linkName: string | null;
  readonly limitations: readonly string[];
}

/** How the tar stream ended. */
export type TarEndState = "end-marker" | "eof" | "malformed" | "truncated";

export interface TarWalk {
  readonly members: readonly TarMember[];
  readonly omissions: readonly {
    readonly path: string;
    readonly kind: ArtifactTraversalOmissionKind;
  }[];
  readonly dialects: readonly TarHeaderDialect[];
  readonly paxHeaders: number;
  readonly endState: TarEndState;
  /** Tar-stream offset where the walk stopped. */
  readonly endOffset: number;
  /** Non-zero bytes after the end-of-archive marker. */
  readonly trailingNonZeroBytes: number;
  /** Bytes of the tar stream that were examined. */
  readonly streamBytes: number;
  readonly limitations: readonly string[];
}

/** Decode a header string: UTF-8 when valid, otherwise Latin-1 with its raw bytes noted. */
const decodeName = (
  bytes: Uint8Array,
  field: string,
  limitations: string[],
): string => {
  if (isStrictUtf8(bytes)) return Buffer.from(bytes).toString("utf8");
  limitations.push(
    `tar ${field} is not UTF-8; decoded as Latin-1; raw hex: ${Buffer.from(bytes).toString("hex")}.`,
  );
  // Buffer's latin1 maps each byte to the same code point; the WHATWG
  // "latin1" label is Windows-1252 and would rewrite bytes 0x80-0x9f.
  return Buffer.from(bytes).toString("latin1");
};

const safeNumber = (value: bigint): number | null =>
  value <= BigInt(Number.MAX_SAFE_INTEGER) &&
  value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : null;

/** Whole seconds of a pax time, which may be negative and fractional. */
const paxSeconds = (value: string | undefined): bigint | undefined =>
  value !== undefined && /^-?[0-9]+(?:\.[0-9]+)?$/u.test(value)
    ? BigInt(value.split(".")[0]!)
    : undefined;

/** GNU tar manual "Old GNU Format": the header's isextended byte. */
const GNU_SPARSE_HEADER_EXTENDED_OFFSET = 482;
/** Each sparse extension block: 21 map entries, then its isextended byte. */
const GNU_SPARSE_EXTENSION_EXTENDED_OFFSET = 504;

/** Skip the sparse-map extension blocks that follow an old GNU sparse header. */
const skipGnuSparseExtensions = async (
  header: Buffer,
  stream: TarByteStream,
  signal: AbortSignal | undefined,
): Promise<"complete" | "truncated"> => {
  let extended = header[GNU_SPARSE_HEADER_EXTENDED_OFFSET] !== 0;
  while (extended) {
    const block = await stream.read(TAR_BLOCK_BYTES, signal);
    if (block.length < TAR_BLOCK_BYTES) return "truncated";
    extended = block[GNU_SPARSE_EXTENSION_EXTENDED_OFFSET] !== 0;
  }
  return "complete";
};

/** The first recognized numeric pax keyword whose value does not parse. */
const invalidPaxNumber = (records: TarPaxRecords): string | undefined => {
  for (const key of ["size", "uid", "gid"] as const) {
    const value = records.get(key);
    if (value !== undefined && decimal(value) === undefined) return key;
  }
  const mtime = records.get("mtime");
  return mtime !== undefined && paxSeconds(mtime) === undefined
    ? "mtime"
    : undefined;
};

/**
 * Apply pax records over earlier ones. POSIX: an empty value deletes the
 * keyword, so the header field applies again.
 */
const withPax = (
  base: TarPaxRecords,
  records: TarPaxRecords | undefined,
): TarPaxRecords => {
  if (records === undefined) return base;
  const merged = new Map(base);
  for (const [key, value] of records)
    if (value === "") merged.delete(key);
    else merged.set(key, value);
  return merged;
};

const decimal = (value: string | undefined): bigint | undefined =>
  value !== undefined && /^[0-9]+$/u.test(value) ? BigInt(value) : undefined;

const typeflagText = (typeflag: number): string =>
  typeflag === 0 ? "\u0000" : String.fromCharCode(typeflag);

const tarFormatFailure = (detail: string, offset: number): unknown =>
  artifactParseFailure(malformedInput("tar", detail, { offset }), undefined);

const extendedHeaderLimit = (size: bigint): Error =>
  artifactFixedLimitFailure(
    {
      name: "The tar extended-header allowance",
      kind: "parser",
      limit: TAR_EXTENDED_HEADER_BYTES,
      unit: "bytes",
    },
    `A tar pax or GNU long-name record declares ${String(size)} bytes, more than the ${String(TAR_EXTENDED_HEADER_BYTES)}-byte extended-header allowance.`,
    "memory",
  );

const retainedMetadataLimit = (): Error =>
  artifactFixedLimitFailure(
    {
      name: "The tar member metadata allowance",
      kind: "parser",
      limit: TAR_RETAINED_METADATA_BYTES,
      unit: "bytes",
    },
    `The tar members need more than ${String(TAR_RETAINED_METADATA_BYTES)} bytes of retained metadata.`,
    "memory",
  );

const OMITTED_TYPEFLAGS: ReadonlyMap<number, ArtifactTraversalOmissionKind> =
  new Map([
    [TAR_TYPEFLAGS.characterDevice, "character-device"],
    [TAR_TYPEFLAGS.blockDevice, "block-device"],
    [TAR_TYPEFLAGS.fifo, "fifo"],
  ]);

/** Whether the bytes from the stream position to its end are all zero. */
const countTrailingNonZero = async (
  stream: TarByteStream,
  signal: AbortSignal | undefined,
): Promise<number> => {
  let nonZero = 0;
  for (let chunks = 0; ; chunks++) {
    if (chunks % 64 === 63) await setImmediate();
    const chunk = await stream.read(SCAN_CHUNK_BYTES, signal);
    if (chunk.length === 0) return nonZero;
    for (const byte of chunk) if (byte !== 0) nonZero++;
  }
};

/**
 * Walk tar headers from the start of the stream. Member data is skipped, not
 * read. A header that fails after the first one, or data that ends early,
 * stops the walk with partial members and an explicit end state rather than
 * a refusal; the first header must be valid.
 */
export const walkTar = async (
  stream: TarByteStream,
  signal: AbortSignal | undefined,
): Promise<TarWalk> => {
  const members: TarMember[] = [];
  const omissions: { path: string; kind: ArtifactTraversalOmissionKind }[] = [];
  const limitations: string[] = [];
  const dialects = new Set<TarHeaderDialect>();
  let paxHeaders = 0;
  const retained = new Budget(TAR_RETAINED_METADATA_BYTES);
  let global: TarPaxRecords = new Map();
  let local: TarPaxRecords | undefined;
  let longName: Uint8Array | undefined;
  let longLink: Uint8Array | undefined;
  let endState: TarEndState | undefined;
  let endOffset = 0;
  let trailingNonZeroBytes = 0;
  const stop = (state: TarEndState, offset: number, detail?: string) => {
    endState = state;
    endOffset = offset;
    if (detail !== undefined) limitations.push(detail);
  };
  try {
    for (let index = 0; endState === undefined; index++) {
      if (index % 256 === 255) await setImmediate();
      assertArtifactReadActive(signal);
      const headerOffset = stream.position;
      const block = await stream.read(TAR_BLOCK_BYTES, signal);
      if (block.length === 0) {
        stop(
          "eof",
          headerOffset,
          `Tar stream ended at offset ${String(headerOffset)} without its end-of-archive marker; members after the last header may be missing.`,
        );
        break;
      }
      if (block.length < TAR_BLOCK_BYTES) {
        if (headerOffset === 0)
          throw tarFormatFailure("first header block is incomplete", 0);
        stop(
          "truncated",
          headerOffset,
          `Tar header at offset ${String(headerOffset)} is cut off after ${String(block.length)} byte(s); the archive is truncated.`,
        );
        break;
      }
      const parsed = parseTarHeaderBlock(block);
      if (parsed.state === "zero") {
        endOffset = headerOffset;
        endState = "end-marker";
        trailingNonZeroBytes = await countTrailingNonZero(stream, signal);
        if (trailingNonZeroBytes > 0)
          limitations.push(
            `${String(trailingNonZeroBytes)} non-zero byte(s) follow the tar end-of-archive marker at offset ${String(headerOffset)}; they were not inventoried.`,
          );
        break;
      }
      if (parsed.state === "invalid") {
        if (headerOffset === 0)
          throw tarFormatFailure(`first ${parsed.reason}`, 0);
        stop(
          "malformed",
          headerOffset,
          `Tar ${parsed.reason} at offset ${String(headerOffset)}; members after it were not inventoried.`,
        );
        break;
      }
      const header = parsed.header;
      dialects.add(header.dialect);
      const typeflag = header.typeflag;
      const extension =
        typeflag === TAR_TYPEFLAGS.paxLocal ||
        typeflag === TAR_TYPEFLAGS.paxGlobal ||
        typeflag === TAR_TYPEFLAGS.gnuLongName ||
        typeflag === TAR_TYPEFLAGS.gnuLongLink;
      // Pax records describe the next member, never an extension header.
      const records = extension
        ? new Map<string, string>()
        : withPax(global, local);
      // A recognized numeric pax record that does not parse is not silently
      // replaced by the header field: the walk stops there as malformed.
      const invalidPax = invalidPaxNumber(records);
      if (invalidPax !== undefined) {
        stop(
          "malformed",
          headerOffset,
          `Tar pax record ${invalidPax} is not a valid number for the member at offset ${String(headerOffset)}; members from it on were not inventoried.`,
        );
        break;
      }
      const declaredSize = decimal(records.get("size")) ?? header.size;
      const size = safeNumber(declaredSize);
      if (size === null || tarPaddedSize(size) > Number.MAX_SAFE_INTEGER) {
        const detail = `member size ${String(declaredSize)} is not a safe byte count`;
        if (headerOffset === 0) throw tarFormatFailure(detail, 0);
        stop(
          "malformed",
          headerOffset,
          `Tar ${detail} at offset ${String(headerOffset)}; members after it were not inventoried.`,
        );
        break;
      }
      const dataOffset = stream.position;
      if (extension) {
        if (declaredSize > BigInt(TAR_EXTENDED_HEADER_BYTES))
          throw extendedHeaderLimit(declaredSize);
        const data = await stream.read(size, signal);
        const padding = await stream.skip(tarPaddedSize(size) - size, signal);
        if (data.length < size || padding < tarPaddedSize(size) - size) {
          stop(
            "truncated",
            headerOffset,
            `Tar extended header at offset ${String(headerOffset)} declares ${String(size)} byte(s) but the stream ends first; the archive is truncated.`,
          );
          break;
        }
        if (
          typeflag === TAR_TYPEFLAGS.paxLocal ||
          typeflag === TAR_TYPEFLAGS.paxGlobal
        ) {
          paxHeaders++;
          const pax = parsePaxRecords(data);
          if ("reason" in pax) {
            stop(
              "malformed",
              headerOffset,
              `Tar ${pax.reason} at offset ${String(headerOffset)}; members after it were not inventoried.`,
            );
            break;
          }
          if (typeflag === TAR_TYPEFLAGS.paxGlobal)
            global = withPax(global, pax.records);
          else local = pax.records;
        } else {
          const end = data.indexOf(0);
          const value = data.subarray(0, end === -1 ? data.length : end);
          if (typeflag === TAR_TYPEFLAGS.gnuLongName) longName = value;
          else longLink = value;
        }
        continue;
      }
      const memberLimitations: string[] = [];
      const name =
        records.get("path") ??
        decodeName(longName ?? header.name, "name", memberLimitations);
      const linkBytes = longLink ?? header.linkname;
      const linkTarget =
        records.get("linkpath") ??
        (linkBytes.length === 0
          ? null
          : decodeName(linkBytes, "link name", memberLimitations));
      local = undefined;
      longName = undefined;
      longLink = undefined;
      // An old GNU sparse header continues its sparse map in extension
      // blocks before the stored data; skip them so the next header aligns.
      if (typeflag === TAR_TYPEFLAGS.gnuSparse && header.dialect === "gnu") {
        const extensions = await skipGnuSparseExtensions(block, stream, signal);
        if (extensions === "truncated") {
          stop(
            "truncated",
            headerOffset,
            `Tar GNU sparse member at offset ${String(headerOffset)} is cut off inside its sparse map; the archive is truncated.`,
          );
          break;
        }
      }
      const skipped = await stream.skip(size, signal);
      if (skipped < size) {
        stop(
          "truncated",
          headerOffset,
          `Tar member ${JSON.stringify(name)} at offset ${String(headerOffset)} declares ${String(size)} byte(s) but the stream ends after ${String(skipped)}; the archive is truncated and the member was not inventoried.`,
        );
        break;
      }
      const sourcePath = name;
      const path = name.replace(/^(?:\.\/)+/u, "");
      const role = memberRole(header, records);
      // Omissions are retained too, so they share the metadata allowance.
      if ("omit" in role || role.member !== "root")
        retained.charge(
          MEMBER_OVERHEAD_BYTES +
            2 * (Buffer.byteLength(path) + Buffer.byteLength(linkTarget ?? "")),
          retainedMetadataLimit,
        );
      if ("omit" in role)
        omissions.push({ path: path.replace(/\/+$/u, ""), kind: role.omit });
      else if (role.member !== "root") {
        if (path !== sourcePath)
          memberLimitations.push(
            `tar member name ${JSON.stringify(sourcePath)} has a leading current-directory prefix omitted from its logical path.`,
          );
        members.push({
          kind: role.member,
          path,
          sourcePath,
          headerOffset,
          dataOffset,
          size: role.member === "file" ? size : 0,
          typeflag: typeflagText(typeflag),
          mode: header.mode,
          uid: safeNumber(decimal(records.get("uid")) ?? header.uid),
          gid: safeNumber(decimal(records.get("gid")) ?? header.gid),
          mtime: safeNumber(paxSeconds(records.get("mtime")) ?? header.mtime),
          uname:
            records.get("uname") ??
            (header.uname.length === 0
              ? null
              : decodeName(header.uname, "user name", memberLimitations)),
          gname:
            records.get("gname") ??
            (header.gname.length === 0
              ? null
              : decodeName(header.gname, "group name", memberLimitations)),
          linkName: linkTarget,
          limitations: memberLimitations,
        });
      }
      const padding = tarPaddedSize(size) - size;
      if ((await stream.skip(padding, signal)) < padding) {
        // The member's bytes are complete; only its block padding is missing.
        stop(
          "truncated",
          stream.position,
          `Tar stream ends inside the block padding after member ${JSON.stringify(name)}; the archive is truncated.`,
        );
        break;
      }
    }
  } catch (cause: unknown) {
    if (!(cause instanceof TarStreamEnded)) throw cause;
    if (stream.position === 0) throw tarFormatFailure(cause.detail, 0);
    endState = cause.kind;
    endOffset = stream.position;
    limitations.push(
      `${cause.detail}; tar members after that point were not inventoried.`,
    );
    // A member whose data the stream did not finish is not usable.
    while (
      members.length > 0 &&
      members.at(-1)!.dataOffset + members.at(-1)!.size > stream.position
    )
      members.pop();
  }
  return {
    members,
    omissions,
    dialects: [...dialects].sort(),
    paxHeaders,
    endState: endState ?? "eof",
    endOffset,
    trailingNonZeroBytes,
    streamBytes: stream.position,
    limitations,
  };
};

/**
 * What a header contributes: an inventory member, an omission, or nothing
 * for the archive's own `./` root and a GNU volume label.
 */
const memberRole = (
  header: TarHeaderBlock,
  records: TarPaxRecords,
):
  | { readonly member: TarMember["kind"] | "root" }
  | { readonly omit: ArtifactTraversalOmissionKind } => {
  const flag = header.typeflag;
  const name =
    records.get("path") ?? Buffer.from(header.name).toString("latin1");
  const directory =
    flag === TAR_TYPEFLAGS.directory || (flag === 0 && name.endsWith("/"));
  if (flag === TAR_TYPEFLAGS.gnuVolumeLabel) return { member: "root" };
  if (directory && /^(?:\.\/?)?$/u.test(name)) return { member: "root" };
  if ([...records.keys()].some((key) => key.startsWith("GNU.sparse.")))
    return { omit: "unsupported" };
  if (directory) return { member: "directory" };
  if (flag === TAR_TYPEFLAGS.symlink) return { member: "symlink" };
  const omitted = OMITTED_TYPEFLAGS.get(flag);
  if (omitted !== undefined) return { omit: omitted };
  if ((TAR_TYPEFLAGS.regular as readonly number[]).includes(flag))
    return { member: "file" };
  // Hard links, GNU sparse, multi-volume and vendor members are not read.
  return { omit: "unsupported" };
};
