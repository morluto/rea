import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import * as prompts from "./verify-package-prompts.mjs";
import { verifyPackagedInvestigation } from "./verify-package-investigation.mjs";
import { verifyPackageArtifactAndElectron } from "./verify-package-artifact.mjs";
import { verifyPackageCapabilitiesAndSearch } from "./verify-package-capabilities.mjs";
import { verifyPackageDiscovery } from "./verify-package-discovery.mjs";
import { verifyPackageEnvironment } from "./verify-package-environment.mjs";
import { verifyPackageEvidence } from "./verify-package-evidence.mjs";
import { verifyPackageInstall } from "./verify-package-install.mjs";
import { verifyPackageMcp } from "./verify-package-mcp.mjs";
import { verifyPackagePack } from "./verify-package-pack.mjs";
import { verifyPackagePlatform } from "./verify-package-platform.mjs";
import { verifyPackageSetup } from "./verify-package-setup.mjs";
import { verifyManaged } from "./verify-package-managed.mjs";
import { verifyUnknownProvider } from "./verify-package-unknown-provider.mjs";

const root = process.cwd();
const workspace = await mkdtemp(join(tmpdir(), "rea-package-"));
const evidenceRoot = join(workspace, "evidence");
const referenceRoot = join(workspace, "reference-source");
let tarball;

try {
  ({ tarball } = await verifyPackagePack({ root, workspace }));
  const environmentData = await verifyPackageEnvironment({
    root,
    workspace,
    evidenceRoot,
    referenceRoot,
  });
  const { cli, packageRunnerCli } = await verifyPackageInstall({
    root,
    tarball,
    prefix: environmentData.prefix,
    workspace,
    environment: environmentData.environment,
  });
  const { supportedSetupHost } = await verifyPackageDiscovery({
    cli,
    environment: environmentData.environment,
  });
  const { artifactArchive } = await verifyPackageArtifactAndElectron({
    cli,
    workspace,
    environment: environmentData.environment,
  });
  await verifyManaged({
    cli,
    workspace,
    environment: environmentData.environment,
  });
  const investigationReplay = await verifyPackagedInvestigation({
    cli,
    workspace,
    evidenceRoot,
    artifactArchive,
    environment: environmentData.environment,
  });
  await verifyUnknownProvider({
    cli,
    environment: environmentData.environment,
  });
  await verifyPackagePlatform({
    cli,
    environment: environmentData.environment,
  });
  await verifyPackageCapabilitiesAndSearch({
    cli,
    environment: environmentData.environment,
  });
  await verifyPackageEvidence({
    cli,
    evidenceRoot,
    referenceRoot,
    environment: environmentData.environment,
  });
  await verifyPackageSetup({
    cli,
    packageRunnerCli,
    environment: environmentData.environment,
    home: environmentData.home,
    npxLog: environmentData.npxLog,
    claudeConfig: environmentData.claudeConfig,
    codexConfig: environmentData.codexConfig,
    cursorConfig: environmentData.cursorConfig,
    codexTarget: environmentData.codexTarget,
    cursorTarget: environmentData.cursorTarget,
    supportedSetupHost,
    root,
  });
  await verifyPackageMcp({
    cli,
    environment: environmentData.environment,
    evidenceRoot,
    investigationReplay,
  });
  process.stdout.write(
    `${JSON.stringify({ cli: true, analysisCli: true, artifactCli: true, managedCli: true, managedReconstructionCli: true, managedNativeVerificationCli: true, managedRuntimePlanCli: true, managedApplicationGraphCli: true, evidenceCli: true, incurMcpCommand: "npx -y rea-agents@latest mcp", lifecycleScriptsRequired: false, doctor: "platform-appropriate", setup: supportedSetupHost ? "planned-then-idempotent" : "unsupported-host-rejected", setupPlanReadOnly: supportedSetupHost, existingHopperPreserved: supportedSetupHost, clients: supportedSetupHost ? 3 : 0, backupReadback: supportedSetupHost, failureRecovery: supportedSetupHost, configSymlinkLifecycle: supportedSetupHost, skill: supportedSetupHost, mcpTools: TOOL_CONTRACTS.length, mcpPrompts: prompts.names.length, promptCompletion: true, promptCompletionLifecycle: true, evidenceMcp: true, targetFree: true, targetLifecycle: true, boundedRegexBridge: true })}\n`,
  );
} finally {
  if (tarball) await rm(join(root, tarball), { force: true });
  await rm(workspace, { recursive: true, force: true });
}
