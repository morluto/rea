import { BinaryReader } from "../domain/binaryContainer.js";
import { Budget } from "../domain/budget.js";
import type { FileHandle } from "node:fs/promises";
import {
  ArtifactReaderFailure,
  malformedArtifact,
  truncatedArtifact,
  artifactFixedLimitFailure,
  assertArtifactReadActive,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { setImmediate } from "node:timers/promises";
import {
  admitWxapkgMemberExtents,
  hasWxapkgEncryptedMagic,
  readWxapkgHeaderFacts,
  resolveWxapkgIndexLayouts,
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
  malformedArtifact("wxapkg", `wxapkg is malformed: ${detail}`);

const wxapkgTruncatedFailure = (detail: string): ArtifactReaderFailure =>
  truncatedArtifact("wxapkg", `wxapkg is malformed: ${detail}`);

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
    "wxapkg",
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
    "wxapkg",
    handle,
    tableStart,
    readBytes,
    size,
    signal,
  );
  // Loose lower bound already checked in facts; precise rows are checked here.
  if (table.length < header.fileCount * WXAPKG_MIN_ROW_BYTES)
    throw wxapkgTruncatedFailure("member table is truncated");
  const reader = new BinaryReader(table, false, "wxapkg");
  const members: WxapkgMember[] = [];
  let cursor = 0;
  for (let index = 0; index < header.fileCount; index++) {
    if (index % 256 === 0) await setImmediate();
    assertArtifactReadActive(signal);
    if (cursor + 4 > table.length)
      throw wxapkgTruncatedFailure("member row is truncated");
    const nameLength = reader.u32(cursor);
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
      throw malformedArtifact(
        "wxapkg",
        "wxapkg member path is not valid UTF-8",
        {
          cause,
          field: "member-path",
        },
      );
    }
    cursor += nameLength;
    const offset = reader.u32(cursor);
    const sizeMember = reader.u32(cursor + 4);
    cursor += 8;
    // Producer names are root-prefixed; translate to package-relative once.
    const path = declaredPath.startsWith("/")
      ? declaredPath.slice(1)
      : declaredPath;
    if (path.length === 0)
      throw wxapkgFormatFailure("member name has no package-relative path");
    members.push({ offset, size: sizeMember, path, declaredPath });
  }
  // Rows and member ranges choose the convention. EOF can fit either.
  const admitted = admitWxapkgMemberExtents(indexLayouts, cursor, members);
  if (!admitted.ok) {
    switch (admitted.error._tag) {
      case "TruncatedRows":
        throw wxapkgTruncatedFailure("member table is truncated");
      case "MemberOutsideDataRegion":
        throw wxapkgFormatFailure(
          `member exceeds the data region: ${admitted.error.member.path}`,
        );
      case "ConflictingMemberExtents":
        throw wxapkgFormatFailure(
          "no single declared data region contains all member extents",
        );
    }
  }
  return { members };
};
