import { decodeLimit } from "../../domain/parseFailure.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  closeArtifactResources,
  projectStableArtifactFailure,
  readAdmittedRange,
  withStableArtifactHandle,
  type StableArtifactFileSystem,
} from "../../resources/index.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { FirmwareVectorTablePort } from "../../ports/binaryDiagnostics/FirmwareVectorTablePort.js";
import {
  FIRMWARE_VECTOR_TABLE_BUDGETS,
  MAX_VECTOR_TABLE_FILE_BYTES,
  firmwareVectorBudgetLimit,
  type FirmwareVectorTable,
  type InspectFirmwareVectorTableInput,
} from "../../domain/firmware/firmwareVectorTable.js";
import { parseSvdInterruptMap } from "../../domain/firmware/firmwareSvdInterrupts.js";
import { parseFirmwareVectorTable } from "../../domain/firmware/firmwareVectorTableParser.js";
import { FIRMWARE_VECTOR_TABLE_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok } from "../../domain/result.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";

const OPERATION = "inspect_firmware_vector_table";
const FORMAT = "firmware-vector-table";

/** Portable ARM M-profile and RISC-V vector/trap table decoder over one regular file. */
export class FirmwareVectorTableProvider implements FirmwareVectorTablePort {
  readonly identity = FIRMWARE_VECTOR_TABLE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();
  readonly #fileSystem: StableArtifactFileSystem | undefined;

  constructor(options?: { readonly fileSystem?: StableArtifactFileSystem }) {
    this.#fileSystem = options?.fileSystem;
  }

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      FIRMWARE_VECTOR_TABLE_PROVIDER,
      OPERATION,
    );
  }

  async inspect(
    input: InspectFirmwareVectorTableInput,
    options?: ExecutionOptions,
  ) {
    let completed: FirmwareVectorTable | undefined;
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    const maxSliceBytes = input.max_entries * 4 + 4;
    try {
      return await this.#resources.run(async () => {
        assertArtifactReadActive(options?.signal);
        const svdResult =
          input.svd_xml === undefined
            ? ok(new Map())
            : parseSvdInterruptMap(input.svd_xml, {
                maxXmlNodes: input.max_svd_xml_nodes,
                maxExpandedChars: input.max_svd_expanded_chars,
              });
        if (!svdResult.ok) throw svdResult.error;

        const report = await withStableArtifactHandle<FirmwareVectorTable>(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            ...(this.#fileSystem === undefined
              ? {}
              : { fileSystem: this.#fileSystem }),
            resourceScope: this.#resources,
            retainBytes: (size) =>
              input.vector_table_offset === 0
                ? Math.min(size, maxSliceBytes)
                : 0,
            onIdentity: (identity) => {
              observed = identity;
            },
            onVerifiedResult: (value) => {
              completed = value;
            },
          },
          async (handle) => {
            assertArtifactReadActive(options?.signal);
            let tableSlice: Buffer;
            if (input.vector_table_offset >= handle.size) {
              tableSlice = Buffer.alloc(0);
            } else if (input.vector_table_offset === 0) {
              tableSlice = handle.prefix;
            } else {
              const sliceLength = Math.min(
                handle.size - input.vector_table_offset,
                maxSliceBytes,
              );
              tableSlice = await readAdmittedRange(
                FORMAT,
                handle,
                input.vector_table_offset,
                sliceLength,
              );
            }
            assertArtifactReadActive(options?.signal);
            const parsed = parseFirmwareVectorTable({
              artifact: {
                path: input.path,
                sha256: handle.sha256,
                bytes: handle.size,
              },
              architecture: input.architecture,
              baseAddressHex: input.base_address,
              vectorTableOffset: input.vector_table_offset,
              maxEntries: input.max_entries,
              tableBytes: tableSlice,
              svdSupplied: input.svd_xml !== undefined,
              svdMap: svdResult.value,
              maxSvdExpandedChars: input.max_svd_expanded_chars,
            });
            if (!parsed.ok) throw parsed.error;
            return parsed.value;
          },
        );
        return ok(report);
      });
    } catch (cause) {
      return err(vectorTableFailure(cause, input, observed, completed));
    }
  }
}

const fileSizeRemediation = (input: InspectFirmwareVectorTableInput): string =>
  input.max_file_bytes >= MAX_VECTOR_TABLE_FILE_BYTES
    ? `The image exceeds the ${String(MAX_VECTOR_TABLE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller firmware slice.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes within its ${String(MAX_VECTOR_TABLE_FILE_BYTES)}-byte ceiling, or select a smaller firmware slice.`;

const svdBudgetRemediation = (
  parameter: "max_svd_xml_nodes" | "max_svd_expanded_chars",
  effectiveValue: number,
  required: number | bigint | undefined,
): string => {
  const ceiling = FIRMWARE_VECTOR_TABLE_BUDGETS[parameter].maximum;
  if (
    effectiveValue < ceiling &&
    (required === undefined || required <= BigInt(ceiling))
  ) {
    return `Pass a larger ${parameter}${required === undefined ? "" : ` (at least ${String(required)})`} within its ${String(ceiling)} ceiling, or provide a trimmed CMSIS-SVD document.`;
  }
  return `${parameter} cannot exceed ${String(ceiling)}; provide a trimmed CMSIS-SVD document with only the relevant peripheral interrupt declarations.`;
};

const vectorTableFailure = (
  cause: unknown,
  input: InspectFirmwareVectorTableInput,
  observed?: { readonly sha256: string; readonly bytes: number },
  completed?: FirmwareVectorTable,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: FIRMWARE_VECTOR_TABLE_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "firmware vector table",
      fallbackMessage: "Firmware vector table inspection failed.",
      recognise: (failure) => {
        if (isParseLimit(failure, "cmsis-svd")) {
          const { name, maximum, required } = failure.failure.limit;
          if (name === "max_svd_expanded_chars") {
            return parseLimitConstraint(OPERATION, "memory", failure, {
              retryable: false,
              limit: firmwareVectorBudgetLimit(
                "max_svd_expanded_chars",
                maximum,
              ),
              remediationAction: svdBudgetRemediation(
                "max_svd_expanded_chars",
                maximum,
                required,
              ),
            });
          }
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            retryable: false,
            limit: firmwareVectorBudgetLimit("max_svd_xml_nodes", maximum),
            remediationAction: svdBudgetRemediation(
              "max_svd_xml_nodes",
              maximum,
              required,
            ),
          });
        }
        return undefined;
      },
      fileSize: (failure) =>
        parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            FORMAT,
            failure.message,
            { name: "max_file_bytes", maximum: input.max_file_bytes },
            { cause: failure },
          ),
          {
            retryable: false,
            limit: firmwareVectorBudgetLimit(
              "max_file_bytes",
              input.max_file_bytes,
            ),
            remediationAction: fileSizeRemediation(input),
          },
        ),
    }),
  );
  if (completed !== undefined) primary.retainPartialObservation(completed);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    FIRMWARE_VECTOR_TABLE_PROVIDER.id,
    OPERATION,
    observed,
  );
};
