import type { AnalysisProvider } from "./AnalysisProvider.js";
import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { BinarySession } from "./BinarySession.js";
import { SessionProviderRouter } from "./SessionProviderRouter.js";

/**
 * Compose one provider-neutral session from deep-provider selection and
 * disjoint auxiliary operation families.
 */
export const composeBinarySession = (
  registry: AnalysisProviderRegistry | SessionProviderRouter,
  auxiliaryProviders: readonly AnalysisProvider[] = [],
): BinarySession =>
  new BinarySession(
    registry instanceof SessionProviderRouter
      ? registry
      : SessionProviderRouter.selectable(registry, auxiliaryProviders),
  );
