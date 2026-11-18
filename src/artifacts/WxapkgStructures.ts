import { Budget } from "../domain/budget.js";
import type { FileHandle } from "node:fs/promises";
import {
  ArtifactReaderFailure,
  artifactFixedLimitFailure,
  assertArtifactReadActive,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { setImmediate } from "node:timers/promises";
import {
  hasWxapkgEncryptedMagic,
  readWxapkgHeaderFacts,
  resolveWxapkgIndexLayouts,
  selectWxapkgIndexLayout,
  WXAPKG_MIN_ROW_BYTES,
  type WxapkgIndexLayout,
  type WxapkgIndexLayoutFailure,
} from "../domain/wxapkgFormat.js";
import { strictUtf8Decoder } from "../domain/strictUtf8.js";

/** The member table is a flat name/offset/size row list. */
const MAX_TABLE_BYTES = 16 * 1024 * 1024;
/** Encoded retained directory representation; paths are charged separately. */
const DIRECTORY_BUDGET_BYTES = 64 * 1024 * 1024;
/** Member names are relative package paths; larger claims are malformed. */
const MAX_MEMBER_NAME_BYTES = 64 * 1024;
/** Detecting prefix covers the fixed header, table head and encrypted magic. */
const HEADER_PREFIX_BYTES = 64;

const UTF8 = strictUtf8Decoder("preserve");

export const wxapkgFormatFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure("format", `wxapkg is malformed: ${detail}`);

/** Buffers, JS rows and escaped name projections, reserved before allocating. */
const directoryLimit = (): Error =>
  artifactFixedLimitFailure(
    {
      name: "The wxapkg directory representation allowance",
      kind: "parser",
      limit: DIRECTORY_BUDGET_BYTES,
      unit: "bytes",
    },
    `The wxapkg directory needs more than ${String(DIRECTORY_BUDGET_BYTES)} bytes to represent.`,
  );

export interface WxapkgHeader {
  readonly info: number;
  readonly indexLength: number;
  readonly dataLength: number;
  readonly fileCount: number;
  readonly layout:
    | { readonly status: "encrypted" }
    | {
        readonly status: "available";
        readonly indexLayouts: readonly WxapkgIndexLayout[];
      };
}

export interface WxapkgMember {
  readonly offset: number;
  readonly size: number;
  /** Package-relative path; declared root prefixes are translated here. */
  readonly path: string;
  /** Declared member name as stored in the table. */
  readonly declaredPath: string;
}

export interface WxapkgFileTable {
  readonly members: readonly WxapkgMember[];
}

/** Decode header fields once; encrypted variants and absent signatures are distinct. */
export const readWxapkgHeader = async (
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<WxapkgHeader | undefined> => {
  const prefix = await readArtifactFileBytes(
    handle,
    0,
    Math.min(size, HEADER_PREFIX_BYTES),
    size,
    signal,
  );
  if (hasWxapkgEncryptedMagic(prefix))
    return {
      info: 0,
      indexLength: 0,
      dataLength: 0,
      fileCount: 0,
      layout: { status: "encrypted" },
    };
  const facts = readWxapkgHeaderFacts(prefix);
  if (facts === undefined) return undefined;
  const indexes = resolveWxapkgIndexLayouts(facts, size);
  if (!indexes.ok) throw wxapkgIndexLayoutFailure(indexes.error);
  return {
    ...facts,
    layout: { status: "available", indexLayouts: indexes.value },
  };
};

const wxapkgIndexLayoutFailure = (
  failure: WxapkgIndexLayoutFailure,
): ArtifactReaderFailure =>
  wxapkgFormatFailure(
    failure._tag === "DataRegionExceedsFile"
      ? "declared data region exceeds the file"
      : "declared member table exceeds the file",
  );

export const readWxapkgFileTable = async (
  handle: FileHandle,
  header: WxapkgHeader,
  size: number,
  signal?: AbortSignal,
): Promise<WxapkgFileTable> => {
  const layout = header.layout;
  if (layout.status !== "available")
    throw new ArtifactReaderFailure(
      "unavailable",
      "wxapkg directory is encrypted",
    );
  const indexLayouts = layout.indexLayouts;
  let readBytes = 0;
  let tableStart: number | undefined;
  for (const indexLayout of indexLayouts) {
    if (tableStart === undefined) tableStart = indexLayout.tableStart;
    if (indexLayout.tableBytes > readBytes) readBytes = indexLayout.tableBytes;
  }
  if (tableStart === undefined)
    throw wxapkgFormatFailure("declared member table exceeds the file");
  if (readBytes > MAX_TABLE_BYTES)
    throw artifactFixedLimitFailure(
      {
        name: "The wxapkg member table allowance",
        kind: "parser",
        limit: MAX_TABLE_BYTES,
        unit: "bytes",
      },
      `The wxapkg member table declares ${String(readBytes)} bytes, above ${String(MAX_TABLE_BYTES)} bytes.`,
    );
  const budget = new Budget(DIRECTORY_BUDGET_BYTES);
  budget.charge(readBytes, directoryLimit);
  const table = await readArtifactFileBytes(
    handle,
    tableStart,
    readBytes,
    size,
    signal,
  );
  // Loose lower bound already checked in facts; precise rows are checked here.
  if (table.length < header.fileCount * WXAPKG_MIN_ROW_BYTES)
    throw wxapkgFormatFailure("member table is truncated");
  const members: WxapkgMember[] = [];
  let cursor = 0;
  for (let index = 0; index < header.fileCount; index++) {
    if (index % 256 === 0) await setImmediate();
    assertArtifactReadActive(signal);
    if (cursor + 4 > table.length)
      throw wxapkgFormatFailure("member row is truncated");
    const nameLength = table.readUInt32BE(cursor);
    cursor += 4;
    if (
      nameLength === 0 ||
      nameLength > MAX_MEMBER_NAME_BYTES ||
      cursor + nameLength + 8 > table.length
    )
      throw wxapkgFormatFailure("member row exceeds the table");
    // Row storage plus the reader's owned entries/map; charge before decode.
    budget.charge(512 + nameLength * 24, directoryLimit);
    let declaredPath: string;
    try {
      declaredPath = UTF8.decode(table.subarray(cursor, cursor + nameLength));
    } catch (cause: unknown) {
      throw new ArtifactReaderFailure(
        "format",
        "wxapkg member path is not valid UTF-8",
        {
          cause,
        },
      );
    }
    cursor += nameLength;
    const offset = table.readUInt32BE(cursor);
    const sizeMember = table.readUInt32BE(cursor + 4);
    cursor += 8;
    // Producer names are root-prefixed; translate to package-relative once.
    const path = declaredPath.startsWith("/")
      ? declaredPath.slice(1)
      : declaredPath;
    if (path.length === 0)
      throw wxapkgFormatFailure("member name has no package-relative path");
    members.push({ offset, size: sizeMember, path, declaredPath });
  }
  const candidates = indexLayouts.filter((index) => index.tableBytes >= cursor);
  if (candidates.length === 0)
    throw wxapkgFormatFailure("member table is truncated");
  // Rows and member ranges choose the convention. EOF is not a signal: four
  // trailing bytes can make the other convention end on the carrier.
  const index = selectWxapkgIndexLayout(candidates, cursor, members);
  if (index === undefined) {
    const outside = members.find((member) => {
      const extentEnd = member.offset + member.size;
      return candidates.every(
        (candidate) =>
          member.offset < candidate.dataStart ||
          extentEnd > candidate.dataEnd ||
          extentEnd < member.offset,
      );
    });
    throw wxapkgFormatFailure(
      `member exceeds the data region: ${outside?.path ?? ""}`,
    );
  }
  return { members };
};
