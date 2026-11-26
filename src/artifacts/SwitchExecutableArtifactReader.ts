import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { decodeLz4Block } from "../compression/Lz4Block.js";
import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import type {
  SwitchExecutableEntryMetadata,
  SwitchExecutableMetadata,
} from "../domain/formatMetadata/packageAndGameMetadata.js";
import {
  hasMod0Magic,
  NRO_ASSET_HEADER_SIZE,
  NRO_HEADER_SIZE,
  nroMod0MagicExtent,
  NSO_HEADER_SIZE,
  parseNroAssetSection,
  parseNroHeader,
  parseNsoHeader,
  parseTextMod0Offset,
  SWITCH_TEXT_PREFIX_SIZE,
  type NroAssetSection,
  type NroHeader,
  type NsoHeader,
  type NsoSegment,
} from "../domain/switchExecutable.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  ArtifactEntryContentUnavailable,
  ArtifactReaderFailure,
  artifactParseFailure,
  artifactReadCancelledBy,
  artifactReaderLimitFailure,
  malformedArtifact,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import type { ArtifactMemberLifecycle } from "./OwnedArtifactStream.js";
import {
  PositionalArtifactReader,
  type PositionalArtifactEntries,
  type PositionalArtifactEntry,
} from "./PositionalArtifactReader.js";

const READ_CHUNK_BYTES = 64 * 1024;
const SEGMENT_PATHS = {
  text: "text.bin",
  rodata: "rodata.bin",
  data: "data.bin",
} as const;
const ASSET_PATHS = {
  icon: "assets/icon.jpg",
  nacp: "assets/control.nacp",
  romfs: "assets/romfs.bin",
} as const;

type SwitchEntry = PositionalArtifactEntry & {
  readonly formatMetadata: SwitchExecutableEntryMetadata;
};

/**
 * Why a listed entry's bytes cannot be served, decided at preparation. The
 * entry stays in the inventory with its limitation, so the refusal is
 * per-member unavailable content rather than a reader failure.
 */
type Refusal = () => ArtifactEntryContentUnavailable;

const unavailable = (
  limitation: string,
  cause: ArtifactReaderFailure,
): ArtifactEntryContentUnavailable =>
  new ArtifactEntryContentUnavailable(cause.message, limitation, { cause });

/**
 * Read a Nintendo Switch NSO or NRO executable without running or patching
 * it. NSO segments compressed with LZ4 are decompressed within the expansion
 * budget. Stored input and decompressed output are both charged before
 * allocation, so a small declared output cannot force a large read.
 */
export class SwitchExecutableArtifactReader extends PositionalArtifactReader<
  SwitchExecutableMetadata,
  SwitchEntry
> {
  override readonly format: "nso" | "nro";
  readonly #expandedBytes: number | undefined;
  readonly #refusals = new Map<string, Refusal>();
  /** Compressed segments already reserved against the expansion budget. */
  readonly #admittedStored = new Set<string>();
  #budget = 0;
  #charged = 0;

  constructor(
    path: string,
    format: "nso" | "nro",
    admitted?: StableRegularFileDescriptor,
    expandedBytes?: number,
  ) {
    const label = format === "nso" ? "NSO" : "NRO";
    super(path, label, admitted, `Switch ${label} executable`);
    this.format = format;
    this.#expandedBytes = expandedBytes;
  }

  formatMetadata(): SwitchExecutableMetadata | undefined {
    const metadata = this.preparedFormatMetadata;
    return metadata === undefined ? undefined : structuredClone(metadata);
  }

  protected override contentRefusal(
    entry: SwitchEntry,
  ): ArtifactReaderFailure | undefined {
    return (
      this.#refusals.get(entry.adapterKey)?.() ?? super.contentRefusal(entry)
    );
  }

  /** Serve a compressed NSO segment as its decompressed, loaded bytes. */
  protected override entrySource(
    entry: SwitchEntry,
    carrier: StableRegularFileDescriptor,
    member: ArtifactMemberLifecycle,
  ): Readable | undefined {
    if (!entry.formatMetadata.compressed) return undefined;
    const { signal, cancellationFailure } = member;
    let readState: "idle" | "pending" | "failed" = "idle";
    const source = Readable.from(
      this.#decodedSegment(entry, carrier, member, (state) => {
        readState = state;
      }),
      { objectMode: false },
    );
    const onAbort = (): void => {
      // A pending carrier read or decode owns its failure; once idle (such as
      // paused on backpressure), destroy the source immediately so pipeline
      // and reader.close() retire promptly.
      if (readState === "idle" && !source.destroyed)
        source.destroy(cancellationFailure(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    source.once("close", () => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) onAbort();
    return source;
  }

  async *#decodedSegment(
    entry: SwitchEntry,
    { handle, initial }: StableRegularFileDescriptor,
    member: ArtifactMemberLifecycle,
    onStateChange: (state: "idle" | "pending" | "failed") => void,
  ): AsyncIterable<Buffer> {
    const { signal, cancellationFailure } = member;
    let decoded: Buffer | undefined;
    onStateChange("pending");
    try {
      if (signal.aborted) throw cancellationFailure(signal.reason);
      const stored = entry.formatMetadata.file_size;
      const refused = this.#admitStoredInput(
        entry.adapterKey,
        entry.formatMetadata.role,
        stored,
        entry.declaredSize,
      );
      if (refused !== undefined) throw refused.failure;
      const input = await readArtifactFileBytes(
        "nso",
        handle,
        entry.formatMetadata.file_offset,
        stored,
        initial.size,
        signal,
      );
      decoded = await decodeLz4Block(
        input,
        entry.declaredSize,
        entry.declaredSize,
        signal,
      );
      onStateChange("idle");
    } catch (cause) {
      onStateChange("failed");
      if (artifactReadCancelledBy(cause, signal))
        throw cancellationFailure(signal.reason);
      if (
        !(
          cause instanceof BinaryFormatFailure ||
          cause instanceof BinaryResourceFailure
        )
      )
        throw cause;
      // Preparation decoded these bytes, so a changed carrier reports that
      // change before the stored data is blamed.
      await member.verify((verifySignal) => this.verifyCarrier(verifySignal));
      throw malformedArtifact(
        "nso",
        `NSO is malformed: ${entry.formatMetadata.role} segment LZ4 data is invalid: ${cause.message}`,
        { cause },
      );
    }
    try {
      if (signal.aborted) throw cancellationFailure(signal.reason);
      for (
        let offset = 0;
        offset < decoded.length;
        offset += READ_CHUNK_BYTES
      ) {
        if (signal.aborted) throw cancellationFailure(signal.reason);
        yield decoded.subarray(offset, offset + READ_CHUNK_BYTES);
      }
    } finally {
      decoded = undefined;
    }
  }

  protected override async prepareEntries(
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<SwitchExecutableMetadata, SwitchEntry>> {
    this.#refusals.clear();
    this.#admittedStored.clear();
    this.#charged = 0;
    const { handle, initial } = await this.verifyCarrier(signal);
    this.#budget =
      this.#expandedBytes ?? artifactExpansionBudgetBytes(initial.size);
    const read = (offset: number, length: number): Promise<Buffer> =>
      readArtifactFileBytes(
        this.format,
        handle,
        offset,
        length,
        initial.size,
        signal,
      );
    const headerSize =
      this.format === "nso" ? NSO_HEADER_SIZE : NRO_HEADER_SIZE;
    const headerBytes = await read(0, Math.min(initial.size, headerSize));
    return this.format === "nso"
      ? this.#prepareNso(headerBytes, initial.size, read, signal)
      : this.#prepareNro(headerBytes, initial.size, read, signal);
  }

  async #prepareNso(
    headerBytes: Buffer,
    fileSize: number,
    read: (offset: number, length: number) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<SwitchExecutableMetadata, SwitchEntry>> {
    const parsed = parseNsoHeader(headerBytes, fileSize);
    if (!parsed.ok) throw artifactParseFailure(parsed.error, signal);
    const header = parsed.value;
    const entries: SwitchEntry[] = [];
    const limitations: string[] = [];
    let textPrefix: Buffer | undefined;
    for (const segment of header.segments) {
      const adapterKey = `nso:${segment.name}`;
      const path = SEGMENT_PATHS[segment.name];
      const entryLimitations: string[] = [];
      let observed: string | null = null;
      if (segment.truncated) {
        const detail = `${segment.name} segment is truncated: it declares ${String(segment.fileSize)} stored bytes at offset ${String(segment.fileOffset)} but the file has ${String(fileSize)} bytes`;
        entryLimitations.push(detail);
        this.#refusals.set(adapterKey, () =>
          unavailable(
            detail,
            malformedArtifact("nso", `NSO is malformed: ${detail}`),
          ),
        );
      } else {
        const loaded = await this.#loadNsoSegment(segment, read, signal);
        if (loaded.ok) {
          observed = loaded.sha256;
          if (segment.name === "text") textPrefix = loaded.prefix;
        } else {
          entryLimitations.push(loaded.detail);
          const cause =
            loaded.limit ??
            malformedArtifact("nso", `NSO is malformed: ${loaded.detail}`);
          this.#refusals.set(adapterKey, () =>
            unavailable(loaded.detail, cause),
          );
        }
      }
      const hashStatus =
        observed === null
          ? "unavailable"
          : !segment.hashChecked
            ? "not-checked"
            : observed === segment.sha256
              ? "match"
              : "mismatch";
      if (hashStatus === "mismatch")
        entryLimitations.push(
          `${segment.name} segment SHA-256 ${observed ?? ""} does not match the header's ${segment.sha256}`,
        );
      limitations.push(...entryLimitations);
      const entry: SwitchEntry = {
        path,
        sourcePath: path,
        kind: "file",
        declaredSize: segment.size,
        compressedSize: segment.compressed ? segment.fileSize : null,
        byteLength: segment.fileSize,
        executable: segment.name === "text",
        encrypted: false,
        byteOffset: segment.fileOffset,
        declaredIntegrity: null,
        unpacked: false,
        limitations: entryLimitations,
        adapterKey,
        formatMetadata: {
          kind: "switch-executable-entry",
          role: segment.name,
          file_offset: segment.fileOffset,
          memory_offset: segment.memoryOffset,
          file_size: segment.fileSize,
          compressed: segment.compressed,
          declared_sha256: segment.sha256,
          observed_sha256: observed,
          hash_status: hashStatus,
        },
      };
      entries.push(entry);
    }
    if (header.unknownFlags !== 0)
      limitations.push(
        `NSO flags set unknown bits 0x${header.unknownFlags.toString(16)}; they are reported but not interpreted.`,
      );
    const mod0Offset =
      textPrefix === undefined ? null : parseTextMod0Offset(textPrefix);
    return {
      entries,
      coverage: {
        status: limitations.length === 0 ? "complete" : "unknown",
        limitations,
      },
      formatMetadata: nsoMetadata(header, mod0Offset),
    };
  }

  /** Read one NSO segment, decompressing it when flagged, and hash it. */
  async #loadNsoSegment(
    segment: NsoSegment,
    read: (offset: number, length: number) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly sha256: string; readonly prefix: Buffer }
    | {
        readonly ok: false;
        readonly detail: string;
        readonly limit: ArtifactReaderFailure | undefined;
      }
  > {
    if (segment.compressed) {
      const refused = this.#admitStoredInput(
        `nso:${segment.name}`,
        segment.name,
        segment.fileSize,
        segment.size,
      );
      if (refused !== undefined)
        return { ok: false, detail: refused.detail, limit: refused.failure };
      const input = await read(segment.fileOffset, segment.fileSize);
      let decoded: Buffer;
      try {
        decoded = await decodeLz4Block(
          input,
          segment.size,
          segment.size,
          signal,
        );
      } catch (cause) {
        if (
          cause instanceof BinaryFormatFailure ||
          cause instanceof BinaryResourceFailure
        )
          return {
            ok: false,
            detail: `${segment.name} segment LZ4 data is invalid: ${cause.message}`,
            limit: undefined,
          };
        throw cause;
      }
      return {
        ok: true,
        sha256: sha256Hex(decoded),
        prefix: decoded.subarray(0, SWITCH_TEXT_PREFIX_SIZE),
      };
    }
    const hash = createHash("sha256");
    let prefix = Buffer.alloc(0);
    for (let done = 0; done < segment.size;) {
      this.assertOpen(signal);
      const chunk = await read(
        segment.fileOffset + done,
        Math.min(READ_CHUNK_BYTES, segment.size - done),
      );
      if (done === 0)
        prefix = Buffer.from(chunk.subarray(0, SWITCH_TEXT_PREFIX_SIZE));
      hash.update(chunk);
      done += chunk.length;
    }
    return { ok: true, sha256: hash.digest("hex"), prefix };
  }

  async #prepareNro(
    headerBytes: Buffer,
    fileSize: number,
    read: (offset: number, length: number) => Promise<Buffer>,
    signal?: AbortSignal,
  ): Promise<PositionalArtifactEntries<SwitchExecutableMetadata, SwitchEntry>> {
    const parsed = parseNroHeader(headerBytes, fileSize);
    if (!parsed.ok) throw artifactParseFailure(parsed.error, signal);
    const header = parsed.value;
    const limitations: string[] = [];
    const entries: SwitchEntry[] = [];
    const add = (
      role: SwitchExecutableEntryMetadata["role"],
      path: string,
      fileOffset: number,
      size: number,
      truncated: boolean,
      memoryOffset: number | null,
    ): void => {
      const adapterKey = `nro:${role}`;
      const entryLimitations: string[] = [];
      if (truncated) {
        const detail = `${role} ${memoryOffset === null ? "asset" : "segment"} is truncated: it declares ${String(size)} bytes at offset ${String(fileOffset)} but the file has ${String(fileSize)} bytes`;
        entryLimitations.push(detail);
        limitations.push(detail);
        this.#refusals.set(adapterKey, () =>
          unavailable(
            detail,
            malformedArtifact("nro", `NRO is malformed: ${detail}`),
          ),
        );
      }
      entries.push({
        path,
        sourcePath: path,
        kind: "file",
        declaredSize: size,
        compressedSize: null,
        executable: role === "text",
        encrypted: false,
        byteOffset: fileOffset,
        declaredIntegrity: null,
        unpacked: false,
        limitations: entryLimitations,
        adapterKey,
        formatMetadata: {
          kind: "switch-executable-entry",
          role,
          file_offset: fileOffset,
          memory_offset: memoryOffset,
          file_size: size,
          compressed: false,
          declared_sha256: null,
          observed_sha256: null,
          hash_status: truncated ? "unavailable" : "not-checked",
        },
      });
    };
    for (const segment of header.segments)
      add(
        segment.name,
        SEGMENT_PATHS[segment.name],
        segment.fileOffset,
        segment.size,
        segment.truncated,
        segment.fileOffset,
      );
    let assets: NroAssetSection | undefined;
    const trailing = fileSize - header.size;
    if (trailing < 0)
      limitations.push(
        `NRO declares an image size of ${String(header.size)} bytes but the file has ${String(fileSize)} bytes; the missing ${String(-trailing)} bytes were not read.`,
      );
    else if (trailing > 0) {
      const assetBytes = await read(
        header.size,
        Math.min(NRO_ASSET_HEADER_SIZE, trailing),
      );
      const parsedAssets = parseNroAssetSection(
        assetBytes,
        header.size,
        fileSize,
      );
      // A damaged trailer does not invalidate the segments before it.
      if (!parsedAssets.ok)
        limitations.push(
          `${parsedAssets.error.message}; the ${String(trailing)} bytes after the NRO image are not interpreted.`,
        );
      else {
        assets = parsedAssets.value;
        if (assets === undefined)
          limitations.push(
            `${String(trailing)} bytes follow the NRO image without an ASET header; they are not interpreted.`,
          );
      }
    }
    for (const message of assets?.rejected ?? [])
      limitations.push(`${message}; that asset is not listed.`);
    for (const asset of assets?.assets ?? [])
      add(
        asset.name,
        ASSET_PATHS[asset.name],
        asset.fileOffset,
        asset.size,
        asset.truncated,
        null,
      );
    const mod0Extent = nroMod0MagicExtent(header, fileSize);
    const mod0Present =
      mod0Extent === undefined
        ? null
        : hasMod0Magic(await read(mod0Extent.offset, mod0Extent.size));
    return {
      entries,
      coverage: {
        status: limitations.length === 0 ? "complete" : "unknown",
        limitations,
      },
      formatMetadata: nroMetadata(header, assets, mod0Present),
    };
  }

  /**
   * Reserve the stored input and the decoded output of one compressed
   * segment, or refuse before either buffer is allocated. A later open of an
   * admitted segment does not reserve again; it still refuses a read the
   * budget cannot hold.
   */
  #admitStoredInput(
    key: string,
    name: string,
    stored: number,
    decoded: number,
  ):
    | { readonly detail: string; readonly failure: ArtifactReaderFailure }
    | undefined {
    if (
      this.#admittedStored.has(key) &&
      stored <= this.#budget &&
      decoded <= this.#budget
    )
      return undefined;
    const remaining = this.#budget - this.#charged;
    if (decoded > remaining || stored > remaining - decoded) {
      const detail = `${name} segment allocates ${String(stored)} stored bytes and ${String(decoded)} decoded bytes, over the remaining artifact_limits.expanded_bytes budget of ${String(remaining)}`;
      return {
        detail,
        failure: artifactReaderLimitFailure(
          "artifact_limits.expanded_bytes",
          this.#budget,
          "bytes",
          this.#charged + stored + decoded,
          "memory",
        ),
      };
    }
    this.#charged += stored + decoded;
    this.#admittedStored.add(key);
    return undefined;
  }
}

const nsoMetadata = (
  header: NsoHeader,
  mod0Offset: number | null,
): SwitchExecutableMetadata => ({
  kind: "switch-executable",
  format: "nso",
  version: header.version,
  flags: header.flags,
  unknown_flags: header.unknownFlags,
  module_id: header.moduleId,
  bss_size: header.bssSize,
  mod0_offset: mod0Offset,
  // Checking the magic needs the loaded segment that holds the offset; only
  // the offset is reported for NSO.
  mod0_present: null,
  embedded: { ...header.embedded },
  dynstr: { ...header.dynstr },
  dynsym: { ...header.dynsym },
  image_size: null,
  asset_section: null,
});

const nroMetadata = (
  header: NroHeader,
  assets: NroAssetSection | undefined,
  mod0Present: boolean | null,
): SwitchExecutableMetadata => ({
  kind: "switch-executable",
  format: "nro",
  version: header.version,
  flags: header.flags,
  unknown_flags: 0,
  module_id: header.moduleId,
  bss_size: header.bssSize,
  mod0_offset: header.mod0Offset,
  mod0_present: mod0Present,
  embedded: { ...header.embedded },
  dynstr: { ...header.dynstr },
  dynsym: { ...header.dynsym },
  image_size: header.size,
  asset_section:
    assets === undefined
      ? null
      : { offset: assets.offset, version: assets.version },
});
