import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  readStableArtifact,
  type StableArtifactSnapshot,
} from "../../resources/index.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { EspNvsPort } from "../../ports/binaryDiagnostics/EspNvsPort.js";
import {
  ESP_NVS_PAGE_BYTES,
  MAX_ESP_NVS_FILE_BYTES,
  espNvsBudgetLimit,
  type EspNvsProviderInput,
} from "../../domain/firmware/espNvs.js";
import { parseEspNvsPartition } from "../../domain/firmware/espNvsParser.js";
import { ESP_NVS_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok } from "../../domain/result.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";

const OPERATION = "inspect_esp_nvs";

const invalidRange = (field: string, message: string): AnalysisInputError =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: [field], reason: "invalid_value", message },
  ]);

/** Portable ESP-IDF Non-Volatile Storage (NVS v1/v2) partition decoder. */
export class EspNvsProvider implements EspNvsPort {
  readonly identity = ESP_NVS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(cause, ESP_NVS_PROVIDER.id, OPERATION);
    }
  }

  async inspect(input: EspNvsProviderInput, options?: ExecutionOptions) {
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);

        const fileBytes = snapshot.bytes.length;
        if (input.partition_offset > fileBytes) {
          throw invalidRange(
            "partition_offset",
            `Selected partition_offset (${String(input.partition_offset)}) starts beyond the end of the ${String(fileBytes)}-byte file.`,
          );
        }
        if (
          input.partition_offset > 0 &&
          fileBytes - input.partition_offset < ESP_NVS_PAGE_BYTES
        ) {
          throw invalidRange(
            "partition_offset",
            `Selected partition_offset (${String(input.partition_offset)}) leaves fewer than ${String(ESP_NVS_PAGE_BYTES)} bytes (one NVS page) in the ${String(fileBytes)}-byte file.`,
          );
        }
        if (
          input.partition_bytes !== undefined &&
          input.partition_offset + input.partition_bytes > fileBytes
        ) {
          const availableBytes = fileBytes - input.partition_offset;
          throw invalidRange(
            "partition_bytes",
            `Requested NVS slice [${String(input.partition_offset)}, ${String(input.partition_offset + input.partition_bytes)}) (${String(input.partition_bytes)} bytes) extends beyond the ${String(fileBytes)}-byte file (${String(availableBytes)} byte(s) available from partition_offset); omit partition_bytes to decode complete pages through EOF or reduce partition_bytes.`,
          );
        }

        const sliceEnd =
          input.partition_bytes === undefined
            ? fileBytes
            : input.partition_offset + input.partition_bytes;
        const slice = snapshot.bytes.subarray(input.partition_offset, sliceEnd);

        const parsed = await parseEspNvsPartition({
          artifact: {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: fileBytes,
          },
          partitionOffset: input.partition_offset,
          partitionBytes: input.partition_bytes,
          sliceBytes: slice,
          maxDecodedBytes: input.max_decoded_bytes,
          onCheckpoint: () => assertArtifactReadActive(options?.signal),
        });
        if (!parsed.ok) throw parsed.error;
        assertArtifactReadActive(options?.signal);
        return ok(parsed.value);
      });
    } catch (cause) {
      return err(espNvsFailure(cause, input, snapshot));
    }
  }
}

const fileSizeRemediation = (input: EspNvsProviderInput): string =>
  input.max_file_bytes >= MAX_ESP_NVS_FILE_BYTES
    ? `The image exceeds the ${String(MAX_ESP_NVS_FILE_BYTES)}-byte input ceiling this operation accepts; carve the NVS partition first.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes within its ${String(MAX_ESP_NVS_FILE_BYTES)}-byte ceiling, or carve the NVS partition first.`;

const espNvsFailure = (
  cause: unknown,
  input: EspNvsProviderInput,
  snapshot: StableArtifactSnapshot | undefined,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: ESP_NVS_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "ESP-IDF NVS partition",
      fallbackMessage: "ESP-IDF NVS partition inspection failed.",
      recognise: (failure) =>
        isParseLimit(failure, "esp-nvs") &&
        failure.failure.limit.name === "max_decoded_bytes"
          ? parseLimitConstraint(OPERATION, "memory", failure, {
              retryable: false,
              limit: espNvsBudgetLimit(
                "max_decoded_bytes",
                failure.failure.limit.maximum,
              ),
              related: {
                parameters: ["partition_offset", "partition_bytes"],
              },
            })
          : undefined,
      fileSize: (failure) =>
        parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            "esp-nvs",
            failure.message,
            { name: "max_file_bytes", maximum: input.max_file_bytes },
            { cause: failure },
          ),
          {
            retryable: false,
            limit: espNvsBudgetLimit("max_file_bytes", input.max_file_bytes),
            remediationAction: fileSizeRemediation(input),
          },
        ),
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    ESP_NVS_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
