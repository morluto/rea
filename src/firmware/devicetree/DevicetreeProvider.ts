import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  artifactFilePrimaryFacts,
  closeArtifactResources,
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
  DEVICETREE_READ_BUDGETS,
  devicetreeReadBudgetLimit,
  type DevicetreeReadBudget,
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

/** The per-call budget a parser limit names, or undefined for a fixed allowance. */
const devicetreeReadBudget = (name: string): DevicetreeReadBudget | undefined =>
  (Object.keys(DEVICETREE_READ_BUDGETS) as DevicetreeReadBudget[]).find(
    (budget) => budget === name,
  );

/** Portable parser over one bounded, identity-checked regular file. */
export class DevicetreeProvider implements DevicetreePort {
  readonly identity = DEVICETREE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      DEVICETREE_PROVIDER,
      OPERATION,
    );
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
          if (isParseLimit(failure, DEVICETREE_FORMAT)) {
            const { name, maximum } = failure.failure.limit;
            const parameter = devicetreeReadBudget(name);
            if (parameter !== undefined)
              return parseLimitConstraint(
                OPERATION,
                parameter === "max_decoded_bytes" ? "memory" : "capacity",
                failure,
                {
                  retryable: false,
                  limit: devicetreeReadBudgetLimit(parameter, maximum),
                },
              );
          }
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
                limit: devicetreeReadBudgetLimit(
                  "max_file_bytes",
                  input.max_file_bytes,
                ),
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
