import { Readable } from "node:stream";
import { inflate } from "node:zlib";
import { setImmediate } from "node:timers/promises";

import {
  androidBackupTarEntries,
  ANDROID_BACKUP_DIRECTORY_BYTES,
  parseAndroidBackupHeader,
  type AndroidBackupDecodeFailure,
} from "../domain/androidBackup.js";
import type { ArtifactFormatMetadata } from "../domain/artifactFormatMetadata.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { ArtifactFileSource } from "./ArtifactFileSource.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { assertArtifactReadActive } from "./ArtifactFileOperation.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "./ArtifactPaths.js";
import {
  ArtifactReaderFailure,
  artifactFixedLimitFailure,
  copyArtifactEntry,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "./ArtifactReader.js";

// Retaining encoded and decoded buffers plus inflater output needs bounded memory.
export const ANDROID_BACKUP_MAX_BYTES = 64 * 1024 * 1024;
const MAX_MEMBER_STREAMS = 4;
const LABEL = "Android backup";
type BackupMetadata = Extract<
  ArtifactFormatMetadata,
  { kind: "android-backup" }
>;
type BackupMember = { readonly entry: ArtifactEntry; readonly bytes: Buffer };

const decodeFailure = (
  failure: AndroidBackupDecodeFailure,
): ArtifactReaderFailure =>
  failure.kind === "limit"
    ? artifactFixedLimitFailure(
        "Android backup PAX representation",
        ANDROID_BACKUP_DIRECTORY_BYTES,
        "bytes",
      )
    : new ArtifactReaderFailure(
        failure.kind === "format" ? "format" : "unavailable",
        `${LABEL}: ${failure.message}`,
      );

const inflatePayload = (payload: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    inflate(
      payload,
      { maxOutputLength: ANDROID_BACKUP_MAX_BYTES, info: true },
      (cause, result) => {
        if (cause !== null) {
          reject(
            "code" in cause && cause.code === "ERR_BUFFER_TOO_LARGE"
              ? artifactFixedLimitFailure(
                  "Android backup expanded TAR",
                  ANDROID_BACKUP_MAX_BYTES,
                  "bytes",
                )
              : new ArtifactReaderFailure(
                  "format",
                  "Android backup has an invalid or truncated zlib payload",
                  { cause },
                ),
          );
          return;
        }
        // Node's info option returns the inflater's consumed input alongside bytes.
        const decoded = result as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        if (decoded.engine.bytesWritten !== payload.length) {
          reject(
            new ArtifactReaderFailure(
              "format",
              "Android backup has trailing compressed payload bytes",
            ),
          );
          return;
        }
        resolve(decoded.buffer);
      },
    );
  });

/** Bounded offline envelope/TAR reader; never invokes ADB or restores content. */
export class AndroidBackupArtifactReader implements ArtifactReader {
  readonly format = "android-backup" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #members = new Map<string, BackupMember>();
  readonly #streams = new Set<Readable>();
  #metadata: BackupMetadata | undefined;
  #prepared: Promise<void> | undefined;
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, LABEL, admitted);
  }

  formatMetadata(): BackupMetadata | undefined {
    return this.#metadata === undefined ? undefined : { ...this.#metadata };
  }

  async prepareContainer(
    expectedSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#scope.run(() =>
      this.#source.bindSha256(expectedSha256, signal),
    );
  }

  async *entries(
    signal?: AbortSignal,
    options?: ArtifactTraversalOptions,
  ): AsyncIterable<ArtifactEntry> {
    await this.#scope.run(async () => {
      this.#assertOpen(signal);
      this.#prepared ??= this.#prepare(signal);
      await this.#prepared;
      await this.#source.read(signal);
    });
    this.#assertOpen(signal);
    if (this.#metadata?.directory_status !== "available") {
      options?.onCoverage?.({
        status: "unknown",
        limitations: [
          `Android backup encryption method ${JSON.stringify(this.#metadata?.encryption)} is unsupported; member identities and contents remain unknown. No decryption was attempted.`,
        ],
      });
      return;
    }
    let index = 0;
    for (const { entry } of this.#members.values()) {
      if (index++ % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const member = this.#members.get(entry.adapterKey);
      if (member === undefined || !sameArtifactEntry(entry, member.entry))
        throw new ArtifactReaderFailure(
          "integrity",
          "Android backup entry does not match its owning inventory",
        );
      await this.#source.read(signal);
      this.#assertOpen(signal);
      if (member.entry.kind !== "file")
        throw new ArtifactReaderFailure(
          "unavailable",
          "Android backup directory has no file contents",
        );
      if (this.#streams.size >= MAX_MEMBER_STREAMS)
        throw new ArtifactReaderFailure(
          "limit",
          "Android backup reader already owns four member streams",
          { boundary: "capacity" },
        );
      const output = Readable.from(this.#chunks(member.bytes, signal), {
        objectMode: false,
      });
      output.on("error", () => undefined);
      this.#streams.add(output);
      const onAbort = (): void => {
        output.destroy(
          new ArtifactReaderFailure(
            "cancelled",
            "Android backup read cancelled",
            { cause: signal?.reason },
          ),
        );
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const completion = new Promise<void>((resolve) =>
        output.once("close", () => {
          signal?.removeEventListener("abort", onAbort);
          this.#streams.delete(output);
          resolve();
        }),
      );
      void this.#scope
        .run(() => completion)
        .catch((cause: unknown) =>
          output.destroy(
            new Error("Android backup stream ownership failed", { cause }),
          ),
        );
      if (signal?.aborted === true) onAbort();
      return output;
    });
  }

  async *#chunks(bytes: Buffer, signal?: AbortSignal): AsyncIterable<Buffer> {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      await setImmediate();
      this.#assertOpen(signal);
      yield Buffer.from(bytes.subarray(offset, offset + 64 * 1024));
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure(
          "unavailable",
          "Android backup reader closed",
        ),
      );
    await this.#scope.close();
    await this.#source.close();
    this.#members.clear();
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure(
        "unavailable",
        "Android backup reader is closed",
      );
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const prefix = await readArtifactFileBytes(
      handle,
      0,
      Math.min(initial.size, 1024),
      initial.size,
      signal,
    );
    const parsed = parseAndroidBackupHeader(prefix);
    if (!parsed.ok) throw decodeFailure(parsed.error);
    const header = parsed.value;
    const payloadOffset = header.payloadOffset;
    if (header.encryption !== "none" && header.encryption !== "AES-256")
      throw new ArtifactReaderFailure(
        "unavailable",
        `Unsupported Android backup encryption method: ${header.encryption}`,
      );
    this.#metadata = {
      kind: "android-backup",
      format_version: header.version,
      compressed: header.compressed,
      encryption: header.encryption,
      payload_offset: payloadOffset,
      directory_status:
        header.encryption === "none" ? "available" : "encrypted",
    };
    if (payloadOffset === null) return;
    if (initial.size - payloadOffset > ANDROID_BACKUP_MAX_BYTES)
      throw artifactFixedLimitFailure(
        "Android backup encoded payload",
        ANDROID_BACKUP_MAX_BYTES,
        "bytes",
      );
    const encoded = await readArtifactFileBytes(
      handle,
      payloadOffset,
      initial.size - payloadOffset,
      initial.size,
      signal,
    );
    const tar = header.compressed ? await inflatePayload(encoded) : encoded;
    this.#assertOpen(signal);
    const registry = new ArtifactPathRegistry({
      maxParts: ANDROID_BACKUP_DIRECTORY_BYTES / 512,
      maxNodes: ANDROID_BACKUP_DIRECTORY_BYTES / 512,
    });
    const names = new Set<string>();
    let directoryBytes = 0;
    let index = 0;
    for (const decoded of androidBackupTarEntries(tar)) {
      if (index % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      if (!decoded.ok) throw decodeFailure(decoded.error);
      const member = decoded.value;
      // Charge worst-case JSON escaping and per-entry bookkeeping before retention.
      directoryBytes +=
        512 + 6 * (member.path.length + JSON.stringify(member.pax).length);
      if (directoryBytes > ANDROID_BACKUP_DIRECTORY_BYTES)
        throw artifactFixedLimitFailure(
          "Android backup directory representation",
          ANDROID_BACKUP_DIRECTORY_BYTES,
          "bytes",
        );
      const path = normalizeArtifactPath(member.path);
      if (names.has(path))
        throw new ArtifactReaderFailure(
          "path",
          `Duplicate Android backup member: ${path}`,
        );
      names.add(path);
      registry.add(path, member.kind);
      const adapterKey = `android-backup:${String(index++)}`;
      this.#members.set(adapterKey, {
        bytes: tar.subarray(member.dataOffset, member.dataOffset + member.size),
        entry: {
          path,
          sourcePath: member.path,
          kind: member.kind,
          declaredSize: member.size,
          compressedSize: null,
          executable: (member.mode & 0o111) !== 0,
          encrypted: false,
          byteOffset: header.compressed
            ? null
            : payloadOffset + member.dataOffset,
          declaredIntegrity: null,
          unpacked: false,
          limitations: [],
          adapterKey,
          formatMetadata: {
            kind: "android-backup-entry",
            tar_header_offset: member.headerOffset,
            tar_data_offset: member.dataOffset,
            mode: member.mode,
            pax: { ...member.pax },
          },
        },
      });
    }
    await this.#source.read(signal);
  }
}
