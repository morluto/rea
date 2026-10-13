import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
import { verifyRepositorySkill } from "./verify-repository-skill.mjs";
import { verifyManaged } from "./verify-package-managed.mjs";
import { verifyUnknownProvider } from "./verify-package-unknown-provider.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";
import {
  createVerifiedPackageMetadata,
  retainVerifiedPackage,
  writeVerifiedPackageManifest,
} from "./ci/verified-package.mjs";
import {
  measureMcpStartup,
  profileMcpModuleLoading,
} from "./lib/mcp-startup-probe.mjs";

const root = process.cwd();
const execFileAsync = promisify(execFile);
const retentionDirectory = process.env.REA_VERIFIED_PACKAGE_DIRECTORY;
const verifierRun = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-package-"));
const evidenceRoot = join(workspace, "evidence");
const referenceRoot = join(workspace, "reference-source");
let tarball;
let mcpStartup;
let mcpModuleLoading;
let update;
let repositorySkill;
let report;
let retainedPackage;
let retentionMetadata;

const runStage = async (name, action) => {
  const started = performance.now();
  process.stderr.write(`[verify:package] ${name}: start\n`);
  const result = await action();
  process.stderr.write(
    `[verify:package] ${name}: complete (${Math.round(performance.now() - started)} ms)\n`,
  );
  return result;
};

try {
  if (retentionDirectory !== undefined && retentionDirectory !== "") {
    const sourceSha = (
      await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })
    ).stdout.trim();
    retentionMetadata = createVerifiedPackageMetadata({
      sourceSha,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      platform: process.platform,
      architecture: process.arch,
      packageVersion: PRODUCT_IDENTITY.packageVersion,
      nodeVersion: process.version,
    });
    await mkdir(retentionDirectory, { recursive: true });
    await unlink(join(retentionDirectory, "manifest.json")).catch((cause) => {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      )
        throw cause;
    });
  }
  repositorySkill = await runStage("repository skill", () =>
    verifyRepositorySkill({ root, workspace }),
  );
  ({ tarball } = await runStage("package archive", () =>
    verifyPackagePack({ root, workspace }),
  ));
  const environmentData = await runStage("package environment", () =>
    verifyPackageEnvironment({
      root,
      workspace,
      evidenceRoot,
      referenceRoot,
    }),
  );
  const { cli, packageRunnerCli } = await runStage("package install", () =>
    verifyPackageInstall({
      tarball,
      prefix: environmentData.prefix,
      workspace,
      environment: environmentData.environment,
    }),
  );
  update = await runStage("package update", () =>
    verifyPackageUpdate({
      prefix: environmentData.prefix,
      packageRoot: join(
        environmentData.prefix,
        "lib",
        "node_modules",
        PRODUCT_IDENTITY.packageName,
      ),
      tarball,
      workspace,
      environment: environmentData.environment,
    }),
  );
  mcpStartup = await runStage("MCP startup", () =>
    measureMcpStartup({
      command: cli,
      args: ["mcp"],
      environment: {
        ...environmentData.environment,
      },
      policy: MCP_STARTUP_POLICY,
    }),
  );
  mcpModuleLoading = await runStage("MCP module loading", () =>
    profileMcpModuleLoading({
      command: cli,
      args: ["mcp"],
      environment: {
        ...environmentData.environment,
      },
      policy: MCP_STARTUP_POLICY,
      packageName: PRODUCT_IDENTITY.packageName,
    }),
  );
  const { supportedSetupHost, hopperSetupSupported } = await runStage(
    "package discovery",
    () =>
      verifyPackageDiscovery({
        cli,
        environment: environmentData.environment,
      }),
  );
  const { artifactArchive } = await runStage("artifact and Electron CLI", () =>
    verifyPackageArtifactAndElectron({
      cli,
      workspace,
      environment: environmentData.environment,
    }),
  );
  await runStage("managed analysis CLI", () =>
    verifyManaged({
      cli,
      workspace,
      environment: environmentData.environment,
    }),
  );
  await runStage("unknown provider CLI", () =>
    verifyUnknownProvider({
      cli,
      environment: environmentData.environment,
    }),
  );
  await runStage("platform CLI", () =>
    verifyPackagePlatform({
      cli,
      environment: environmentData.environment,
    }),
  );
  await runStage("capabilities and search CLI", () =>
    verifyPackageCapabilitiesAndSearch({
      cli,
      environment: environmentData.environment,
    }),
  );
  await runStage("evidence CLI", () =>
    verifyPackageEvidence({
      cli,
      evidenceRoot,
      referenceRoot,
      environment: environmentData.environment,
    }),
  );
  await runStage("setup and uninstall CLI", () =>
    verifyPackageSetup({
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
    }),
  );
  await runStage("MCP tools and evidence", () =>
    verifyPackageMcp({
      cli,
      environment: environmentData.environment,
      evidenceRoot,
      artifactArchive,
    }),
  );
  report = {
    cli: true,
    analysisCli: true,
    artifactCli: true,
    managedCli: true,
    managedReconstructionCli: true,
    managedNativeVerificationCli: true,
    managedApplicationGraphCli: true,
    evidenceCli: true,
    incurMcpCommand: PRODUCT_IDENTITY.mcpCommand,
    lifecycleScriptsRequired: false,
    doctor: "platform-appropriate",
    setup: supportedSetupHost
      ? "planned-then-idempotent"
      : "unsupported-host-rejected",
    setupPlanReadOnly: supportedSetupHost,
    existingHopperPreserved: supportedSetupHost,
    clients: supportedSetupHost ? 4 : 0,
    backupReadback: supportedSetupHost,
    failureRecovery: supportedSetupHost,
    configSymlinkLifecycle: supportedSetupHost,
    skill: supportedSetupHost,
    skillReferences: supportedSetupHost,
    repositorySkill,
    mcpTools: TOOL_CONTRACTS.length,
    mcpPrompts: prompts.names.length,
    promptCompletion: true,
    promptCompletionLifecycle: true,
    evidenceMcp: true,
    targetFree: true,
    targetLifecycle: true,
    boundedRegexBridge: true,
    update,
    mcpStartup,
    mcpModuleLoading,
  };
  if (retentionMetadata !== undefined) {
    retainedPackage = await retainVerifiedPackage({
      sourceTarball: tarball,
      directory: retentionDirectory,
      metadata: retentionMetadata,
    });
  }
} finally {
  await runStage("workspace cleanup", () =>
    rm(workspace, { recursive: true, force: true }),
  );
}
const verifierLineage = await runStage("verifier lineage", () =>
  completeVerifierRun(verifierRun),
);
if (retainedPackage !== undefined)
  await writeVerifiedPackageManifest(
    retainedPackage.directory,
    retainedPackage.metadata,
  );
process.stdout.write(
  `${JSON.stringify({ verifier_run: verifierLineage, ...report })}\n`,
);
