import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  artifactFilePrimaryFacts,
  projectArtifactCloseFailure,
  projectStableArtifactFailure,
  ArtifactReaderFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { DevicetreePort } from "../../ports/binaryDiagnostics/DevicetreePort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import {
  MAX_DEVICETREE_FILE_BYTES,
  type InspectDevicetreeInput,
} from "../../domain/firmware/devicetree.js";
import { err, ok } from "../../domain/result.js";
import { DEVICETREE_PROVIDER } from "../../domain/investigationProviders.js";
import {
  DEVICETREE_FORMAT,
  parseDevicetree,
} from "../../domain/firmware/devicetreeParser.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";

const OPERATION = "inspect_devicetree";

/** Portable parser over one bounded, identity-checked regular file. */
export class DevicetreeProvider implements DevicetreePort {
  readonly identity = DEVICETREE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        DEVICETREE_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectDevicetreeInput, options?: ExecutionOptions) {
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
        const { report } = parseDevicetree(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
        );
        return ok(report);
      });
    } catch (cause) {
      return err(devicetreeFailure(cause, input, snapshot));
    }
  }
}

const devicetreeFailure = (
  cause: unknown,
  input: InspectDevicetreeInput,
  snapshot?: StableArtifactSnapshot,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  return projectStableArtifactFailure(
    cause,
    classifyProviderFailure(
      facts.cause,
      offlineArtifactFailureDialect(facts, {
        operation: OPERATION,
        providerId: DEVICETREE_PROVIDER.id,
        path: input.path,
        description: "devicetree blob",
        fallbackMessage: "devicetree inspection failed.",
        recognise: (failure, origin) => {
          if (isParseLimit(failure, DEVICETREE_FORMAT))
            return parseLimitConstraint(
              OPERATION,
              failure.failure.limit.name === "decoded_bytes"
                ? "memory"
                : "capacity",
              failure,
              { retryable: false, remediationAction: failure.failure.detail },
            );
          if (
            origin === "owned-or-classified" &&
            failure instanceof ArtifactReaderFailure &&
            failure.reason === "limit"
          )
            return new AnalysisResourceConstraintError(
              OPERATION,
              failure.boundary ?? "memory",
              failure.message,
              { max_file_bytes: input.max_file_bytes },
              {
                cause: failure,
                retryable: false,
                remediationAction:
                  input.max_file_bytes < MAX_DEVICETREE_FILE_BYTES
                    ? "Raise max_file_bytes within its schema ceiling or select a smaller DTB."
                    : "Select a smaller DTB; the fixed file-byte ceiling has been reached.",
              },
            );
          return undefined;
        },
      }),
    ),
    input.path,
    DEVICETREE_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
