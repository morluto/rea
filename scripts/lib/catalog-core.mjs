import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (root, path) => import(pathToFileURL(join(root, path)).href);

/** Sort tool/provider names alphabetically. */
export const names = (contracts) =>
  contracts
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right));

/** Throw when two name lists diverge. */
export const assertSameNames = (label, actual, expected) => {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((name) => !actualSet.has(name));
  const extra = [...actualSet].filter((name) => !expectedSet.has(name));
  if (missing.length === 0 && extra.length === 0) return;
  throw new Error(
    `${label} drifted (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
  );
};

const SOURCE_PATHS = {
  packageMetadata: "dist/generatedPackageMetadata.js",
  catalogIdentity: "dist/catalogIdentity.js",
  cli: "dist/cli.js",
  toolContracts: "dist/contracts/toolContracts.js",
  nativeContracts: "dist/contracts/nativeToolContracts.js",
  artifactContracts: "dist/contracts/artifactToolContracts.js",
  managedContracts: "dist/contracts/managedToolContracts.js",
  managedWorkflowContracts: "dist/contracts/managedWorkflowToolContracts.js",
  browserContracts: "dist/contracts/browserToolContracts.js",
  electronContracts: "dist/contracts/electronToolContracts.js",
  applicationContracts: "dist/contracts/applicationToolContracts.js",
  supportedClients: "dist/application/SupportedClients.js",
  hopperProvider: "dist/hopper/HopperProvider.js",
  ghidraProvider: "dist/ghidra/GhidraProvider.js",
  nativeProvider: "dist/native/NativeMacOSProvider.js",
  artifactProviders: "dist/application/InvestigationProviders.js",
  browserProvider: "dist/browser/CdpBrowserProvider.js",
  electronProvider: "dist/browser/CdpElectronProvider.js",
  evidence: "dist/domain/evidence.js",
  evidenceBundle: "dist/domain/evidenceBundle.js",
  evidenceCompletion: "dist/domain/evidenceCompletionLedger.js",
  completionGeneration: "dist/domain/completionLedgerGeneration.js",
  processCapture: "dist/domain/processCapture.js",
  analysisSnapshot: "dist/domain/analysisSnapshot.js",
  artifactGraph: "dist/domain/artifactGraph.js",
  investigationWorkspace: "dist/domain/investigationWorkspace.js",
  browserObservation: "dist/domain/browserObservation.js",
  browserSession: "dist/domain/browserSession.js",
  electronObservation: "dist/domain/electronObservation.js",
  webBundleAnalysis: "dist/domain/webBundleAnalysis.js",
  webCaptureDiff: "dist/domain/webCaptureDiff.js",
  managedArtifact: "dist/domain/managedArtifact.js",
  managedComparison: "dist/domain/managedMemberComparison.js",
  managedNativeVerification: "dist/domain/managedNativeVerification.js",
  webMcpDiscovery: "dist/domain/webMcpDiscovery.js",
  webScreenshot: "dist/domain/webScreenshot.js",
  javascriptApplicationGraph: "dist/domain/javascriptApplicationGraph.js",
  javascriptApplicationAnalysis: "dist/domain/javascriptApplicationAnalysis.js",
  javascriptFeatureTrace: "dist/domain/javascriptFeatureTraceSchemas.js",
  javascriptVersionComparison:
    "dist/domain/javascriptApplicationVersionComparisonSchemas.js",
  reconstructionVerification:
    "dist/domain/reconstructionVerificationSchemas.js",
  residualUnknown: "dist/domain/residualUnknown.js",
};

/** Load every compiled source module referenced by the catalog. */
export const loadSources = async (root) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(SOURCE_PATHS).map(async ([key, path]) => [
        key,
        await load(root, path),
      ]),
    ),
  );
