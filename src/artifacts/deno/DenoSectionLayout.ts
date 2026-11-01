import { TextDecoder } from "node:util";

import { fixedAllowanceRemediation } from "../../domain/fixedAllowanceRemediation.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { abortIfNeeded } from "../ArtifactHash.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { walkDenoVirtualFs, type DenoVfsWalk } from "./DenoVirtualFs.js";

/** Opening and closing marker of a Deno compile data section. */
export const DENO_SECTION_MAGIC = Buffer.from("d3n0l4nd", "latin1");

export const MAX_DENO_METADATA_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_DENO_VFS_HEADER_JSON_BYTES = 32 * 1024 * 1024;
export const MAX_DENO_TABLE_COUNT = 100_000;
export const MAX_DENO_SPECIFIER_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_DENO_REMOTE_BODY_BYTES = 256 * 1024 * 1024;

const KNOWN_REMOTE_FLAGS = 0x0f;
const FLAG_TRANSPILED = 1 << 0;
const FLAG_SOURCE_MAP = 1 << 1;
const FLAG_CJS = 1 << 2;
const FLAG_UTF8 = 1 << 3;

const MEDIA_TYPE_NAMES = [
  "JavaScript",
  "Jsx",
  "Mjs",
  "Cjs",
  "TypeScript",
  "Mts",
  "Cts",
  "Dts",
  "Dmts",
  "Dcts",
  "Tsx",
  "Json",
  "Jsonc",
  "Json5",
  "Markdown",
  "Wasm",
  "Css",
  "Html",
  "SourceMap",
  "Sql",
  "Unknown",
] as const;

export const denoMediaTypeName = (value: number): string | null =>
  MEDIA_TYPE_NAMES[value] ?? null;

export type DenoListing = "listed" | "unsupported";

export interface DenoObservedMetadata {
  readonly entrypointKey: string;
  readonly argv: readonly string[] | null;
  readonly v8Flags: readonly string[] | null;
  readonly permissions: Record<string, JsonValue> | null;
  readonly unstableConfig: Record<string, JsonValue> | null;
  readonly appName: string | null;
  readonly selfExtracting: string | null;
  readonly envVarCount: number | null;
  readonly envVars:
    | readonly {
        readonly name: string;
        readonly value: string;
        readonly valueByteLength: number;
      }[]
    | null;
  readonly caData: readonly number[] | null;
  readonly caDataByteLength: number | null;
  readonly vfsCaseSensitivity: "sensitive" | "insensitive" | null;
}

export interface DenoCountedRegion {
  readonly count: number;
  readonly byteLength: number;
  readonly listing: DenoListing;
}

export interface DenoByteRange {
  readonly sectionOffset: number;
  readonly length: number;
}

export interface DenoRemoteModule {
  readonly index: number;
  readonly specifierId: number;
  readonly mediaType: number;
  readonly data: DenoByteRange;
  readonly transpiled: DenoByteRange | null;
  readonly sourceMap: DenoByteRange | null;
  readonly cjsExportAnalysis: DenoByteRange | null;
  readonly isValidUtf8: boolean;
}

export interface DenoRemoteTable extends DenoCountedRegion {
  readonly modules: readonly DenoRemoteModule[];
}

export interface DenoParsedSection {
  readonly metadata: DenoObservedMetadata;
  readonly npmSnapshotByteLength: number;
  readonly specifiers: DenoCountedRegion;
  readonly redirects: DenoCountedRegion;
  readonly remoteModules: DenoRemoteTable;
  readonly vfsHeaderByteLength: number;
  readonly vfsFileData: DenoByteRange;
  readonly vfs: DenoVfsWalk;
  /** Specifier text when every specifier was valid UTF-8. */
  readonly specifierText: ReadonlyMap<number, string> | null;
}

export type DenoSectionRead = (
  offset: number,
  length: number,
) => Promise<Buffer>;

/**
 * Parse one `d3n0l4nd` section. Lengths are checked with BigInt before a
 * read. File bodies and the npm snapshot are skipped; callers keep offsets.
 * An opening marker that is absent is unsupported. A length that overruns
 * the section, or a closing marker that does not match, is malformed.
 */
export const parseDenoSection = async (
  sectionLength: number,
  read: DenoSectionRead,
  signal?: AbortSignal,
): Promise<DenoParsedSection> => {
  abortIfNeeded(signal);
  if (
    !Number.isSafeInteger(sectionLength) ||
    sectionLength < DENO_SECTION_MAGIC.length
  )
    throw denoUnsupported("opening marker d3n0l4nd is absent");
  const size = BigInt(sectionLength);
  const readExact = async (offset: number, length: number): Promise<Buffer> => {
    abortIfNeeded(signal);
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > sectionLength ||
      length > sectionLength - offset
    )
      throw denoFormatFailure("section read exceeds the declared section");
    if (length === 0) return Buffer.alloc(0);
    const bytes = await read(offset, length);
    if (bytes.length !== length)
      throw denoFormatFailure("section read was short");
    return bytes;
  };
  const opening = await readExact(0, DENO_SECTION_MAGIC.length);
  if (!opening.equals(DENO_SECTION_MAGIC))
    throw denoUnsupported("opening marker d3n0l4nd is absent");

  let cursor = BigInt(DENO_SECTION_MAGIC.length);
  const need = (bytes: bigint): void => {
    if (cursor > size || bytes > size - cursor)
      throw denoFormatFailure("length overruns the section");
  };
  const pull = async (bytes: number): Promise<Buffer> => {
    need(BigInt(bytes));
    const offset = Number(cursor);
    cursor += BigInt(bytes);
    return readExact(offset, bytes);
  };
  const u8 = async (): Promise<number> => (await pull(1))[0] ?? 0;
  const u32 = async (): Promise<number> => (await pull(4)).readUInt32LE(0);
  const u64 = async (): Promise<bigint> => (await pull(8)).readBigUInt64LE(0);
  const readBounded = async (
    claimed: bigint,
    max: number,
    scope: string,
  ): Promise<Buffer> => {
    if (claimed > size - cursor)
      throw denoFormatFailure(`${scope} length overruns the section`);
    if (claimed > BigInt(max)) throw denoByteLimit(scope, claimed, max);
    const offset = Number(cursor);
    const length = Number(claimed);
    cursor += claimed;
    return readExact(offset, length);
  };
  const skip = (claimed: bigint, scope: string): void => {
    if (claimed > size - cursor)
      throw denoFormatFailure(`${scope} length overruns the section`);
    cursor += claimed;
  };
  const skipBody = (length: number, scope: string): DenoByteRange => {
    if (length > Number(size - cursor))
      throw denoFormatFailure(`${scope} length overruns the section`);
    const sectionOffset = Number(cursor);
    cursor += BigInt(length);
    return { sectionOffset, length };
  };

  const metadataBytes = await readBounded(
    await u64(),
    MAX_DENO_METADATA_JSON_BYTES,
    "metadata JSON",
  );
  const metadata = observeMetadata(decodeJson(metadataBytes, "metadata JSON"));
  const npmClaimed = await u64();
  if (npmClaimed > size - cursor)
    throw denoFormatFailure("npm snapshot length overruns the section");
  const npmSnapshotByteLength = Number(npmClaimed);
  skip(npmClaimed, "npm snapshot");

  const specifierStart = cursor;
  const specifierCount = await u32();
  assertTableCount(specifierCount, "specifier");
  const specifierIds = new Set<number>();
  const specifierText = new Map<number, string>();
  let textBytes = 0;
  let invalidUtf8 = false;
  for (let index = 0; index < specifierCount; index += 1) {
    abortIfNeeded(signal);
    const length = await u32();
    textBytes += length;
    if (textBytes > MAX_DENO_SPECIFIER_TEXT_BYTES)
      throw denoByteLimit(
        "specifier text",
        textBytes,
        MAX_DENO_SPECIFIER_TEXT_BYTES,
      );
    const bytes = await pull(length);
    const id = await u32();
    if (specifierIds.has(id))
      throw denoFormatFailure(`duplicate specifier id ${String(id)}`);
    specifierIds.add(id);
    const decoded = decodeStrict(bytes);
    if (decoded === undefined) invalidUtf8 = true;
    else specifierText.set(id, decoded);
  }
  const specifiers: DenoCountedRegion = {
    count: specifierCount,
    byteLength: Number(cursor - specifierStart),
    listing: invalidUtf8 ? "unsupported" : "listed",
  };
  const namedSpecifiers = invalidUtf8 ? null : specifierText;

  const redirectStart = cursor;
  const redirectCount = await u32();
  assertTableCount(redirectCount, "redirect");
  const redirectIds = new Set<number>();
  let redirectListing: DenoListing =
    namedSpecifiers === null ? "unsupported" : "listed";
  for (let index = 0; index < redirectCount; index += 1) {
    abortIfNeeded(signal);
    const from = await u32();
    const to = await u32();
    if (redirectIds.has(from))
      throw denoFormatFailure(
        `duplicate redirect specifier id ${String(from)}`,
      );
    redirectIds.add(from);
    if (!specifierIds.has(from) || !specifierIds.has(to))
      redirectListing = "unsupported";
  }
  const redirects: DenoCountedRegion = {
    count: redirectCount,
    byteLength: Number(cursor - redirectStart),
    listing: redirectListing,
  };

  const remoteStart = cursor;
  const remoteCount = await u32();
  assertTableCount(remoteCount, "remote module");
  const remoteIds = new Set<number>();
  const modules: DenoRemoteModule[] = [];
  let remoteBodies = 0n;
  let unresolvedRemote = namedSpecifiers === null;
  for (let index = 0; index < remoteCount; index += 1) {
    abortIfNeeded(signal);
    const specifierId = await u32();
    if (remoteIds.has(specifierId))
      throw denoFormatFailure(
        `duplicate remote specifier id ${String(specifierId)}`,
      );
    remoteIds.add(specifierId);
    if (namedSpecifiers?.has(specifierId) !== true) unresolvedRemote = true;
    const mediaType = await u8();
    const dataLength = await u32();
    remoteBodies = addRemoteBody(remoteBodies, dataLength);
    const data = skipBody(dataLength, "remote module");
    const flags = await u8();
    if ((flags & ~KNOWN_REMOTE_FLAGS) !== 0)
      throw denoUnsupported(
        `remote module flags 0x${flags.toString(16)} are not a recognized layout, so later regions are not framed`,
      );
    const optionalRegion = async (
      flag: number,
      scope: string,
    ): Promise<DenoByteRange | null> => {
      if ((flags & flag) === 0) return null;
      const length = await u32();
      remoteBodies = addRemoteBody(remoteBodies, length);
      return skipBody(length, scope);
    };
    const transpiled = await optionalRegion(
      FLAG_TRANSPILED,
      "remote transpiled",
    );
    const sourceMap = await optionalRegion(
      FLAG_SOURCE_MAP,
      "remote source map",
    );
    const cjsExportAnalysis = await optionalRegion(
      FLAG_CJS,
      "remote cjs export analysis",
    );
    modules.push({
      index,
      specifierId,
      mediaType,
      data,
      transpiled,
      sourceMap,
      cjsExportAnalysis,
      isValidUtf8: (flags & FLAG_UTF8) !== 0,
    });
  }
  const remoteModules: DenoRemoteTable = {
    count: remoteCount,
    byteLength: Number(cursor - remoteStart),
    listing: unresolvedRemote ? "unsupported" : "listed",
    modules,
  };

  const vfsHeader = await readBounded(
    await u64(),
    MAX_DENO_VFS_HEADER_JSON_BYTES,
    "vfs header JSON",
  );
  const vfsJson = decodeJson(vfsHeader, "vfs header JSON");
  const vfsFileClaimed = await u64();
  if (vfsFileClaimed > size - cursor)
    throw denoFormatFailure("vfs file data length overruns the section");
  const vfsFileData = {
    sectionOffset: Number(cursor),
    length: Number(vfsFileClaimed),
  };
  cursor += vfsFileClaimed;
  if (size - cursor !== BigInt(DENO_SECTION_MAGIC.length))
    throw denoFormatFailure(
      "closing marker is missing or trailing bytes follow it",
    );
  const closing = await pull(DENO_SECTION_MAGIC.length);
  if (!closing.equals(DENO_SECTION_MAGIC))
    throw denoFormatFailure("closing marker does not match d3n0l4nd");
  return {
    metadata,
    npmSnapshotByteLength,
    specifiers,
    redirects,
    remoteModules,
    vfsHeaderByteLength: vfsHeader.length,
    vfsFileData,
    vfs: walkDenoVirtualFs(vfsJson, vfsFileData.length, signal),
    specifierText: unresolvedRemote ? null : namedSpecifiers,
  };
};

/** Parse a section that is already in memory. Tests and small fixtures use this. */
export const parseDenoSectionBytes = (
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<DenoParsedSection> =>
  parseDenoSection(
    bytes.length,
    (offset, length) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
    signal,
  );

const addRemoteBody = (total: bigint, length: number): bigint => {
  const next = total + BigInt(length);
  if (next > BigInt(MAX_DENO_REMOTE_BODY_BYTES))
    throw denoByteLimit(
      "remote module bodies",
      next,
      MAX_DENO_REMOTE_BODY_BYTES,
    );
  return next;
};

const assertTableCount = (count: number, scope: string): void => {
  if (count > MAX_DENO_TABLE_COUNT) {
    const allowance = `Deno compile ${scope} allowance of ${String(MAX_DENO_TABLE_COUNT)} records`;
    const message = `Deno compile ${scope} table claims ${String(count)} records, exceeding MAX_DENO_TABLE_COUNT (${String(MAX_DENO_TABLE_COUNT)} records). ${fixedAllowanceRemediation(allowance, "count")} This release has no runtime override. Host memory and NODE_OPTIONS do not raise it.`;
    throw new ArtifactReaderFailure("limit", message, {
      boundary: "capacity",
      userMessage: message,
    });
  }
};

const decodeStrict = (bytes: Buffer): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const decodeJson = (bytes: Buffer, scope: string): unknown => {
  const text = decodeStrict(bytes);
  if (text === undefined) throw denoFormatFailure(`${scope} is invalid`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw denoFormatFailure(`${scope} is invalid`);
  }
};

const observeMetadata = (value: unknown): DenoObservedMetadata => {
  const record = asRecord(value);
  if (record === undefined)
    throw denoUnsupported("metadata JSON is not an object");
  if (typeof record.entrypoint_key !== "string")
    throw denoUnsupported("entrypoint_key is missing or not a string");
  const caData = parseCaData(record.ca_data);
  return {
    entrypointKey: record.entrypoint_key,
    argv: stringArray(record.argv, "argv"),
    v8Flags: stringArray(record.v8_flags, "v8_flags"),
    permissions: jsonObject(record.permissions, "permissions"),
    unstableConfig: jsonObject(record.unstable_config, "unstable_config"),
    appName: optionalString(record.app_name, "app_name"),
    selfExtracting: optionalString(record.self_extracting, "self_extracting"),
    ...envVars(record.env_vars_from_env_file),
    caData,
    caDataByteLength: caData?.length ?? null,
    vfsCaseSensitivity: caseSensitivity(record.vfs_case_sensitivity),
  };
};

const stringArray = (
  value: unknown,
  label: string,
): readonly string[] | null => {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw denoUnsupported(`${label} is not an array of strings`);
  return value;
};

const jsonObject = (
  value: unknown,
  label: string,
): Record<string, JsonValue> | null => {
  if (value === undefined) return null;
  const parsed = jsonValueSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data === null ||
    typeof parsed.data !== "object" ||
    Array.isArray(parsed.data)
  )
    throw denoUnsupported(`${label} is not a JSON object`);
  return parsed.data;
};

const optionalString = (value: unknown, label: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw denoUnsupported(`${label} is not a string`);
  return value;
};

const envVars = (
  value: unknown,
): Pick<DenoObservedMetadata, "envVarCount" | "envVars"> => {
  if (value === undefined) return { envVarCount: null, envVars: null };
  const record = asRecord(value);
  if (record === undefined)
    throw denoUnsupported("env_vars_from_env_file is not an object");
  const vars = Object.entries(record).map(([name, stored]) => {
    if (typeof stored !== "string")
      throw denoUnsupported("env_vars_from_env_file values are not strings");
    return {
      name,
      value: stored,
      valueByteLength: Buffer.byteLength(stored, "utf8"),
    };
  });
  return { envVarCount: vars.length, envVars: vars };
};

const parseCaData = (value: unknown): readonly number[] | null => {
  if (value === undefined || value === null) return null;
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "number" ||
        !Number.isInteger(item) ||
        item < 0 ||
        item > 255,
    )
  )
    throw denoUnsupported("ca_data is not a byte array");
  return value as number[];
};

const caseSensitivity = (
  value: unknown,
): DenoObservedMetadata["vfsCaseSensitivity"] => {
  if (value === undefined) return null;
  if (value === "s") return "sensitive";
  if (value === "i") return "insensitive";
  throw denoUnsupported("vfs_case_sensitivity is not s or i");
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return Object.fromEntries(Object.entries(value));
};

export const denoFormatFailure = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `Deno compile section is malformed: ${detail}`,
  );

export const denoUnsupported = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "unavailable",
    `Deno compile section layout is unsupported: ${detail}`,
  );

export const denoByteLimit = (
  scope: string,
  claimed: number | bigint,
  allowance: number,
): ArtifactReaderFailure => {
  const name = `Deno compile ${scope} allowance of ${String(allowance)} bytes`;
  const message = `The ${scope} claims ${String(claimed)} bytes. ${fixedAllowanceRemediation(name, "parser")} This release has no runtime override.`;
  return new ArtifactReaderFailure("limit", message, {
    boundary: "memory",
    userMessage: message,
  });
};
