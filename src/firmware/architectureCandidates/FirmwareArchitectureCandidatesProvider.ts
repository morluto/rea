import { decodeLimit } from "../../domain/parseFailure.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import {
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
  assertArtifactReadActive,
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  withStableArtifactHandle,
} from "../../resources/index.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import type { FirmwareArchitectureCandidatesPort } from "../../ports/binaryDiagnostics/FirmwareArchitectureCandidatesPort.js";
import {
  MAX_FIRMWARE_ARCH_FILE_BYTES,
  firmwareArchBudgetLimit,
  type FirmwareArchitectureCandidates,
  type InspectFirmwareArchitectureCandidatesInput,
} from "../../domain/firmware/firmwareArchitectureCandidates.js";
import { scanFirmwareArchitectureCandidates } from "../../domain/firmware/firmwareArchitectureScanner.js";
import { FIRMWARE_ARCHITECTURE_CANDIDATES_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok } from "../../domain/result.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";

const OPERATION = "inspect_firmware_architecture_candidates";

/** Portable CPU/endianness/base candidate scanner over one bounded, identity-checked regular file. */
export class FirmwareArchitectureCandidatesProvider implements FirmwareArchitectureCandidatesPort {
  readonly identity = FIRMWARE_ARCHITECTURE_CANDIDATES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        FIRMWARE_ARCHITECTURE_CANDIDATES_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectFirmwareArchitectureCandidatesInput,
    options?: ExecutionOptions,
  ) {
    let completed: FirmwareArchitectureCandidates | undefined;
    let identity:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report =
          await withStableArtifactHandle<FirmwareArchitectureCandidates>(
            input.path,
            input.max_file_bytes,
            {
              signal: options?.signal,
              resourceScope: this.#resources,
              retainBytes: (size) => Math.min(size, input.max_scan_bytes),
              onIdentity: (observed) => {
                identity = observed;
              },
              onVerifiedResult: (verified) => {
                completed = verified;
              },
            },
            async (handle) => {
              assertArtifactReadActive(options?.signal);
              const scanned = await scanFirmwareArchitectureCandidates({
                artifact: {
                  path: input.path,
                  sha256: handle.sha256,
                  bytes: handle.size,
                },
                prefixBytes: handle.prefix,
                checkActive: () => assertArtifactReadActive(options?.signal),
              });
              assertArtifactReadActive(options?.signal);
              return scanned;
            },
          );
        return ok(report);
      });
    } catch (cause) {
      return err(candidateScanFailure(cause, input, identity, completed));
    }
  }
}

const fileSizeRemediation = (
  input: InspectFirmwareArchitectureCandidatesInput,
): string =>
  input.max_file_bytes >= MAX_FIRMWARE_ARCH_FILE_BYTES
    ? `The image exceeds the ${String(MAX_FIRMWARE_ARCH_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact or slice.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes within its ${String(MAX_FIRMWARE_ARCH_FILE_BYTES)}-byte ceiling, or select a smaller artifact.`;

const candidateScanFailure = (
  cause: unknown,
  input: InspectFirmwareArchitectureCandidatesInput,
  identity: { readonly sha256: string; readonly bytes: number } | undefined,
  completed: FirmwareArchitectureCandidates | undefined,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: FIRMWARE_ARCHITECTURE_CANDIDATES_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "firmware blob",
      fallbackMessage: "Firmware architecture candidate inspection failed.",
      fileSize: (failure) =>
        parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            "firmware-architecture-candidates",
            failure.message,
            { name: "max_file_bytes", maximum: input.max_file_bytes },
            { cause: failure },
          ),
          {
            retryable: false,
            limit: firmwareArchBudgetLimit(
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
    FIRMWARE_ARCHITECTURE_CANDIDATES_PROVIDER.id,
    OPERATION,
    identity,
  );
};
