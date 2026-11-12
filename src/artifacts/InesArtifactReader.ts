import { artifactOperationCause } from "./ArtifactFileOperation.js";
import { readFileHandlePrefix } from "../filesystem/readFileHandlePrefix.js";
import { Transform, pipeline, type Readable } from "node:stream";
import {
  parseInesLayout,
  type InesInventory,
  type InesLayout,
} from "../domain/inesContainer.js";
import type { ArtifactCommand } from "../domain/artifactGraph.js";
import {
  RegularFileChangedError,
  assertStableRegularFileIdentity,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import type { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  ArtifactReaderFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { abortIfNeeded } from "./ArtifactHash.js";
import { streamChunkToBuffer } from "./StreamBytes.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";

export const INES_LIMITATION =
  "Classic iNES file regions are observed; mapper execution, CPU bank mappings, CHR-RAM contents, 6502 analysis and emulator behavior are not observed. Trailing bytes are retained without interpretation. NES 2.0 and UNIF are unsupported.";

/** Actual concatenated bytes observed by the inventory's ordered region scan. */
export type InesRegionScan = Omit<InesInventory["reconstruction"], "verified">;

const regionReadFailure = (cause: unknown): ArtifactReaderFailure =>
  cause instanceof ArtifactReaderFailure
    ? cause
    : new ArtifactReaderFailure("io", "Could not read iNES region", { cause });

/** Read positional regions from a descriptor retained by the artifact resource scope. */
export class InesArtifactReader implements ArtifactReader {
  readonly format = "ines" as const;
  readonly #entries = new Map<string, ArtifactEntry>();
  readonly #scope = new ArtifactResourceScope();
  readonly #lifecycle = new AbortController();
  readonly #closedFailure = new ArtifactReaderFailure(
    "unavailable",
    "iNES reader is closed",
  );
  #layout: InesLayout | undefined;
  #closed = false;

  constructor(
    private readonly path: string,
    private readonly source: StableRegularFileDescriptor,
    private readonly ownedSource?: OwnedFileHandle,
  ) {}

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    const layout = await this.#scope.run(async () => {
      await this.#verifySource(signal);
      const prefix = await readFileHandlePrefix(this.source.handle, 16, () =>
        abortIfNeeded(signal),
      );
      abortIfNeeded(signal);
      // Concurrent source changes take precedence over malformed header diagnostics.
      await this.#verifySource(signal);
      const parsed = parseInesLayout(prefix, this.source.initial.size);
      if (!parsed.ok) throw new ArtifactReaderFailure("format", parsed.error);
      this.#layout = parsed.value;
      this.#entries.clear();
      return parsed.value;
    });
    for (const region of layout.regions) {
      this.#assertOpen(signal);
      const entry: ArtifactEntry = {
        path: region.path,
        kind: "file",
        declaredSize: region.length,
        compressedSize: null,
        executable: false,
        encrypted: false,
        byteOffset: region.offset,
        declaredIntegrity: null,
        unpacked: false,
        limitations: [],
        adapterKey: region.path,
      };
      this.#entries.set(entry.adapterKey, copyArtifactEntry(entry));
      yield entry;
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(() => this.#openRegion(entry, signal));
  }

  async #openRegion(
    entry: ArtifactEntry,
    signal?: AbortSignal,
  ): Promise<Readable> {
    this.#assertOpen(signal);
    const produced = this.#entries.get(entry.adapterKey);
    if (produced === undefined || !sameArtifactEntry(entry, produced))
      throw new ArtifactReaderFailure(
        "integrity",
        "iNES region does not match this reader's inventory",
      );
    await this.#verifySource(signal);
    this.#assertOpen(signal);
    const offset = produced.byteOffset;
    const size = produced.declaredSize;
    if (offset === null || size === null || size <= 0)
      throw new ArtifactReaderFailure("integrity", "Invalid iNES region range");
    const active = AbortSignal.any([
      this.#lifecycle.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const failure = (): ArtifactReaderFailure =>
      this.#lifecycle.signal.aborted && active.reason === this.#closedFailure
        ? this.#closedFailure
        : new ArtifactReaderFailure("cancelled", "iNES region read cancelled", {
            cause: active.reason,
          });
    const source = readFileHandleChunks(this.source.handle, {
      start: offset,
      end: offset + size - 1,
      signal: active,
      cancellationFailure: failure,
    });
    // Transform destruction can precede an asynchronous final callback. Keep
    // that descriptor validation admitted independently of stream retirement.
    const verify = () => this.#scope.run(() => this.#verifySource(signal));
    let bytes = 0;
    const output = new Transform({
      destroy(cause, callback) {
        callback(cause === null ? null : regionReadFailure(cause));
      },
      transform(raw: unknown, _encoding, callback) {
        try {
          abortIfNeeded(signal);
          const chunk = streamChunkToBuffer(raw);
          bytes += chunk.length;
          callback(null, chunk);
        } catch (cause: unknown) {
          callback(regionReadFailure(cause));
        }
      },
      final(callback) {
        void (async () => {
          if (bytes !== size)
            throw new ArtifactReaderFailure(
              "integrity",
              "Truncated iNES region",
            );
          await verify();
        })().then(
          () => callback(),
          (cause: unknown) => callback(regionReadFailure(cause)),
        );
      },
    });
    output.on("error", () => undefined);
    let producerComplete = false;
    const onAbort = (): void => {
      if (producerComplete && !output.destroyed) output.destroy(failure());
    };
    const retired = new Promise<void>((resolve) => {
      output.once("close", () => {
        active.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    active.addEventListener("abort", onAbort, { once: true });
    void this.#scope
      .run(async () => {
        await Promise.all([
          new Promise<void>((resolve) => {
            pipeline(source, output, () => {
              producerComplete = true;
              if (active.aborted) onAbort();
              resolve();
            });
          }),
          retired,
        ]);
      })
      .catch((cause: unknown) => output.destroy(regionReadFailure(cause)));
    return output;
  }

  /** Validate the completed region scan without rereading its payload. */
  async verifyReconstruction(
    expectedSha256: string,
    observed: InesRegionScan,
    signal?: AbortSignal,
  ): Promise<InesInventory> {
    return this.#scope.run(() =>
      this.#verifyReconstruction(expectedSha256, observed, signal),
    );
  }

  async #verifyReconstruction(
    expectedSha256: string,
    observed: InesRegionScan,
    signal?: AbortSignal,
  ): Promise<InesInventory> {
    this.#assertOpen(signal);
    const layout = this.#layout;
    if (layout === undefined || this.#entries.size !== layout.regions.length)
      throw new ArtifactReaderFailure("integrity", "Incomplete iNES inventory");
    await this.#verifySource(signal);
    if (
      observed.region_order.length !== layout.regions.length ||
      layout.regions.some(
        (region, index) => observed.region_order[index] !== region.path,
      ) ||
      observed.bytes !== this.source.initial.size ||
      observed.sha256 !== expectedSha256
    )
      throw new ArtifactReaderFailure(
        "integrity",
        "iNES reconstruction differs from the source",
      );
    return {
      header: layout.header,
      reconstruction: {
        ...observed,
        verified: true,
      },
    };
  }

  provenance(): readonly ArtifactCommand[] {
    return [];
  }

  async close(): Promise<void> {
    // Inventory borrows its admitting scope's descriptor. Extraction owns its
    // separately opened descriptor and retains this reader if close fails.
    this.#closed = true;
    this.#lifecycle.abort(this.#closedFailure);
    await this.#scope.close();
    await this.ownedSource?.close();
  }

  #assertOpen(signal?: AbortSignal): void {
    abortIfNeeded(signal);
    if (this.#closed)
      throw new ArtifactReaderFailure("unavailable", "iNES reader is closed");
  }

  async #verifySource(signal?: AbortSignal): Promise<void> {
    this.#assertOpen(signal);
    try {
      await assertStableRegularFileIdentity(
        this.source.handle,
        this.path,
        this.source.initial,
        { symlinks: "reject", ...(signal === undefined ? {} : { signal }) },
      );
    } catch (cause: unknown) {
      if (cause instanceof RegularFileChangedError)
        throw new ArtifactReaderFailure(
          "integrity",
          "iNES source changed during reading",
          { cause: cause.cause ?? cause },
        );
      throw artifactOperationCause(cause);
    }
    // State validation is asynchronous even after the final byte was consumed.
    this.#assertOpen(signal);
  }
}
