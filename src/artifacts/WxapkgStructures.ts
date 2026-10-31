import type { FileHandle } from "node:fs/promises";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { setImmediate } from "node:timers/promises";
import {
  hasWxapkgEncryptedMagic,
  readWxapkgHeaderFacts,
  WXAPKG_HEADER_BYTES,
  WXAPKG_MIN_ROW_BYTES,
} from "../domain/wxapkgFormat.js";

/** The member table is a flat name/offset/size row list. */
const MAX_TABLE_BYTES = 16 * 1024 * 1024;
/** Encoded retained directory representation; paths are charged separately. */
const DIRECTORY_BUDGET_BYTES = 64 * 1024 * 1024;
/** Member names are relative package paths; larger claims are malformed. */
const MAX_MEMBER_NAME_BYTES = 64 * 1024;
/** Detecting prefix covers the fixed header, table head and encrypted magic. */
const HEADER_PREFIX_BYTES = 64;

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const wxapkgFormatFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure("format", `wxapkg is malformed: ${detail}`);

/** Reserve buffers, JS rows and escaped name projections before allocating. */
class WxapkgDirectoryBudget {
  #remaining = DIRECTORY_BUDGET_BYTES;
  reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#remaining)
      throw new ArtifactReaderFailure(
        "limit",
        "wxapkg directory exceeds its 16 MiB buffer or 64 MiB representation budget",
        { boundary: "memory" },
      );
    this.#remaining -= bytes;
  }
}

export interface WxapkgHeader {
  readonly info: number;
  readonly indexLength: number;
  readonly dataLength: number;
  readonly fileCount: number;
  readonly layout:
    | { readonly status: "encrypted" }
    | { readonly status: "available"; readonly tableStart: number };
}

export interface WxapkgMember {
  readonly offset: number;
  readonly size: number;
  readonly path: string;
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
  if (WXAPKG_HEADER_BYTES + facts.indexLength > size)
    throw wxapkgFormatFailure("declared member table exceeds the file");
  return {
    ...facts,
    layout: { status: "available", tableStart: WXAPKG_HEADER_BYTES },
  };
};

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
  if (header.indexLength > MAX_TABLE_BYTES)
    throw new ArtifactReaderFailure(
      "limit",
      "wxapkg member table exceeds the 16 MiB encoded table budget",
      { boundary: "memory" },
    );
  const budget = new WxapkgDirectoryBudget();
  budget.reserve(header.indexLength);
  const table = await readArtifactFileBytes(
    handle,
    layout.tableStart,
    header.indexLength,
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
    let path: string;
    try {
      path = UTF8.decode(table.subarray(cursor, cursor + nameLength));
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
    // Names address package destinations; ArtifactPaths owns that validation.
    if (offset < WXAPKG_HEADER_BYTES || offset + sizeMember > size)
      throw wxapkgFormatFailure(`member exceeds the file: ${path}`);
    // Parsed rows plus the reader's owned entries/map; names are charged separately.
    budget.reserve(512 + nameLength * 24);
    members.push({ offset, size: sizeMember, path });
  }
  return { members };
};
