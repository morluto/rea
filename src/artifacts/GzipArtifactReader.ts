import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { basename } from "node:path";
import type { FileHandle } from "node:fs/promises";

import { artifactExpansionBudgetBytes } from "../domain/artifactExpansionBudget.js";
import { readUint16At } from "../domain/binaryContainer.js";
import { Budget } from "../domain/budget.js";
import type { ArtifactCommand } from "../domain/artifactGraph.js";
import { hasGzipHeader } from "../domain/tarFormat.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { errorMessage } from "../kernel/errorMessage.js";
import {
  ArtifactFileSource,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactReadCancelledBy,
  artifactReaderLimitFailure,
  assertArtifactReadActive,
  assertProducedEntry,
  copyArtifactEntry,
  normalizeArtifactPath,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { ownAsyncArtifactStream } from "./OwnedAsyncArtifactStream.js";

const MAX_GZIP_FNAME_BYTES = 4_096;
const CHUNK_BYTES = 64 * 1024;
const QUEUE_HIGH_WATER_BYTES = 1024 * 1024;

const normalizeSafeGzipFilename = (name: string): string | null => {
  if (name.includes("/") || name.includes("\\") || /^[A-Za-z]:/u.test(name)) {
    return null;
  }
  try {
    return normalizeArtifactPath(name);
  } catch {
    return null;
  }
};

const deriveFallbackFilename = (fallbackPath: string): string => {
  const base = basename(fallbackPath);
  if (base.toLowerCase().endsWith(".gz")) {
    const stem = base.slice(0, -3);
    return normalizeSafeGzipFilename(stem) ?? "decompressed_payload";
  }
  const unpacked =
    base.length > 0 && base !== "." && base !== ".." ? `${base}.unpacked` : "";
  return normalizeSafeGzipFilename(unpacked) ?? "decompressed_payload";
};

/** Extract original filename from GZIP header flags (RFC 1952) if present. */
const resolveGzipOriginalFilename = async (
  handle: FileHandle,
  size: number,
  fallbackPath: string,
  signal?: AbortSignal,
): Promise<{
  readonly path: string;
  readonly sourcePath?: string;
  readonly limitations: readonly string[];
}> => {
  const fallback = deriveFallbackFilename(fallbackPath);
  if (size < 10) {
    return { path: fallback, limitations: [] };
  }
  const prefix = await readArtifactFileBytes(
    handle,
    0,
    Math.min(512, size),
    size,
    signal,
  );
  if (!hasGzipHeader(prefix)) {
    return { path: fallback, limitations: [] };
  }
  const flags = prefix[3] ?? 0;
  // Bit 3 is FNAME
  if ((flags & 0x08) === 0) {
    return { path: fallback, limitations: [] };
  }

  let fnameOffset = 10;
  // If FEXTRA is set, skip extra field
  if ((flags & 0x04) !== 0) {
    if (prefix.length < 12) {
      return {
        path: fallback,
        limitations: [
          "GZIP FEXTRA header is truncated before FNAME; substituted carrier-derived filename.",
        ],
      };
    }
    const xlen = readUint16At(prefix, 10, true);
    fnameOffset = 12 + xlen;
  }

  if (fnameOffset >= size) {
    return {
      path: fallback,
      limitations: [
        "GZIP FNAME offset exceeds archive size; substituted carrier-derived filename.",
      ],
    };
  }

  let fnameSlice: Buffer;
  const nullInPrefix =
    fnameOffset < prefix.length ? prefix.indexOf(0, fnameOffset) : -1;
  if (nullInPrefix >= fnameOffset) {
    fnameSlice = prefix.subarray(fnameOffset, nullInPrefix + 1);
  } else {
    const readLen = Math.min(MAX_GZIP_FNAME_BYTES, size - fnameOffset);
    fnameSlice = await readArtifactFileBytes(
      handle,
      fnameOffset,
      readLen,
      size,
      signal,
    );
  }

  const nullByte = fnameSlice.indexOf(0);
  if (nullByte === -1) {
    return {
      path: fallback,
      limitations: [
        "GZIP FNAME header is unterminated or exceeds bound; substituted carrier-derived filename.",
      ],
    };
  }

  const name = fnameSlice.subarray(0, nullByte).toString("latin1");
  const normalizedName = normalizeSafeGzipFilename(name);
  if (normalizedName === null) {
    return {
      path: fallback,
      sourcePath: name,
      limitations: [
        "GZIP FNAME header contains an unsafe or empty path; substituted carrier-derived filename.",
      ],
    };
  }

  return {
    path: normalizedName,
    ...(normalizedName !== name ? { sourcePath: name } : {}),
    limitations: [],
  };
};

async function* compressedChunks(
  handle: Pick<FileHandle, "read">,
  size: number,
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  if (size <= 0) return;
  yield* readFileHandleChunks(handle, { start: 0, end: size - 1, signal });
}

const gzipStreamFailure = (
  cause: unknown,
  signal: AbortSignal,
  source: "input" | "gunzip",
): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (artifactReadCancelledBy(cause, signal) || signal.aborted) {
    return new ArtifactReaderFailure(
      "cancelled",
      "GZIP member read cancelled",
      {
        cause: signal.reason ?? cause,
      },
    );
  }
  const message = errorMessage(cause);
  if (source === "input") {
    return new ArtifactReaderFailure(
      "io",
      `GZIP carrier read error: ${message}`,
      { cause },
    );
  }
  return new ArtifactReaderFailure(
    "format",
    `GZIP decompression error: ${message}`,
    { cause },
  );
};

/** Single-stream decompression reader for GZIP archives. */
export class GzipArtifactReader implements ArtifactReader {
  readonly format = "gzip" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #streams = new Map<Readable, AbortController>();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  readonly #expandedBytes: number | undefined;
  #cachedEntry: ArtifactEntry | undefined;
  #closing = false;

  constructor(
    readonly path: string,
    admitted?: StableRegularFileDescriptor,
    expandedBytes?: number,
  ) {
    this.#source = new ArtifactFileSource(path, "gzip archive", admitted);
    this.#expandedBytes = expandedBytes;
  }

  provenance(): readonly ArtifactCommand[] {
    return [];
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      await this.#source.bindSha256(expectedSha256, signal);
    });
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      if (this.#cachedEntry !== undefined) await this.#source.read(signal);
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.#assertOpen(signal),
      );
    });
    this.#assertOpen(signal);
    const current = this.#cachedEntry!;
    options?.onCoverage?.({
      status: "complete",
      limitations: [...current.limitations],
    });
    yield copyArtifactEntry(current);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      assertProducedEntry(
        entry,
        this.#cachedEntry,
        "GZIP entry does not match its owning inventory",
      );
      const { handle, initial } = await this.#source.read(signal);
      this.#assertOpen(signal);
      const controller = new AbortController();
      const budget = new Budget(
        this.#expandedBytes ?? artifactExpansionBudgetBytes(initial.size),
      );
      return ownAsyncArtifactStream(
        this.#decompressChunks(handle, initial.size, budget, controller.signal),
        controller,
        {
          scope: this.#scope,
          streams: this.#streams,
          signal,
          label: "gzip",
          highWaterMark: CHUNK_BYTES,
        },
      );
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const [stream, controller] of this.#streams) {
      const cause = new ArtifactReaderFailure(
        "unavailable",
        "GZIP reader closed",
      );
      controller.abort(cause);
      stream.destroy(cause);
    }
    await this.#scope.close();
    await this.#source.close();
    this.#cachedEntry = undefined;
    this.#preparation.clear();
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing) {
      throw new ArtifactReaderFailure("unavailable", "GZIP reader is closed");
    }
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const {
      path: innerName,
      sourcePath,
      limitations,
    } = await resolveGzipOriginalFilename(
      handle,
      initial.size,
      this.path,
      signal,
    );
    await this.#source.read(signal);
    this.#assertOpen(signal);
    this.#cachedEntry = {
      path: innerName,
      ...(sourcePath !== undefined ? { sourcePath } : {}),
      kind: "file",
      declaredSize: null,
      compressedSize: initial.size,
      executable: false,
      encrypted: false,
      byteOffset: null,
      declaredIntegrity: null,
      unpacked: false,
      limitations,
      adapterKey: this.path,
    };
  }

  /**
   * Pull decompressed chunks over borrowed `handle.read()` ranges so neither
   * cancellation nor zlib errors ever close the caller's FileHandle, and
   * convert decompression failures into tagged `ArtifactReaderFailure` before
   * they reach the consumer stream.
   */
  async *#decompressChunks(
    handle: Pick<FileHandle, "read">,
    size: number,
    budget: Budget,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    const input = Readable.from(compressedChunks(handle, size, signal), {
      objectMode: false,
    });
    const gunzip = createGunzip();
    const queue: Buffer[] = [];
    let queuedBytes = 0;
    const streamState: {
      status: "open" | "ended" | "failed";
      failure?: ArtifactReaderFailure;
    } = { status: "open" };
    let wake: (() => void) | undefined;

    const notify = (): void => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };

    const fail = (cause: unknown, source: "input" | "gunzip"): void => {
      if (streamState.status === "open") {
        streamState.status = "failed";
        streamState.failure = gzipStreamFailure(cause, signal, source);
      }
      if (!input.destroyed) input.destroy();
      if (!gunzip.destroyed) gunzip.destroy();
      notify();
    };

    input.on("error", (cause: unknown) => fail(cause, "input"));
    gunzip.on("error", (cause: unknown) => fail(cause, "gunzip"));
    gunzip.on("data", (chunk: Buffer) => {
      if (streamState.status !== "open") return;
      try {
        budget.charge(chunk.length, () =>
          artifactReaderLimitFailure(
            "artifact_limits.expanded_bytes",
            budget.maximum,
            "bytes",
            undefined,
            "memory",
          ),
        );
      } catch (cause: unknown) {
        fail(cause, "gunzip");
        return;
      }
      queue.push(chunk);
      queuedBytes += chunk.length;
      if (queuedBytes > QUEUE_HIGH_WATER_BYTES) gunzip.pause();
      notify();
    });
    gunzip.once("end", () => {
      if (streamState.status === "open") streamState.status = "ended";
      notify();
    });

    input.pipe(gunzip);

    const onAbort = (): void => {
      fail(
        new ArtifactReaderFailure("cancelled", "GZIP member read cancelled", {
          cause: signal.reason,
        }),
        "input",
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      for (;;) {
        assertArtifactReadActive(signal);
        const next = queue.shift();
        if (next !== undefined) {
          queuedBytes -= next.length;
          if (queuedBytes <= QUEUE_HIGH_WATER_BYTES / 2) gunzip.resume();
          yield next;
          continue;
        }
        if (streamState.status === "ended") return;
        if (streamState.status === "failed") throw streamState.failure!;
        gunzip.resume();
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      input.unpipe(gunzip);
      if (!input.destroyed) input.destroy();
      if (!gunzip.destroyed) gunzip.destroy();
    }
  }
}
