import type { Readable } from "node:stream";
import { inflate } from "node:zlib";
import { setImmediate } from "node:timers/promises";

import {
  androidBackupTarEntries,
  parseAndroidBackupHeader,
  type AndroidBackupDecodeFailure,
} from "../domain/androidBackup.js";
import {
  DEFAULT_ANDROID_BACKUP_READER_LIMITS,
  type AndroidBackupReaderLimits,
} from "../domain/artifactReaderLimits.js";
import type { AndroidBackupMetadata } from "../domain/formatMetadata/androidAndSystemMetadata.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import {
  ArtifactFileSource,
  ArtifactPathRegistry,
  ArtifactReaderFailure,
  ArtifactResourceScope,
  artifactReaderLimitFailure,
  assertArtifactReadActive,
  assertProducedEntry,
  copyArtifactEntry,
  malformedArtifact,
  normalizeArtifactPath,
  truncatedArtifact,
  unsupportedArtifact,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
} from "../resources/index.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { ownAsyncArtifactStream } from "./OwnedAsyncArtifactStream.js";

const MAX_MEMBER_STREAMS = 4;
const CHUNK_BYTES = 64 * 1024;
const FORMAT = "android-backup";
const LABEL = "Android backup";
type BackupMember = { readonly entry: ArtifactEntry; readonly bytes: Buffer };

const backupLimitFailure = (
  limits: AndroidBackupReaderLimits,
  field: keyof AndroidBackupReaderLimits,
  required?: number,
): ArtifactReaderFailure =>
  artifactReaderLimitFailure(
    `artifact_limits.android_backup.${field}`,
    limits[field],
    "bytes",
    required,
    "memory",
  );

const decodeFailure = (
  failure: AndroidBackupDecodeFailure,
  limits: AndroidBackupReaderLimits,
): ArtifactReaderFailure => {
  if (failure.kind === "limit")
    return backupLimitFailure(limits, "directory_bytes", failure.requiredBytes);
  const detail = `${LABEL}: ${failure.message}`;
  switch (failure.kind) {
    case "malformed":
      return malformedArtifact(FORMAT, detail);
    case "truncated":
      return truncatedArtifact(FORMAT, detail);
    case "unsupported":
      return unsupportedArtifact(FORMAT, detail, { undecodedContent: true });
  }
};

const inflatePayload = (
  payload: Buffer,
  limits: AndroidBackupReaderLimits,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    inflate(
      payload,
      { maxOutputLength: limits.expanded_bytes, info: true },
      (cause, result) => {
        if (cause !== null) {
          const code = "code" in cause ? cause.code : undefined;
          reject(
            code === "ERR_BUFFER_TOO_LARGE"
              ? backupLimitFailure(limits, "expanded_bytes")
              : code === "Z_BUF_ERROR"
                ? truncatedArtifact(
                    FORMAT,
                    "Android backup zlib payload is truncated",
                    { cause },
                  )
                : malformedArtifact(
                    FORMAT,
                    "Android backup has an invalid zlib payload",
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
            malformedArtifact(
              FORMAT,
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
  readonly format = FORMAT;
  readonly #scope = new ArtifactResourceScope();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  readonly #streams = new Map<Readable, AbortController>();
  #prepared:
    | {
        readonly metadata: AndroidBackupMetadata;
        readonly members: ReadonlyMap<string, BackupMember>;
      }
    | undefined;
  #closing = false;

  constructor(
    path: string,
    admitted?: StableRegularFileDescriptor,
    private readonly limits: AndroidBackupReaderLimits = DEFAULT_ANDROID_BACKUP_READER_LIMITS,
  ) {
    this.#source = new ArtifactFileSource(path, LABEL, admitted);
  }

  formatMetadata(): AndroidBackupMetadata | undefined {
    const metadata = this.#prepared?.metadata;
    return metadata === undefined ? undefined : { ...metadata };
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
      await this.#preparation.run(
        signal,
        () => this.#prepare(signal),
        () => this.#assertOpen(signal),
      );
      await this.#source.read(signal);
    });
    this.#assertOpen(signal);
    const { metadata, members } = this.#prepared!;
    if (metadata.directory_status === "encrypted") {
      options?.onCoverage?.({
        status: "unknown",
        limitations: [
          `Android backup encryption method ${JSON.stringify(metadata.encryption)} is unsupported; member identities and contents remain unknown. No decryption was attempted.`,
        ],
      });
      this.#assertOpen(signal);
      return;
    }
    let index = 0;
    for (const { entry } of members.values()) {
      if (index++ % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
    options?.onCoverage?.({ status: "complete", limitations: [] });
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const member = this.#prepared?.members.get(entry.adapterKey);
      const produced = member?.entry;
      assertProducedEntry(
        entry,
        produced,
        "Android backup entry does not match its owning inventory",
      );
      await this.#source.read(signal);
      this.#assertOpen(signal);
      if (produced.kind !== "file")
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
      const controller = new AbortController();
      return ownAsyncArtifactStream(
        this.#chunks(member!.bytes, controller.signal),
        controller,
        {
          scope: this.#scope,
          streams: this.#streams,
          signal,
          label: LABEL,
          highWaterMark: CHUNK_BYTES,
        },
      );
    });
  }

  async *#chunks(bytes: Buffer, signal?: AbortSignal): AsyncIterable<Buffer> {
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      await setImmediate();
      this.#assertOpen(signal);
      yield Buffer.from(bytes.subarray(offset, offset + CHUNK_BYTES));
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const [stream, controller] of this.#streams) {
      const cause = new ArtifactReaderFailure(
        "unavailable",
        "Android backup reader closed",
      );
      controller.abort(cause);
      stream.destroy(cause);
    }
    await this.#scope.close();
    await this.#source.close();
    this.#prepared = undefined;
    this.#preparation.clear();
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
      FORMAT,
      handle,
      0,
      Math.min(initial.size, 1024),
      initial.size,
      signal,
    );
    const parsed = parseAndroidBackupHeader(prefix);
    if (!parsed.ok) throw decodeFailure(parsed.error, this.limits);
    const header = parsed.value;
    const payloadOffset = header.payloadOffset;
    if (header.encryption !== "none" && header.encryption !== "AES-256")
      throw unsupportedArtifact(
        FORMAT,
        `Unsupported Android backup encryption method: ${header.encryption}`,
        { undecodedContent: true },
      );
    const metadata: AndroidBackupMetadata = {
      kind: "android-backup",
      format_version: header.version,
      compressed: header.compressed,
      encryption: header.encryption,
      payload_offset: payloadOffset,
      directory_status:
        header.encryption === "none" ? "available" : "encrypted",
    };
    const members = new Map<string, BackupMember>();
    if (payloadOffset === null) {
      this.#assertOpen(signal);
      this.#prepared = { metadata, members };
      return;
    }
    const encodedBytes = initial.size - payloadOffset;
    if (encodedBytes > this.limits.encoded_bytes)
      throw backupLimitFailure(this.limits, "encoded_bytes", encodedBytes);
    if (!header.compressed && encodedBytes > this.limits.expanded_bytes)
      throw backupLimitFailure(this.limits, "expanded_bytes", encodedBytes);
    const encoded = await readArtifactFileBytes(
      FORMAT,
      handle,
      payloadOffset,
      encodedBytes,
      initial.size,
      signal,
    );
    const tar = header.compressed
      ? await inflatePayload(encoded, this.limits)
      : encoded;
    this.#assertOpen(signal);
    const directoryLimit = this.limits.directory_bytes;
    const pathLimit = Math.floor(directoryLimit / 512);
    const registry = new ArtifactPathRegistry({
      maxParts: pathLimit,
      maxNodes: pathLimit,
      limitFailure: (_resource, _effective, required) =>
        backupLimitFailure(this.limits, "directory_bytes", required * 512),
    });
    const names = new Set<string>();
    let directoryBytes = 0;
    let index = 0;
    for (const decoded of androidBackupTarEntries(tar, directoryLimit)) {
      if (index % 256 === 0) await setImmediate();
      this.#assertOpen(signal);
      if (!decoded.ok) throw decodeFailure(decoded.error, this.limits);
      const member = decoded.value;
      // Charge worst-case JSON escaping and per-entry bookkeeping before retention.
      directoryBytes +=
        512 + 6 * (member.path.length + JSON.stringify(member.pax).length);
      if (directoryBytes > directoryLimit)
        throw backupLimitFailure(
          this.limits,
          "directory_bytes",
          directoryBytes,
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
      members.set(adapterKey, {
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
    this.#assertOpen(signal);
    this.#prepared = { metadata, members };
  }
}
