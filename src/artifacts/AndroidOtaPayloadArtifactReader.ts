import { ArtifactPreparation } from "./ArtifactPreparation.js";
import { Readable, Transform } from "node:stream";
import { setImmediate } from "node:timers/promises";

import type {
  AndroidOtaPartitionMetadata,
  AndroidOtaPayloadMetadata,
} from "../domain/artifactFormatMetadata.js";
import { readArtifactFileBytes } from "./ArtifactFileRange.js";
import {
  assertArtifactReadActive,
  ArtifactEntryContentUnavailable,
  ArtifactReaderFailure,
  copyArtifactEntry,
  assertProducedEntry,
  type ArtifactEntry,
  type ArtifactReader,
  type ArtifactTraversalOptions,
  ArtifactResourceScope,
  ArtifactFileSource,
} from "../resources/index.js";
import { ownArtifactStream } from "./OwnedArtifactStream.js";
import type { StableRegularFileDescriptor } from "../filesystem/RegularFile.js";
import { ZstandardFrameAllowanceError } from "../domain/compression/zstandardFrameAllowance.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  ANDROID_OTA_HEADER_V2_BYTES,
  androidOtaDistinctOperationDataBytes,
  androidOtaExtractRefusalError,
  androidOtaExtractRefusalLimitation,
  parseAndroidOtaHeader,
  parseAndroidOtaPayload,
  reconstructAndroidOtaPartition,
  type AndroidOtaPartition,
  type AndroidOtaPayload,
  type AndroidOtaPayloadParseError,
  type AndroidOtaPayloadReconstructError,
} from "../domain/firmware/androidOtaPayload.js";

const LABEL = "Android OTA payload";

type AndroidOtaEntry = ArtifactEntry & {
  readonly partition: AndroidOtaPartition;
  readonly formatMetadata: AndroidOtaPartitionMetadata;
};

/** Inventory a CrAU v2 payload without applying delta operations or verifying signatures. */
export class AndroidOtaPayloadArtifactReader implements ArtifactReader {
  readonly format = "android-ota-payload" as const;
  readonly #scope = new ArtifactResourceScope();
  readonly #entries = new Map<string, AndroidOtaEntry>();
  readonly #streams = new Set<Readable>();
  readonly #source: ArtifactFileSource;
  readonly #preparation = new ArtifactPreparation();
  #payload: AndroidOtaPayload | undefined;
  #closing = false;

  constructor(path: string, admitted?: StableRegularFileDescriptor) {
    this.#source = new ArtifactFileSource(path, LABEL, admitted);
  }

  formatMetadata(): AndroidOtaPayloadMetadata | undefined {
    return this.#payload === undefined ? undefined : toMetadata(this.#payload);
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
    options?.onCoverage?.({
      status: "complete",
      limitations: this.#payload?.limitations ?? [],
    });
    let index = 0;
    for (const entry of this.#entries.values()) {
      if (index % 256 === 0) await setImmediate();
      index += 1;
      this.#assertOpen(signal);
      yield copyArtifactEntry(entry);
    }
    this.#assertOpen(signal);
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    return this.#scope.run(async () => {
      this.#assertOpen(signal);
      const stored = this.#entries.get(entry.adapterKey);
      assertProducedEntry(
        entry,
        stored,
        "Android OTA partition does not match its owning inventory",
      );
      const { handle, initial } = await this.#source.read(signal);
      this.#assertOpen(signal);
      const refused = androidOtaExtractRefusalError(stored.partition);
      if (refused !== null && stored.partition.extractRefusal !== null)
        throw refusedContent(stored.partition.extractRefusal, refused);
      const payload = this.#payload;
      if (payload === undefined)
        throw new ArtifactReaderFailure(
          "unavailable",
          "Android OTA payload reader has no prepared inventory",
        );
      const operationData = androidOtaDistinctOperationDataBytes(
        stored.partition.operations,
      );
      if (!operationData.ok) throw reconstructFailure(operationData.error);
      const blob = new Map<string, Uint8Array>();
      for (const operation of stored.partition.operations) {
        if (operation.dataLength === 0) continue;
        const key = `${String(operation.dataOffset)}:${String(operation.dataLength)}`;
        if (blob.has(key)) continue;
        blob.set(
          key,
          await readArtifactFileBytes(
            handle,
            payload.header.blobOffset + operation.dataOffset,
            operation.dataLength,
            initial.size,
            signal,
          ),
        );
        this.#assertOpen(signal);
      }
      await this.#source.read(signal);
      this.#assertOpen(signal);
      const reconstructed = reconstructAndroidOtaPartition(
        stored.partition,
        payload.blockSize,
        (offset, length) =>
          blob.get(`${String(offset)}:${String(length)}`) ?? new Uint8Array(),
        // A SHA-256 claim on the entry is checked by the shared scanner under
        // the caller's integrity policy, so record-and-continue can keep the
        // observed bytes. Without that claim the reader checks it here.
        { verifyDeclaredHash: stored.declaredIntegrity === null },
      );
      if (!reconstructed.ok) throw reconstructFailure(reconstructed.error);
      const cancellationFailure = (reason: unknown): ArtifactReaderFailure =>
        new ArtifactReaderFailure("cancelled", `${LABEL} read cancelled`, {
          cause: reason,
        });
      const image = Buffer.from(reconstructed.value);
      const source =
        image.length === 0 ? Readable.from([]) : Readable.from([image]);
      const output = this.#memberStream(stored, image.length, signal);
      ownArtifactStream(source, output, {
        scope: this.#scope,
        streams: this.#streams,
        signal,
        cancellationFailure,
        label: LABEL,
      });
      return output;
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const stream of this.#streams)
      stream.destroy(
        new ArtifactReaderFailure("unavailable", `${LABEL} reader closed`),
      );
    await this.#scope.close();
    await this.#source.close();
    this.#entries.clear();
    this.#payload = undefined;
  }

  provenance(): readonly [] {
    return [];
  }

  #assertOpen(signal?: AbortSignal): void {
    assertArtifactReadActive(signal);
    if (this.#closing)
      throw new ArtifactReaderFailure("unavailable", `${LABEL} reader closed`);
  }

  async #prepare(signal?: AbortSignal): Promise<void> {
    const { handle, initial } = await this.#source.read(signal);
    const headerBytes = await readArtifactFileBytes(
      handle,
      0,
      Math.min(initial.size, ANDROID_OTA_HEADER_V2_BYTES),
      initial.size,
      signal,
    );
    const header = parseAndroidOtaHeader(headerBytes, initial.size);
    if (!header.ok) throw parseFailure(header.error);
    const prefixEnd = Math.min(initial.size, header.value.blobOffset);
    const prefix = await readArtifactFileBytes(
      handle,
      0,
      prefixEnd,
      initial.size,
      signal,
    );
    const first = parseAndroidOtaPayload(prefix, initial.size);
    if (!first.ok) throw parseFailure(first.error);
    const signatureRange = first.value.payloadSignatureRange;
    const payloadSignature =
      signatureRange === null
        ? undefined
        : await readArtifactFileBytes(
            handle,
            signatureRange.offset,
            signatureRange.bytes,
            initial.size,
            signal,
          );
    await this.#source.read(signal);
    this.#assertOpen(signal);
    const parsed =
      payloadSignature === undefined
        ? first
        : parseAndroidOtaPayload(prefix, initial.size, payloadSignature);
    if (!parsed.ok) throw parseFailure(parsed.error);
    this.#payload = parsed.value;
    this.#entries.clear();
    for (const partition of parsed.value.partitions) {
      const entry = entryFor(partition);
      this.#entries.set(entry.adapterKey, entry);
    }
  }

  #memberStream(
    entry: AndroidOtaEntry,
    expectedSize: number,
    signal?: AbortSignal,
  ): Transform {
    let bytes = 0;
    const check = async (): Promise<void> => {
      if (bytes !== expectedSize)
        throw formatFailure(`member ended early: ${entry.path}`);
      await this.#source.read(signal);
    };
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
      flush(callback) {
        void check().then(
          () => callback(),
          (cause: unknown) =>
            callback(
              cause instanceof Error
                ? cause
                : new Error("Android OTA payload read failed", { cause }),
            ),
        );
      },
    });
  }
}

const formatFailure = (
  detail: string,
  options?: ErrorOptions,
): ArtifactReaderFailure =>
  new ArtifactReaderFailure(
    "format",
    `${LABEL} is malformed: ${detail}`,
    options,
  );

const parseFailure = (
  failure: AndroidOtaPayloadParseError,
): ArtifactReaderFailure => {
  switch (failure.kind) {
    case "limit":
      return new ArtifactReaderFailure("limit", failure.message, {
        boundary: "capacity",
        cause: failure,
      });
    case "unsupported":
      return new ArtifactReaderFailure("unavailable", failure.message, {
        cause: failure,
      });
    case "truncated":
      return new ArtifactReaderFailure("format", failure.message, {
        cause: failure,
      });
    case "malformed":
      return formatFailure(failure.message, { cause: failure });
  }
};

/**
 * The inventory already recorded why it will not rebuild this partition, so
 * every refusal stays per-member content that is unavailable. Inventory keeps
 * the partition table and the reason instead of failing the whole scan.
 */
const refusedContent = (
  refusal: NonNullable<AndroidOtaPartition["extractRefusal"]>,
  failure: AndroidOtaPayloadReconstructError,
): ArtifactEntryContentUnavailable => {
  const limitation = androidOtaExtractRefusalLimitation(refusal);
  return new ArtifactEntryContentUnavailable(failure.message, limitation, {
    traversal: { status: "unknown", limitations: [limitation] },
    cause: failure,
  });
};

const reconstructFailure = (
  failure: AndroidOtaPayloadReconstructError,
): ArtifactReaderFailure => {
  if (
    failure._tag === "AndroidOtaPayloadUnsupportedOperation" ||
    failure._tag === "AndroidOtaPayloadBlobTruncated"
  ) {
    const limitation = androidOtaExtractRefusalLimitation(
      failure._tag === "AndroidOtaPayloadBlobTruncated"
        ? "blob_truncated"
        : "unsupported_operations",
    );
    return new ArtifactEntryContentUnavailable(failure.message, limitation, {
      traversal: { status: "unknown", limitations: [limitation] },
      cause: failure,
    });
  }
  if (failure._tag === "AndroidOtaPayloadIntegrityFailure")
    return new ArtifactReaderFailure("integrity", failure.message, {
      cause: failure,
      integrityCheck: "declared-digest",
    });
  if (failure instanceof ConfigurationError) throw failure;
  if (failure._tag === "ZstandardFrameWorkRefusal")
    throw new ZstandardFrameAllowanceError(
      { maxFrames: failure.value, source: failure.source },
      failure.offset,
    );
  return parseFailure(failure);
};

const partitionInfo = (info: AndroidOtaPartition["newPartitionInfo"]) => ({
  size: info.size,
  hash_hex: info.hashHex,
});

const entryFor = (partition: AndroidOtaPartition): AndroidOtaEntry => {
  const hash = partition.newPartitionInfo.hashHex;
  const sha256 =
    hash !== null && /^[0-9a-f]{64}$/u.test(hash)
      ? ({ algorithm: "sha256", digest: hash } as const)
      : null;
  return {
    path: partition.path,
    kind: "file",
    declaredSize: partition.newPartitionInfo.size,
    compressedSize: partition.totalDataLength,
    executable: false,
    encrypted: false,
    byteOffset: null,
    declaredIntegrity: partition.extractable ? sha256 : null,
    unpacked: false,
    limitations:
      partition.extractRefusal === null
        ? []
        : [androidOtaExtractRefusalLimitation(partition.extractRefusal)],
    adapterKey: `android-ota-payload:partition:${String(partition.index)}`,
    formatMetadata: {
      kind: "android-ota-partition",
      index: partition.index,
      name: partition.name,
      extractable: partition.extractable,
      new_partition_info: partitionInfo(partition.newPartitionInfo),
      old_partition_info:
        partition.oldPartitionInfo === null
          ? null
          : partitionInfo(partition.oldPartitionInfo),
      version: partition.version,
      run_postinstall: partition.runPostinstall,
      postinstall_path: partition.postinstallPath,
      filesystem_type: partition.filesystemType,
      operation_counts: [...partition.operationCounts],
      total_data_length: partition.totalDataLength,
      merge_operation_count: partition.mergeOperationCount,
      estimate_cow_size: partition.estimateCowSize,
    },
    sourcePath: partition.path,
    partition,
  };
};

const toMetadata = (payload: AndroidOtaPayload): AndroidOtaPayloadMetadata => ({
  kind: "android-ota-payload",
  magic: payload.header.magic,
  major_version: payload.header.majorVersion,
  manifest_size: payload.header.manifestSize,
  metadata_signature_size: payload.header.metadataSignatureSize,
  manifest_offset: payload.header.manifestOffset,
  blob_offset: payload.header.blobOffset,
  block_size: payload.blockSize,
  minor_version: payload.minorVersion,
  payload_kind: payload.payloadKind,
  max_timestamp: payload.maxTimestamp,
  partial_update: payload.partialUpdate,
  security_patch_level: payload.securityPatchLevel,
  signatures_offset: payload.signaturesOffset,
  signatures_size: payload.signaturesSize,
  metadata_signature_blob_size: payload.metadataSignatureBlobSize,
  metadata_signature_count: payload.metadataSignatureCount,
  payload_signature_blob_size: payload.payloadSignatureBlobSize,
  payload_signature_count: payload.payloadSignatureCount,
  signatures_verified: false,
  snapshot_enabled: payload.snapshotEnabled,
  vabc_enabled: payload.vabcEnabled,
  vabc_compression_param: payload.vabcCompressionParam,
  blob_truncated: payload.blobTruncated,
  partitions: payload.partitions.map((partition) => ({
    index: partition.index,
    name: partition.name,
    path: partition.path,
    new_partition_info: partitionInfo(partition.newPartitionInfo),
    old_partition_info:
      partition.oldPartitionInfo === null
        ? null
        : partitionInfo(partition.oldPartitionInfo),
    version: partition.version,
    run_postinstall: partition.runPostinstall,
    postinstall_path: partition.postinstallPath,
    filesystem_type: partition.filesystemType,
    operation_counts: [...partition.operationCounts],
    total_data_length: partition.totalDataLength,
    merge_operation_count: partition.mergeOperationCount,
    estimate_cow_size: partition.estimateCowSize,
    extractable: partition.extractable,
  })),
  dynamic_partition_groups: payload.dynamicPartitionGroups.map((group) => ({
    name: group.name,
    size: group.size,
    partition_names: [...group.partitionNames],
  })),
  apex_info: payload.apexInfo.map((apex) => ({
    package_name: apex.packageName,
    version: apex.version,
    is_compressed: apex.isCompressed,
    decompressed_size: apex.decompressedSize,
  })),
});
