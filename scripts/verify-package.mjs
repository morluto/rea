import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import { PRODUCT_IDENTITY } from "../dist/identity.js";
import { MCP_STARTUP_POLICY } from "../dist/mcpStartupPolicy.js";
import * as prompts from "./verify-package-prompts.mjs";
import { verifyPackageArtifactAndElectron } from "./verify-package-artifact.mjs";
import { verifyPackageCapabilitiesAndSearch } from "./verify-package-capabilities.mjs";
import { verifyPackageDiscovery } from "./verify-package-discovery.mjs";
import { verifyPackageEnvironment } from "./verify-package-environment.mjs";
import { verifyPackageEvidence } from "./verify-package-evidence.mjs";
import { verifyPackageInstall } from "./verify-package-install.mjs";
import { verifyPackageUpdate } from "./verify-package-update.mjs";
import { verifyPackageMcp } from "./verify-package-mcp.mjs";
import { verifyPackagePack } from "./verify-package-pack.mjs";
import { verifyPackagePlatform } from "./verify-package-platform.mjs";
import { verifyPackageSetup } from "./verify-package-setup.mjs";
import { verifyManaged } from "./verify-package-managed.mjs";
import { verifyUnknownProvider } from "./verify-package-unknown-provider.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";
import {
  measureMcpStartup,
  profileMcpModuleLoading,
} from "./lib/mcp-startup-probe.mjs";

const root = process.cwd();
const outputArguments = process.argv.slice(2);
let retainedTarballPath;
if (outputArguments.length > 0) {
  if (
    outputArguments.length !== 2 ||
    outputArguments[0] !== "--output" ||
    outputArguments[1]?.trim() === ""
  ) {
    throw new Error(
      "usage: node scripts/verify-package.mjs [--output <tarball-path>]",
    );
  }
  retainedTarballPath = isAbsolute(outputArguments[1])
    ? outputArguments[1]
    : resolve(root, outputArguments[1]);
}
const verifierRun = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-package-"));
const evidenceRoot = join(workspace, "evidence");
const referenceRoot = join(workspace, "reference-source");
let tarball;
let mcpStartup;
let mcpModuleLoading;
let update;

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
  update = await verifyPackageUpdate({
    prefix: environmentData.prefix,
    packageRoot: join(
      environmentData.prefix,
      "lib",
      "node_modules",
      PRODUCT_IDENTITY.packageName,
    ),
    tarball: join(root, tarball),
    workspace,
    environment: environmentData.environment,
  });
  mcpStartup = await measureMcpStartup({
    command: cli,
    args: ["mcp"],
    environment: {
      ...environmentData.environment,
    },
    policy: MCP_STARTUP_POLICY,
  });
  mcpModuleLoading = await profileMcpModuleLoading({
    command: cli,
    args: ["mcp"],
    environment: {
      ...environmentData.environment,
    },
    policy: MCP_STARTUP_POLICY,
    packageName: PRODUCT_IDENTITY.packageName,
  });
  const { supportedSetupHost, hopperSetupSupported } =
    await verifyPackageDiscovery({
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
    hopperSetupSupported,
    root,
  });
  await verifyPackageMcp({
    cli,
    environment: environmentData.environment,
    evidenceRoot,
    artifactArchive,
  });
  let verifiedTarball;
  if (retainedTarballPath !== undefined) {
    await mkdir(dirname(retainedTarballPath), { recursive: true });
    await copyFile(
      join(root, tarball),
      retainedTarballPath,
      constants.COPYFILE_EXCL,
    );
    const bytes = await readFile(retainedTarballPath);
    verifiedTarball = {
      path: retainedTarballPath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    };
  }
  process.stdout.write(
    `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), cli: true, analysisCli: true, artifactCli: true, managedCli: true, managedReconstructionCli: true, managedNativeVerificationCli: true, managedApplicationGraphCli: true, evidenceCli: true, incurMcpCommand: PRODUCT_IDENTITY.mcpCommand, lifecycleScriptsRequired: false, doctor: "platform-appropriate", setup: supportedSetupHost ? "planned-then-idempotent" : "unsupported-host-rejected", setupPlanReadOnly: supportedSetupHost, existingHopperPreserved: supportedSetupHost, clients: supportedSetupHost ? 4 : 0, backupReadback: supportedSetupHost, failureRecovery: supportedSetupHost, configSymlinkLifecycle: supportedSetupHost, skill: supportedSetupHost, skillReferences: supportedSetupHost, mcpTools: TOOL_CONTRACTS.length, mcpPrompts: prompts.names.length, promptCompletion: true, promptCompletionLifecycle: true, evidenceMcp: true, targetFree: true, targetLifecycle: true, boundedRegexBridge: true, verifiedTarball, update, mcpStartup, mcpModuleLoading })}\n`,
  );
} finally {
  if (tarball) await rm(join(root, tarball), { force: true });
  await rm(workspace, { recursive: true, force: true });
}
