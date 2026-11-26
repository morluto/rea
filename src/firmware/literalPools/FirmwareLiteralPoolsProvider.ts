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
  MAX_LITERAL_POOL_FILE_BYTES,
  MAX_LITERAL_POOL_REFERENCES,
  MAX_LITERAL_POOL_SVD_XML_NODES,
  firmwareLiteralPoolBudgetLimit,
  type InspectFirmwareLiteralPoolsInput,
} from "../../domain/firmware/firmwareLiteralPools.js";
import {
  EMPTY_SVD_PERIPHERAL_PROFILE,
  parseSvdPeripheralSpans,
} from "../../domain/firmware/firmwareLiteralPoolRegions.js";
import { scanFirmwareLiteralPoolsSteps } from "../../domain/firmware/firmwareLiteralPoolScanner.js";
import { FIRMWARE_LITERAL_POOLS_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok } from "../../domain/result.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";

const OPERATION = "inspect_firmware_literal_pools";

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
            : parseSvdPeripheralSpans(input.svd_xml, input.max_svd_nodes);
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

        const steps = scanFirmwareLiteralPoolsSteps({
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
          svdSupplied: input.svd_xml !== undefined,
          svdProfile: svdResult.value,
        });
        let step = steps.next();
        while (!step.done) {
          assertArtifactReadActive(options?.signal);
          await immediate();
          assertArtifactReadActive(options?.signal);
          step = steps.next();
        }
        const parsed = step.value;
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

const fileSizeRemediation = (input: InspectFirmwareLiteralPoolsInput): string =>
  input.max_file_bytes >= MAX_LITERAL_POOL_FILE_BYTES
    ? `The image exceeds the ${String(MAX_LITERAL_POOL_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller firmware slice.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes within its ${String(MAX_LITERAL_POOL_FILE_BYTES)}-byte ceiling, or select a smaller firmware slice.`;

const maxReferencesRemediation = (
  input: InspectFirmwareLiteralPoolsInput,
): string =>
  input.max_references >= MAX_LITERAL_POOL_REFERENCES
    ? `Narrow max_scan_bytes or advance scan_offset so the window stays within ${String(MAX_LITERAL_POOL_REFERENCES)} resolved literal-pool loads.`
    : `Raise max_references above ${String(input.max_references)} within its ${String(MAX_LITERAL_POOL_REFERENCES)} ceiling, or narrow max_scan_bytes.`;

const maxSvdNodesRemediation = (
  input: InspectFirmwareLiteralPoolsInput,
): string =>
  input.max_svd_nodes >= MAX_LITERAL_POOL_SVD_XML_NODES
    ? `Provide a trimmed CMSIS-SVD document within the ${String(MAX_LITERAL_POOL_SVD_XML_NODES)}-node XML ceiling.`
    : `Raise max_svd_nodes above ${String(input.max_svd_nodes)} within its ${String(MAX_LITERAL_POOL_SVD_XML_NODES)}-node ceiling, or provide a trimmed CMSIS-SVD document.`;

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
            limit: firmwareLiteralPoolBudgetLimit(
              "max_svd_nodes",
              input.max_svd_nodes,
            ),
            remediationAction: maxSvdNodesRemediation(input),
          });
        }
        if (
          isParseLimit(failure, "firmware-literal-pools") &&
          failure.failure.limit.name === "max_references"
        ) {
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            retryable: false,
            limit: firmwareLiteralPoolBudgetLimit(
              "max_references",
              input.max_references,
            ),
            remediationAction: maxReferencesRemediation(input),
          });
        }
        return undefined;
      },
      fileSize: (failure) =>
        parseLimitConstraint(
          OPERATION,
          "file-size",
          decodeLimit(
            "firmware-literal-pools",
            failure.message,
            { name: "max_file_bytes", maximum: input.max_file_bytes },
            { cause: failure },
          ),
          {
            retryable: false,
            limit: firmwareLiteralPoolBudgetLimit(
              "max_file_bytes",
              input.max_file_bytes,
            ),
            remediationAction: fileSizeRemediation(input),
          },
        ),
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
