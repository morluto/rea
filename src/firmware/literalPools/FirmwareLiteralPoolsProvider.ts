import { setImmediate as immediate } from "node:timers/promises";
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
  closeArtifactResources,
  projectStableArtifactFailure,
  readStableArtifact,
  type StableArtifactSnapshot,
} from "../../resources/index.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { FirmwareLiteralPoolsPort } from "../../ports/binaryDiagnostics/FirmwareLiteralPoolsPort.js";
import {
  firmwareLiteralPoolBudgetLimit,
  type InspectFirmwareLiteralPoolsInput,
} from "../../domain/firmware/firmwareLiteralPools.js";
import {
  EMPTY_SVD_PERIPHERAL_PROFILE,
  parseSvdPeripheralSpansSteps,
} from "../../domain/firmware/firmwareLiteralPoolRegions.js";
import { scanFirmwareLiteralPoolsSteps } from "../../domain/firmware/firmwareLiteralPoolScanner.js";
import { FIRMWARE_LITERAL_POOLS_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok } from "../../domain/result.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";

const OPERATION = "inspect_firmware_literal_pools";

const drainCooperativeSteps = async <T>(
  steps: Generator<"step", T, void>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  let step = steps.next();
  while (!step.done) {
    assertArtifactReadActive(signal);
    await immediate();
    assertArtifactReadActive(signal);
    step = steps.next();
  }
  return step.value;
};

/** Portable ARM Thumb/Thumb-2/A32 and Xtensa L32R literal-pool decoder over one regular file. */
export class FirmwareLiteralPoolsProvider implements FirmwareLiteralPoolsPort {
  readonly identity = FIRMWARE_LITERAL_POOLS_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      FIRMWARE_LITERAL_POOLS_PROVIDER,
      OPERATION,
    );
  }

  async inspect(
    input: InspectFirmwareLiteralPoolsInput,
    options?: ExecutionOptions,
  ) {
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        assertArtifactReadActive(options?.signal);
        const svdResult =
          input.svd_xml === undefined
            ? ok(EMPTY_SVD_PERIPHERAL_PROFILE)
            : await drainCooperativeSteps(
                parseSvdPeripheralSpansSteps(
                  input.svd_xml,
                  input.max_svd_nodes,
                ),
                options?.signal,
              );
        if (!svdResult.ok) {
          if (isParseLimit(svdResult.error, "cmsis-svd")) {
            throw svdResult.error;
          }
          throw new AnalysisInputError(OPERATION, { cause: svdResult.error }, [
            {
              path: ["svd_xml"],
              reason: "invalid_format",
              message: svdResult.error.message,
            },
          ]);
        }

        snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        assertArtifactReadActive(options?.signal);

        const parsed = await drainCooperativeSteps(
          scanFirmwareLiteralPoolsSteps({
            artifact: {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            fileBytes: snapshot.bytes,
            isa: input.isa,
            baseAddressHex: input.base_address,
            scanOffset: input.scan_offset,
            maxScanBytes: input.max_scan_bytes,
            maxReferences: input.max_references,
            maxRepresentationBytes: input.max_representation_bytes,
            svdSupplied: input.svd_xml !== undefined,
            svdProfile: svdResult.value,
          }),
          options?.signal,
        );
        if (!parsed.ok) {
          if ("kind" in parsed.error && parsed.error.kind === "input") {
            throw new AnalysisInputError(
              OPERATION,
              undefined,
              parsed.error.issues,
            );
          }
          throw parsed.error;
        }
        return ok(parsed.value);
      });
    } catch (cause) {
      return err(literalPoolsFailure(cause, input, snapshot));
    }
  }
}

const withRequiredBudgetValue = (
  parameter:
    | "max_svd_nodes"
    | "max_references"
    | "max_representation_bytes"
    | "max_file_bytes",
  effectiveValue: number,
  required: number | bigint | undefined,
) => ({
  ...firmwareLiteralPoolBudgetLimit(parameter, effectiveValue),
  ...(typeof required === "number" ? { required_value: required } : {}),
});

const literalPoolsFailure = (
  cause: unknown,
  input: InspectFirmwareLiteralPoolsInput,
  snapshot: StableArtifactSnapshot | undefined,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: FIRMWARE_LITERAL_POOLS_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "firmware literal pools",
      fallbackMessage: "Firmware literal-pool inspection failed.",
      recognise: (failure) => {
        if (isParseLimit(failure, "cmsis-svd")) {
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            retryable: false,
            limit: withRequiredBudgetValue(
              "max_svd_nodes",
              input.max_svd_nodes,
              failure.failure.limit.required,
            ),
          });
        }
        if (
          isParseLimit(failure, "firmware-literal-pools") &&
          failure.failure.limit.name === "max_references"
        ) {
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            retryable: false,
            limit: withRequiredBudgetValue(
              "max_references",
              input.max_references,
              failure.failure.limit.required,
            ),
          });
        }
        if (
          isParseLimit(failure, "firmware-literal-pools") &&
          failure.failure.limit.name === "max_representation_bytes"
        ) {
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            retryable: false,
            limit: withRequiredBudgetValue(
              "max_representation_bytes",
              input.max_representation_bytes,
              failure.failure.limit.required,
            ),
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
            "firmware-literal-pools",
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
            limit: withRequiredBudgetValue(
              "max_file_bytes",
              input.max_file_bytes,
              requiredBytes,
            ),
          },
        );
      },
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    FIRMWARE_LITERAL_POOLS_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
