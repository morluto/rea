import { BinaryReader } from "../../domain/binaryContainer.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import {
  ArtifactReaderFailure,
  malformedArtifact,
  abortIfNeeded,
  artifactReaderLimitFailure,
} from "../../resources/index.js";
import {
  DEFAULT_DENO_READER_LIMITS,
  type DenoReaderLimits,
} from "../../domain/artifactReaderLimits.js";
import { walkDenoVirtualFs, type DenoVfsWalk } from "./DenoVirtualFs.js";
import { parseJsonWithDuplicatePolicy } from "../../domain/jsonDuplicateMember.js";
import { strictUtf8Decoder } from "../../domain/strictUtf8.js";

/** Opening and closing marker of a Deno compile data section. */
export const DENO_SECTION_MAGIC = Buffer.from("d3n0l4nd", "latin1");

const REDIRECT_ROW_BYTES = 8;
const REDIRECT_BATCH_ROWS = 1_024;

const KNOWN_REMOTE_FLAGS = 0x0f;
const FLAG_TRANSPILED = 1 << 0;
const FLAG_SOURCE_MAP = 1 << 1;
const FLAG_CJS = 1 << 2;
const FLAG_UTF8 = 1 << 3;
const specifierDecoder = strictUtf8Decoder("preserve");
const jsonDecoder = strictUtf8Decoder("strip-signature");

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
  /** Declared specifier IDs. A null value identifies a row with invalid UTF-8. */
  readonly specifierText: ReadonlyMap<number, string | null>;
}

/** Read a section-relative range, returning the acquired prefix at physical EOF. */
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
  limits: DenoReaderLimits = DEFAULT_DENO_READER_LIMITS,
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
  const takeRange = (claimed: bigint, scope?: string): DenoByteRange => {
    if (cursor > size || claimed > size - cursor)
      throw denoFormatFailure(
        scope === undefined
          ? "length overruns the section"
          : `${scope} length overruns the section`,
      );
    const range = { sectionOffset: Number(cursor), length: Number(claimed) };
    cursor += claimed;
    return range;
  };
  const pull = async (bytes: number): Promise<Buffer> => {
    const range = takeRange(BigInt(bytes));
    return readExact(range.sectionOffset, range.length);
  };
  const u8 = async (): Promise<number> => (await pull(1))[0] ?? 0;
  const u32 = async (): Promise<number> =>
    new BinaryReader(await pull(4), true, "deno").u32(0);
  const u64 = async (): Promise<bigint> =>
    new BinaryReader(await pull(8), true, "deno").word(0, 64);
  const readBounded = async (
    claimed: bigint,
    field: "metadata_json_bytes" | "vfs_header_json_bytes",
    scope: string,
  ): Promise<Buffer> => {
    const range = takeRange(claimed, scope);
    if (claimed > BigInt(limits[field]))
      throw denoByteLimit(field, claimed, limits);
    return readExact(range.sectionOffset, range.length);
  };

  const metadataBytes = await readBounded(
    await u64(),
    "metadata_json_bytes",
    "metadata JSON",
  );
  const metadata = observeMetadata(decodeJson(metadataBytes, "metadata JSON"));
  const npmSnapshotByteLength = takeRange(await u64(), "npm snapshot").length;

  const specifierStart = cursor;
  const specifierCount = await u32();
  assertTableCount(specifierCount, limits);
  const specifierText = new Map<number, string | null>();
  let textBytes = 0;
  let invalidUtf8 = false;
  for (let index = 0; index < specifierCount; index += 1) {
    abortIfNeeded(signal);
    const length = await u32();
    const range = takeRange(BigInt(length), "specifier text");
    textBytes += length;
    if (textBytes > limits.specifier_text_bytes)
      throw denoByteLimit("specifier_text_bytes", undefined, limits);
    const bytes = await readExact(range.sectionOffset, range.length);
    const id = await u32();
    if (specifierText.has(id))
      throw denoFormatFailure(`duplicate specifier id ${String(id)}`);
    const decoded = decodeStrict(bytes, specifierDecoder);
    if (decoded === undefined) invalidUtf8 = true;
    specifierText.set(id, decoded ?? null);
  }
  const specifiers: DenoCountedRegion = {
    count: specifierCount,
    byteLength: Number(cursor - specifierStart),
    listing: invalidUtf8 ? "unsupported" : "listed",
  };
  const hasSpecifierText = (id: number): boolean =>
    typeof specifierText.get(id) === "string";

  const redirectStart = cursor;
  const redirectCount = await u32();
  assertTableCount(redirectCount, limits);
  const redirectIds = new Set<number>();
  let redirectListing: DenoListing = "listed";
  for (let index = 0; index < redirectCount;) {
    abortIfNeeded(signal);
    // A short last batch still admits every complete earlier row, so an earlier duplicate retains precedence.
    const rows = Math.min(
      redirectCount - index,
      REDIRECT_BATCH_ROWS,
      Math.floor(Number(size - cursor) / REDIRECT_ROW_BYTES),
    );
    if (rows === 0) throw denoFormatFailure("length overruns the section");
    const range = takeRange(BigInt(rows * REDIRECT_ROW_BYTES));
    const bytes = await read(range.sectionOffset, range.length);
    abortIfNeeded(signal);
    if (bytes.length > range.length)
      throw denoFormatFailure("section read was short");
    const batch = new BinaryReader(bytes, true, "deno");
    // Decode the acquired complete rows even if a later row ends at physical EOF.
    for (
      let offset = 0;
      offset <= bytes.length - REDIRECT_ROW_BYTES;
      offset += REDIRECT_ROW_BYTES
    ) {
      const from = batch.u32(offset);
      const to = batch.u32(offset + 4);
      if (redirectIds.has(from))
        throw denoFormatFailure(
          `duplicate redirect specifier id ${String(from)}`,
        );
      redirectIds.add(from);
      if (!hasSpecifierText(from) || !hasSpecifierText(to))
        redirectListing = "unsupported";
    }
    if (bytes.length < range.length)
      throw denoFormatFailure("section read was short");
    index += rows;
  }
  const redirects: DenoCountedRegion = {
    count: redirectCount,
    byteLength: Number(cursor - redirectStart),
    listing: redirectListing,
  };

  const remoteStart = cursor;
  const remoteCount = await u32();
  assertTableCount(remoteCount, limits);
  const remoteIds = new Set<number>();
  const modules: DenoRemoteModule[] = [];
  let remoteBodies = 0n;
  const takeRemoteBody = (length: number, scope: string): DenoByteRange => {
    const range = takeRange(BigInt(length), scope);
    remoteBodies = addRemoteBody(remoteBodies, length, limits);
    return range;
  };
  let unresolvedRemote = false;
  for (let index = 0; index < remoteCount; index += 1) {
    abortIfNeeded(signal);
    const specifierId = await u32();
    if (remoteIds.has(specifierId))
      throw denoFormatFailure(
        `duplicate remote specifier id ${String(specifierId)}`,
      );
    remoteIds.add(specifierId);
    if (!hasSpecifierText(specifierId)) unresolvedRemote = true;
    const mediaType = await u8();
    const data = takeRemoteBody(await u32(), "remote module");
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
      return takeRemoteBody(await u32(), scope);
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
    "vfs_header_json_bytes",
    "vfs header JSON",
  );
  const vfsJson = decodeJson(vfsHeader, "vfs header JSON");
  const vfsFileData = takeRange(await u64(), "vfs file data");
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
    vfs: walkDenoVirtualFs(vfsJson, vfsFileData.length, signal, limits),
    specifierText,
  };
};

const addRemoteBody = (
  total: bigint,
  length: number,
  limits: DenoReaderLimits,
): bigint => {
  const next = total + BigInt(length);
  if (next > BigInt(limits.remote_body_bytes))
    throw denoByteLimit("remote_body_bytes", undefined, limits);
  return next;
};

/** Each specifier, redirect and remote-module table shares one record budget. */
const assertTableCount = (count: number, limits: DenoReaderLimits): void => {
  if (count > limits.table_records)
    throw artifactReaderLimitFailure(
      "artifact_limits.deno.table_records",
      limits.table_records,
      "count",
      count,
    );
};

const decodeStrict = (
  bytes: Buffer,
  decoder: TextDecoder,
): string | undefined => {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
};

const decodeJson = (bytes: Buffer, scope: string): unknown => {
  const text = decodeStrict(bytes, jsonDecoder);
  if (text === undefined) throw denoFormatFailure(`${scope} is invalid`);
  const parsed = parseJsonWithDuplicatePolicy(text, "reject");
  if (!parsed.ok) {
    if (parsed.duplicate !== undefined)
      throw denoFormatFailure(
        `${scope} declares member ${JSON.stringify(parsed.duplicate.name)} more than once`,
      );
    throw denoFormatFailure(`${scope} is invalid`);
  }
  return parsed.value;
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
  malformedArtifact(
    "deno-standalone",
    `Deno compile section is malformed: ${detail}`,
  );

export const denoUnsupported = (detail: string): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "unavailable",
    `Deno compile section layout is unsupported: ${detail}`,
  );

const denoByteLimit = (
  field:
    | "metadata_json_bytes"
    | "vfs_header_json_bytes"
    | "specifier_text_bytes"
    | "remote_body_bytes",
  /**
   * A declared length is the complete need. A running total stops at the
   * first crossing, a lower bound, and is passed as undefined.
   */
  claimed: number | bigint | undefined,
  limits: DenoReaderLimits,
): ArtifactReaderFailure =>
  artifactReaderLimitFailure(
    `artifact_limits.deno.${field}`,
    limits[field],
    "bytes",
    claimed,
    "memory",
  );
