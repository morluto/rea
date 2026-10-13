import type { FileHandle } from "node:fs/promises";
import { PassThrough, type Readable } from "node:stream";
import { once } from "node:events";

import {
  ERR_AMBIGUOUS_ARCHIVE,
  ERR_BAD_FORMAT,
  ERR_CENTRAL_DIRECTORY_NOT_FOUND,
  ERR_ENCRYPTED_CENTRAL_DIRECTORY,
  ERR_ENTRY_DATA_OUT_OF_BOUNDS,
  ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND,
  ERR_EOCDR_NOT_FOUND,
  ERR_EXTRAFIELD_ZIP64_NOT_FOUND,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_CRC32,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_LOCAL_FILE_HEADER_NOT_FOUND,
  ERR_OVERLAPPING_ENTRY,
  ERR_SPLIT_ZIP_FILE,
  ERR_UNSUPPORTED_COMPRESSION,
  ERR_UNSUPPORTED_ENCRYPTION,
  ERR_UNSUPPORTED_UINT64,
  Reader,
  ZipReader,
  type Entry,
  type FileEntry,
} from "@zip.js/zip.js";

import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import type { ZipPackageFormat } from "../domain/zipPackageFormat.js";
import {
  ARTIFACT_DECOMPRESSION_RATIO,
  artifactDecompressionBudgetBytes,
  MINIMUM_ARTIFACT_DECOMPRESSION_BYTES,
} from "../domain/artifactDecompressionBudget.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";

const ZIP_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

class NodeFileReader extends Reader<string> {
  #handle: FileHandle | undefined;
  #owner: OwnedFileHandle | undefined;
  #initPromise: Promise<void> | undefined;
  readonly #ownsHandle: boolean;

  constructor(
    private readonly path: string,
    private readonly maximumReadBytes?: number,
    private readonly admitted?: StableRegularFileDescriptor,
  ) {
    super(path);
    this.#ownsHandle = admitted === undefined;
  }

  override init(): Promise<void> {
    this.#initPromise ??= this.#initialize();
    return this.#initPromise;
  }

  async #initialize(): Promise<void> {
    try {
      const handle =
        this.admitted?.handle ??
        (await openRegularFile(this.path, { symlinks: "reject" }));
      this.#handle = handle;
      if (this.#ownsHandle) this.#owner = new OwnedFileHandle(handle);
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure) {
        this.#owner = cause.owner;
        const primary =
          cause.cause instanceof NonRegularFileReadError
            ? new ArtifactReaderFailure(
                "format",
                `ZIP source is not a regular file: ${this.path}`,
                { cause: cause.cause },
              )
            : cause.cause;
        throw ArtifactReaderFailure.withCleanup(
          primary,
          ArtifactReaderFailure.cleanupObservation(
            cause.cleanupCause,
            this.path,
          ),
        );
      }
      if (cause instanceof NonRegularFileReadError)
        throw new ArtifactReaderFailure(
          "format",
          `ZIP source is not a regular file: ${this.path}`,
          { cause },
        );
      throw cause;
    }
    const metadata = await this.#handle.stat();
    if (
      !metadata.isFile() ||
      (this.admitted !== undefined &&
        !sameRegularFileState(this.admitted.initial, metadata))
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `ZIP source identity changed before reading: ${this.path}`,
      );
    this.size = metadata.size;
  }

  override async readUint8Array(
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    const handle = this.#handle;
    if (handle === undefined) throw new Error("ZIP reader is not initialized");
    const readBytes = Math.min(length, this.size - index);
    if (
      this.maximumReadBytes !== undefined &&
      readBytes > this.maximumReadBytes
    )
      throw new ArtifactReaderFailure(
        "limit",
        `ZIP metadata read requires ${readBytes} bytes, exceeding the ${this.maximumReadBytes}-byte read budget`,
      );
    const bytes = Buffer.alloc(readBytes);
    const read = await handle.read(bytes, 0, bytes.length, index);
    return bytes.subarray(0, read.bytesRead);
  }

  async closeHandle(): Promise<void> {
    if (!this.#ownsHandle) return;
    await this.#initPromise?.catch(() => undefined);
    if (this.#owner === undefined) return;
    await this.#owner.close();
    this.#owner = undefined;
    this.#handle = undefined;
  }
}

/** Lazy Zip64-capable reader with CRC and overlap verification on every read. */
export class ZipArtifactReader implements ArtifactReader {
  readonly format: ZipPackageFormat;
  readonly #source: NodeFileReader;
  readonly #reader: ZipReader<string>;
  readonly #entries = new Map<
    string,
    { readonly source: Entry; readonly metadata: ArtifactEntry }
  >();
  /** Optionally bound each metadata read before allocating its backing buffer. */
  constructor(
    path: string,
    format: ZipPackageFormat,
    maximumMetadataReadBytes?: number,
    admitted?: StableRegularFileDescriptor,
  ) {
    this.format = format;
    this.#source = new NodeFileReader(path, maximumMetadataReadBytes, admitted);
    this.#reader = new ZipReader(this.#source, {
      checkSignature: true,
      checkOverlappingEntry: true,
      // REA applies its own provider-neutral path validation in scanReader and
      // must preserve that typed failure instead of zip.js rejecting first.
      filenameValidation: "tolerant",
    });
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    let index = 0;
    // A traversal owns its accounting, including overlapping or repeated passes.
    let declaredFileBytes = 0;
    for await (const entry of typedZipFailures(
      this.#reader.getEntriesGenerator({ decodeText: decodeZipEntryText }),
    )) {
      abortIfNeeded(signal);
      // ZIP member identity is its directory occurrence, not its filename.
      // Logical path uniqueness belongs to the artifact inventory boundary.
      const metadata = projectZipEntry(entry, index++);
      // zip.js enforces each member's declared output size, so this sum bounds streamed work.
      if (
        metadata.kind === "file" &&
        !metadata.encrypted &&
        metadata.declaredSize !== null &&
        Number.isSafeInteger(metadata.declaredSize) &&
        metadata.declaredSize >= 0
      ) {
        declaredFileBytes += metadata.declaredSize;
        const budget = artifactDecompressionBudgetBytes(this.#source.size);
        if (declaredFileBytes > budget)
          throw new ArtifactReaderFailure(
            "limit",
            `ZIP entries declare ${String(declaredFileBytes)} uncompressed bytes, exceeding this archive's ${String(budget)}-byte decompression budget (${String(MINIMUM_ARTIFACT_DECOMPRESSION_BYTES)}-byte minimum, ${String(ARTIFACT_DECOMPRESSION_RATIO)}x archive size); a small archive cannot expand this far`,
          );
      }
      const stored = this.#entries.get(metadata.adapterKey);
      if (stored !== undefined && !sameArtifactEntry(metadata, stored.metadata))
        throw new ArtifactReaderFailure(
          "integrity",
          `ZIP member identity changed during enumeration: ${entry.filename}`,
        );
      if (stored === undefined)
        this.#entries.set(metadata.adapterKey, {
          source: entry,
          metadata: copyArtifactEntry(metadata),
        });
      yield metadata;
    }
  }

  open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    const stored = this.#entries.get(entry.adapterKey);
    if (stored === undefined || !sameArtifactEntry(entry, stored.metadata))
      return Promise.reject(
        new ArtifactReaderFailure(
          "integrity",
          "ZIP entry metadata does not match this reader's inventory",
        ),
      );
    const source = stored.source;
    if (source.directory || isSymlink(source))
      return Promise.reject(
        new ArtifactReaderFailure("format", "ZIP entry is not a regular file"),
      );
    if (source.encrypted)
      return Promise.reject(
        new ArtifactReaderFailure(
          "unavailable",
          "Encrypted ZIP entry is unsupported",
        ),
      );
    return Promise.resolve(extractStream(source, signal));
  }

  async close(): Promise<void> {
    // best-effort cleanup: zip-reader close must not mask prior extraction state.
    await this.#reader.close().catch(() => undefined);
    await this.#source.closeHandle();
  }

  provenance(): readonly [] {
    return [];
  }
}

const projectZipEntry = (entry: Entry, index: number): ArtifactEntry => {
  const symlink = isSymlink(entry);
  return {
    path: zipEntryPath(entry),
    kind: entry.directory ? "directory" : symlink ? "symlink" : "file",
    declaredSize: entry.directory ? null : entry.uncompressedSize,
    compressedSize: entry.directory ? null : entry.compressedSize,
    executable: entry.executable,
    encrypted: entry.encrypted,
    byteOffset: null,
    declaredSha256: null,
    unpacked: false,
    limitations: symlink ? ["Archive symlink target was not read."] : [],
    adapterKey: `zip-entry:${index}`,
  };
};

const decodeZipEntryText = (
  bytes: Uint8Array,
  encoding: string,
  type: "filename" | "comment",
): string | undefined => {
  if (type !== "filename") return undefined;
  if (encoding === "utf-8")
    return decodeStrictZipUtf8(bytes, "ZIP filename is not valid UTF-8");
  return encoding === "cp437" ? decodeCp437(bytes) : undefined;
};

/** CP437 characters for bytes 0x80-0xFF. */
const CP437_HIGH_HALF =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00A0";

/**
 * Decode a legacy ZIP name with the Unicode CP437 mapping, which Python's
 * zipfile also uses: bytes below 0x80 are ASCII. zip.js shows 0x01-0x1F and
 * 0x7F as IBM PC display glyphs, which turns the macOS folder icon file
 * `Icon\r` into `Icon♪`.
 */
const decodeCp437 = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) =>
    byte < 0x80
      ? String.fromCharCode(byte)
      : CP437_HIGH_HALF.charAt(byte - 0x80),
  ).join("");

const zipEntryPath = (entry: Entry): string => {
  const field = entry.extraFieldUnicodePath;
  if (field?.valid !== true) return entry.filename;
  return decodeStrictZipUtf8(
    field.data.subarray(5),
    "ZIP Unicode Path extra field is not valid UTF-8",
  );
};

const decodeStrictZipUtf8 = (bytes: Uint8Array, message: string): string => {
  try {
    // Keep the adapter's path semantics aligned with zip.js's default decoder:
    // a leading U+FEFF is part of a member name, not a transport signature.
    return ZIP_UTF8_DECODER.decode(bytes);
  } catch (cause: unknown) {
    throw new ArtifactReaderFailure("format", message, { cause });
  }
};

const extractStream = (entry: FileEntry, signal?: AbortSignal): Readable => {
  const output = new PassThrough();
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(signal?.reason);
    // AbortSignal listeners dispatch synchronously, so this destroy wins the race
    // against `getData` rejecting with its own AbortError. That ordering is what
    // keeps the caller-visible failure typed as `cancelled`.
    output.destroy(
      new ArtifactReaderFailure("cancelled", "ZIP operation cancelled"),
    );
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  // `close` covers both a consumer walking away mid-entry and normal completion
  // after `end()`; aborting then is harmless because `getData` has already
  // resolved, and it releases the producer in the abandoned-consumer case.
  output.once("close", () => {
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  });
  const writable = new WritableStream<Uint8Array>({
    write: async (chunk) => {
      abortIfNeeded(signal);
      if (!output.write(Buffer.from(chunk)))
        await once(output, "drain", { signal: controller.signal });
    },
    close: () => {
      output.end();
    },
    abort: (reason) => {
      output.destroy(toError(typedZipFailure(reason)));
    },
  });
  void entry
    .getData(writable, {
      signal: controller.signal,
      checkSignature: true,
      checkOverlappingEntry: true,
      onprogress: () => abortIfNeeded(signal),
    })
    .catch((cause: unknown) => output.destroy(toError(typedZipFailure(cause))));
  return output;
};

/** zip.js reports archive faults as plain errors identified by message. */
const ZIP_FAILURE_REASONS: ReadonlyMap<string, "format" | "unavailable"> =
  new Map([
    ...[
      ERR_AMBIGUOUS_ARCHIVE,
      ERR_BAD_FORMAT,
      ERR_CENTRAL_DIRECTORY_NOT_FOUND,
      ERR_ENTRY_DATA_OUT_OF_BOUNDS,
      ERR_EOCDR_LOCATOR_ZIP64_NOT_FOUND,
      ERR_EOCDR_NOT_FOUND,
      ERR_EXTRAFIELD_ZIP64_NOT_FOUND,
      ERR_INVALID_COMPRESSED_DATA,
      ERR_INVALID_CRC32,
      ERR_INVALID_UNCOMPRESSED_SIZE,
      ERR_LOCAL_FILE_HEADER_NOT_FOUND,
      ERR_OVERLAPPING_ENTRY,
      ERR_UNSUPPORTED_UINT64,
    ].map((message) => [message, "format"] as const),
    ...[
      ERR_ENCRYPTED_CENTRAL_DIRECTORY,
      ERR_SPLIT_ZIP_FILE,
      ERR_UNSUPPORTED_COMPRESSION,
      ERR_UNSUPPORTED_ENCRYPTION,
    ].map((message) => [message, "unavailable"] as const),
  ]);

/** Type a zip.js archive fault so consumers do not report it as file I/O. */
const typedZipFailure = (cause: unknown): unknown => {
  if (!(cause instanceof Error) || cause instanceof ArtifactReaderFailure)
    return cause;
  const reason = ZIP_FAILURE_REASONS.get(cause.message);
  if (reason === undefined) return cause;
  return new ArtifactReaderFailure(
    reason,
    reason === "format"
      ? `ZIP archive is malformed: ${cause.message}`
      : `ZIP archive uses an unsupported feature: ${cause.message}`,
    { cause },
  );
};

async function* typedZipFailures<T>(
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  try {
    yield* source;
  } catch (cause: unknown) {
    throw typedZipFailure(cause);
  }
}

const isSymlink = (entry: Entry): boolean =>
  entry.unixMode !== undefined && (entry.unixMode & 0o170000) === 0o120000;

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure("cancelled", "ZIP operation cancelled");
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("ZIP extraction failed");
