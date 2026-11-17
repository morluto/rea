import type { SafeOutputFile } from "../../resources/index.js";
import { Readable } from "node:stream";
import { sha256Hex } from "../../kernel/sha256Hex.js";
import {
  AnalysisCleanupLease,
  ArtifactResourceScope,
  SafeOutputTree,
  SafeOutputTreeCreationFailure,
  outputDirectoryAdmissionRefusal,
} from "../../resources/index.js";
import {
  AnalysisOutputError,
  fixedCeilingConstraint,
  cancelledBy,
  carriedReason,
} from "../../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupDependencies } from "../../domain/analysisErrorCleanup.js";
import {
  classifyProviderFailure,
  type ProviderFailureDialect,
} from "../../providers/classifyProviderFailure.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import type { Evidence } from "../../domain/evidence.js";
import { REA_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
export const RASTER_EXPORT_OPERATION = "export_structured_raster_resources";
export const RASTER_EXPORT_LIMITS = {
  output_bytes: 256 * 1024 * 1024,
  resource_outcomes: 4096,
  output_files: 8194,
} as const;
export function rasterExportCapacity(
  reason: string,
  ceiling: "output_bytes" | "resource_outcomes" | "output_files",
  maximum: number = RASTER_EXPORT_LIMITS[ceiling],
) {
  return fixedCeilingConstraint(RASTER_EXPORT_OPERATION, "capacity", reason, {
    name: `Raster export ${ceiling}`,
    kind: ceiling === "output_bytes" ? "bytes" : "input",
    limit: maximum,
    unit: ceiling === "output_bytes" ? "bytes" : "items",
    narrowing: "Select fewer resources or smaller raster hypotheses.",
  });
}
export const rasterExportFailureDialect = (
  signal?: AbortSignal,
): ProviderFailureDialect => ({
  providerId: REA_WORKFLOW_PROVIDER.id,
  operation: RASTER_EXPORT_OPERATION,
  recognise: (cause: unknown) =>
    signal?.aborted && cause === signal.reason
      ? cancelledBy(RASTER_EXPORT_OPERATION, carriedReason(signal.reason))
      : undefined,
  unclassified: (cause, details) =>
    new AnalysisOutputError(
      RASTER_EXPORT_OPERATION,
      "Raster export publication failed.",
      { ...details, cause },
    ),
});
export interface RasterExportWriter {
  write(path: string, bytes: Uint8Array): Promise<SafeOutputFile>;
  readonly remainingBytes: number;
  readonly publishedBytes: number;
  readonly fileCount: number;
}
/** Owns exclusive output, rollback retry, and the commit point independently of source reads. */
export class RasterExportPublication {
  private readonly resources = new ArtifactResourceScope();
  constructor(
    private readonly trees: Pick<
      typeof SafeOutputTree,
      "create" | "checkDestination"
    > = SafeOutputTree,
    private readonly maxBytes: number = RASTER_EXPORT_LIMITS.output_bytes,
  ) {}
  close(): Promise<void> {
    return this.resources.close();
  }
  async publish<T>(
    destination: string,
    produce: (writer: RasterExportWriter) => Promise<T>,
    observation: (value: T) => Evidence,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.resources.run(() =>
      this.publishOwned(destination, produce, observation, signal),
    );
  }
  private async publishOwned<T>(
    destination: string,
    produce: (writer: RasterExportWriter) => Promise<T>,
    observation: (value: T) => Evidence,
    signal?: AbortSignal,
  ): Promise<T> {
    let tree: SafeOutputTree | undefined, receipt: T | undefined;
    try {
      signal?.throwIfAborted();
      await this.trees.checkDestination(destination);
      signal?.throwIfAborted();
      tree = await this.trees.create(destination);
      const writer = createExportWriter(tree, this.maxBytes, signal);
      receipt = await produce(writer);
      // Validate the deliverable before committing. Do not allow post-commit cancellation to erase it.
      observation(receipt);
      signal?.throwIfAborted();
      await tree.commit(signal);
      return receipt;
    } catch (cause) {
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      const primary = classifyProviderFailure(
        outputDirectoryAdmissionRefusal(
          RASTER_EXPORT_OPERATION,
          "output_directory",
          cause,
        ),
        rasterExportFailureDialect(signal),
      );
      const owned = tree;
      const lease =
        owned === undefined
          ? undefined
          : new AnalysisCleanupLease(async () => {
              await owned.rollback();
            }, [destination]);
      try {
        await lease?.release();
      } catch (cleanupCause) {
        const cleanup = new ProviderCleanupError(
          REA_WORKFLOW_PROVIDER.id,
          [destination],
          {},
          {
            operation: RASTER_EXPORT_OPERATION,
            cause: cleanupCause,
            remediationAction:
              "Retry cleanup before exporting to a new destination.",
          },
        );
        if (lease) {
          this.resources.retain({
            kind: "lease",
            resource: destination,
            lease,
          });
          lease.bindCleanupError(cleanup);
        }
        if (tree?.published && receipt !== undefined)
          primary.retainPartialObservation(observation(receipt));
        throw analysisErrorWithCleanupDependencies(
          primary,
          cleanup,
          RASTER_EXPORT_OPERATION,
        );
      }
      if (tree?.published && receipt !== undefined) return receipt;
      throw primary;
    }
  }
}

function createExportWriter(
  owned: SafeOutputTree,
  maxBytes: number,
  signal?: AbortSignal,
): RasterExportWriter {
  let count = 0,
    total = 0;

  return {
    get remainingBytes() {
      return maxBytes - total;
    },
    get publishedBytes() {
      return total;
    },
    get fileCount() {
      return count;
    },
    async write(path, bytes) {
      signal?.throwIfAborted();
      if (bytes.byteLength > maxBytes - total)
        throw rasterExportCapacity(
          "Aggregate raster export byte budget exceeded, including metadata.",
          "output_bytes",
          maxBytes,
        );
      if (count >= RASTER_EXPORT_LIMITS.output_files)
        throw rasterExportCapacity(
          "Raster export file allowance exceeded.",
          "output_files",
        );
      total += bytes.byteLength;
      count++;
      return owned.write(
        path,
        Readable.from([bytes]),
        {
          sha256: sha256Hex(bytes),
          bytes: bytes.byteLength,
        },
        signal,
      );
    },
  };
}
