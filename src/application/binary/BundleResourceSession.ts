import type {
  AnalysisClient,
  CapabilityDescriptor,
} from "../../ports/AnalysisProvider.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { analysisErrorWithCloseRejections } from "../../domain/analysisErrorCleanup.js";
import { err, ok } from "../../domain/result.js";
import type { ResolvedAppBundleResourceRoot } from "../../domain/apple/bundleResourceRoot.js";
import { closeAnalysisClient } from "../../providers/AnalysisClientCleanup.js";
import {
  BUNDLE_NATIVE_RESOURCE_OPERATIONS,
  BUNDLE_RESOURCE_OPERATIONS,
} from "../../ports/BundleResourceOperations.js";

/** Provider-specific owner of the four read-only app-resource operations. */
export interface BundleResourceClientFactory {
  createClient(
    root: ResolvedAppBundleResourceRoot,
  ): BundleResourceClientBinding | Promise<BundleResourceClientBinding>;
}

export interface BundleResourceClientBinding {
  readonly client: AnalysisClient;
  readonly capabilities: readonly CapabilityDescriptor[];
}

export interface ActiveBundleResourceSession {
  readonly root: ResolvedAppBundleResourceRoot;
  readonly client: AnalysisClient;
  readonly capabilities: readonly CapabilityDescriptor[];
  readonly runId: string;
}

/** Route each resource read to the owner that understands its format. */
export const combineBundleResourceClients = (
  artifactClient: AnalysisClient,
  nativeClient: AnalysisClient,
): AnalysisClient => ({
  execute: (operation, parameters, options) => {
    if (operation === "health")
      return artifactClient.execute(operation, parameters, options);
    if (!BUNDLE_RESOURCE_OPERATIONS.has(operation))
      return Promise.resolve(
        err(
          new AnalysisCapabilityUnavailableError(
            "bundle-resources",
            operation,
            "This session provides read-only app resource inspection only.",
          ),
        ),
      );
    return BUNDLE_NATIVE_RESOURCE_OPERATIONS.has(operation)
      ? nativeClient.execute(operation, parameters, options)
      : artifactClient.execute(operation, parameters, options);
  },
  close: async (options) => {
    const [artifact, native] = await Promise.all([
      closeAnalysisClient(artifactClient, "bundle-resources", options),
      closeAnalysisClient(nativeClient, "bundle-resources", options),
    ]);
    if (!artifact.ok && !native.ok) {
      return err(
        analysisErrorWithCloseRejections(
          artifact.error,
          native.error,
          "close_binary",
        ),
      );
    }
    if (!artifact.ok) return artifact;
    if (!native.ok) return native;
    return ok(null);
  },
});
