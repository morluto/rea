import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  decodeLimit,
  type ParseFailureError,
} from "../../domain/parseFailure.js";
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
  firmwareVectorBudgetLimit,
  type FirmwareVectorTable,
  type InspectFirmwareVectorTableInput,
} from "../../domain/firmware/firmwareVectorTable.js";
import { parseSvdInterruptMap } from "../../domain/firmware/firmwareSvdInterrupts.js";
import {
  minimumVectorTableBytes,
  parseFirmwareVectorTable,
} from "../../domain/firmware/firmwareVectorTableParser.js";
import { FIRMWARE_VECTOR_TABLE_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok } from "../../domain/result.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";

const OPERATION = "inspect_firmware_vector_table";
const FORMAT = "firmware-vector-table";

const svdXmlInputError = (
  cause: ParseFailureError<"malformed"> | ParseFailureError<"unsupported">,
): AnalysisInputError =>
  new AnalysisInputError(
    OPERATION,
    {
      cause,
      conformsToInputContract: true,
      userMessage: `Invalid svd_xml for ${OPERATION}: ${cause.failure.detail}`,
      remediationAction:
        "Pass well-formed CMSIS-SVD XML whose root element is <device> without DOCTYPE declarations in svd_xml, or omit svd_xml to decode vector slots without profile names, then retry.",
      related: { parameters: ["svd_xml"] },
    },
    [
      {
        path: ["svd_xml"],
        reason: "invalid_format",
        message: cause.failure.detail,
      },
    ],
  );

const addressOverflowInputError = (
  input: InspectFirmwareVectorTableInput,
  baseAddress: number,
): AnalysisInputError => {
  const maxOffset = Math.floor((0xffff_ffff - baseAddress) / 4) * 4;
  const message = `base_address (${input.base_address}) + vector_table_offset (${String(input.vector_table_offset)}) overflows the 32-bit address space.`;
  return new AnalysisInputError(
    OPERATION,
    {
      conformsToInputContract: true,
      userMessage: `Invalid address selection for ${OPERATION}: ${message}`,
      remediationAction:
        "Reduce base_address or vector_table_offset so base_address + vector_table_offset fits within 0x0..0xffffffff, then retry.",
      related: { parameters: ["base_address", "vector_table_offset"] },
    },
    [
      {
        path: ["vector_table_offset"],
        reason: "out_of_range",
        message,
        maximum: maxOffset,
        observed: {
          base_address: input.base_address,
          vector_table_offset: input.vector_table_offset,
        },
      },
    ],
  );
};

const vectorOffsetRangeError = (
  input: InspectFirmwareVectorTableInput,
  fileBytes: number,
  minimumBytes: number,
): AnalysisInputError => {
  const maxOffset =
    fileBytes >= minimumBytes
      ? Math.floor((fileBytes - minimumBytes) / 4) * 4
      : null;
  const message =
    input.vector_table_offset >= fileBytes
      ? `Selected vector_table_offset (${String(input.vector_table_offset)}) starts at or beyond the end of the ${String(fileBytes)}-byte file.`
      : `Selected vector_table_offset (${String(input.vector_table_offset)}) leaves ${String(fileBytes - input.vector_table_offset)} byte(s) in the ${String(fileBytes)}-byte file; ${input.architecture} requires at least ${String(minimumBytes)} bytes.`;
  return new AnalysisInputError(
    OPERATION,
    {
      conformsToInputContract: true,
      userMessage: `Invalid vector_table_offset for ${OPERATION}: ${message}`,
      remediationAction:
        maxOffset !== null
          ? `Pass a 4-byte aligned vector_table_offset between 0 and ${String(maxOffset)} for this ${String(fileBytes)}-byte file, then retry.`
          : `The ${String(fileBytes)}-byte file at ${input.path} is smaller than the ${String(minimumBytes)}-byte minimum ${input.architecture} vector table; select the complete firmware image or verify architecture.`,
      related: { parameters: ["vector_table_offset"] },
    },
    [
      {
        path: ["vector_table_offset"],
        reason: "out_of_range",
        message,
        ...(maxOffset === null ? {} : { maximum: maxOffset }),
        observed: {
          vector_table_offset: input.vector_table_offset,
          file_bytes: fileBytes,
          required_table_bytes: minimumBytes,
        },
      },
    ],
  );
};

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
    const minimumBytes = minimumVectorTableBytes(input.architecture);
    const baseAddress = Number.parseInt(input.base_address.slice(2), 16) >>> 0;
    try {
      return await this.#resources.run(async () => {
        assertArtifactReadActive(options?.signal);
        const svdResult =
          input.svd_xml === undefined
            ? ok({ byIrq: new Map(), skipped: [] })
            : parseSvdInterruptMap(input.svd_xml, {
                maxXmlNodes: input.max_svd_xml_nodes,
                maxExpandedChars: input.max_svd_expanded_chars,
              });
        if (!svdResult.ok) {
          if (isParseLimit(svdResult.error, "cmsis-svd")) throw svdResult.error;
          throw svdXmlInputError(svdResult.error);
        }
        if (baseAddress + input.vector_table_offset > 0xffff_ffff) {
          throw addressOverflowInputError(input, baseAddress);
        }

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
            if (
              input.vector_table_offset > 0 &&
              handle.size - input.vector_table_offset < minimumBytes
            ) {
              throw vectorOffsetRangeError(input, handle.size, minimumBytes);
            }
            let tableSlice: Buffer;
            if (input.vector_table_offset === 0) {
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
              svdMap: svdResult.value.byIrq,
              svdSkipped: svdResult.value.skipped,
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
          const { name, maximum } = failure.failure.limit;
          if (name === "max_svd_expanded_chars") {
            return parseLimitConstraint(OPERATION, "memory", failure, {
              retryable: false,
              limit: firmwareVectorBudgetLimit(
                "max_svd_expanded_chars",
                maximum,
              ),
            });
          }
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            retryable: false,
            limit: firmwareVectorBudgetLimit("max_svd_xml_nodes", maximum),
          });
        }
        return undefined;
      },
      fileSize: (failure) => {
        const requiredBytes =
          failure.observedBytes === undefined
            ? undefined
            : failure.observedBytes <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(failure.observedBytes)
              : failure.observedBytes;
        return parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            FORMAT,
            failure.message,
            {
              name: "max_file_bytes",
              maximum: input.max_file_bytes,
              ...(requiredBytes === undefined
                ? {}
                : { required: requiredBytes }),
            },
            { cause: failure },
          ),
          {
            retryable: false,
            limit: {
              ...firmwareVectorBudgetLimit(
                "max_file_bytes",
                input.max_file_bytes,
              ),
              ...(typeof requiredBytes === "number"
                ? { required_value: requiredBytes }
                : {}),
            },
          },
        );
      },
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
