import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseConfig } from "../dist/config/parseConfig.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { SUPPORTED_GHIDRA_VERSION } from "../dist/ghidra/GhidraReleasePolicy.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { closeVerifierResources } from "./lib/verifier-cleanup.mjs";
import { bindVerifierCommandInterruption } from "./lib/verifier-command-interruption.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";

// Calls between exported functions of an ELF -fPIC shared library reach their
// target through a PLT thunk. Mach-O dylibs bind those calls directly, so this
// lane needs a Linux ELF toolchain.
if (
  process.env.GHIDRA_INSTALL_DIR === undefined ||
  process.platform !== "linux"
)
  throw new Error(
    "The thunk call lane requires BYO Ghidra and a C compiler on Linux.",
  );
// The lane proves behavior on the pinned Ghidra build only; a compatible but
// unverified build is refused rather than reported as that evidence.
const config = parseConfig(process.env);
if (!config.ok) throw config.error;
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: config.value.ghidraInstallDir,
  javaHome: config.value.ghidraJavaHome,
});
assert.equal(installation.status, "available", JSON.stringify(installation));
assert.equal(installation.providerVersion, SUPPORTED_GHIDRA_VERSION);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = createVerifierRun();
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const fixtures = fileURLToPath(
  new URL("../tests/conformance/ghidra", import.meta.url),
);
const bridge = fileURLToPath(new URL("../bridge/ghidra", import.meta.url));
const workspaceFixture = await VerifierFixture.open({
  prefix: "rea-ghidra-thunk-calls-",
});
const workspace = workspaceFixture.path;
// The compiler and the CLI use this command owner. A timeout stops its
// process group.
const commands = await createVerifierCommands();
const commandInterruption = bindVerifierCommandInterruption(commands);
const execOwned = commandInterruption.exec;
const { untilInterrupted, throwIfInterrupted } = commandInterruption;
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
  GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { JAVA_HOME: process.env.JAVA_HOME }),
};
const source = join(fixtures, "shared-thunks.c");
const targetPath = join(workspace, "librea-ghidra-shared.so");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "rea-ghidra-thunk-calls", version: "1" });
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-262144);
});
// The workspace stays while the owned headless probe may still use it.
let probeCleaned = true;
let verifierRun;
workspaceFixture.releaseAfter(() => {
  if (!probeCleaned)
    throw new Error(
      `Owned Ghidra probe cleanup is unverified; retaining ${workspace}.`,
    );
});
workspaceFixture.releaseAfter(() =>
  closeVerifierResources([() => client.close(), () => transport.close()]),
);
// The process tree is observed once the probe, the MCP server and the command
// owner are closed.
workspaceFixture.releaseAfter(async () => {
  verifierRun = await completeVerifierRun(run);
  assertVerifierCleanupComplete(verifierRun.process_lineage);
});
commandInterruption.retainWorkspaceIfInterrupted(workspaceFixture);
const call = async (name, args = {}) => {
  throwIfInterrupted();
  return requireMcpOperationResult(
    await client.callTool({ name, arguments: args }, { timeout: 180000 }),
    name,
  );
};

// A call into the thunk's body rather than its entry is not folded into the
// leaf's callers; the probe moves the fixture's call there and requires
// partial caller coverage from the production bridge.
async function coverageProbe(targetDigest) {
  const project = join(workspace, "project");
  await mkdir(project);
  probeCleaned = false;
  const launch = await spawnOwnedProviderProcess({
    command: installation.analyzeHeadlessPath,
    arguments: [
      project,
      "ThunkCalls",
      "-import",
      targetPath,
      "-readOnly",
      "-deleteProject",
      "-scriptPath",
      `${fixtures};${bridge}`,
      "-postScript",
      join(fixtures, "ReaThunkCallCoverageProbe.java"),
      bridge,
    ],
    runId: run.run_id,
    expectedCommand: null,
    signal: commandInterruption.signal,
  });
  const supervisor = new ProviderProcessSupervisor({
    ...launch,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
  });
  try {
    assert.ok(
      await untilInterrupted(supervisor.waitForExit(180000)),
      "Thunk call coverage probe timed out",
    );
    assert.ok(
      await untilInterrupted(supervisor.waitForOutputClose(1000)),
      "Thunk call coverage probe output did not close",
    );
    const snapshot = supervisor.snapshot();
    const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
    assert.equal(snapshot.exitCode, 0, output);
    const reports = [
      ...output.matchAll(/REA_THUNK_CALL_COVERAGE_PROBE_JSON (\{[^\r\n]*\})/gu),
    ];
    assert.equal(reports.length, 1, output);
    const probe = JSON.parse(reports[0][1]);
    assert.equal(probe.status, "passed");
    assert.equal(probe.ghidra_version, SUPPORTED_GHIDRA_VERSION);
    assert.equal(probe.target_sha256, targetDigest);
    assert.equal(
      probe["ReaGhidraBridge.java"],
      digest(await readFile(join(bridge, "ReaGhidraBridge.java"))),
    );
    for (const check of [
      "entry_call_folded_into_callers",
      "entry_call_coverage_complete",
      "interior_caller_omitted_by_entry_getter",
      "interior_caller_not_listed",
      "interior_caller_coverage_partial",
      "interior_caller_direction_explicit",
      "dossier_interior_caller_partial",
      "restored_call_complete",
    ])
      assert.ok(probe.checks.includes(check), check);
    return probe.checks;
  } finally {
    const stopped = await supervisor.stop();
    probeCleaned = stopped.status === "verified-cleanup";
    assert.ok(
      probeCleaned,
      `Owned cleanup incomplete; retained ${workspace}: ${JSON.stringify(stopped)}`,
    );
  }
}

let report;
await withVerifierFixture(workspaceFixture, async () => {
  let primaryFailure;
  try {
    await execOwned(
      process.env.REA_CC ?? "cc",
      ["-shared", "-fPIC", "-O0", "-fno-inline", source, "-o", targetPath],
      { timeout: 60000 },
    );
    const original = await readFile(targetPath);
    const coverageChecks = await coverageProbe(digest(original));
    await client.connect(transport);
    await call("open_binary", { path: targetPath, provider_id: "ghidra" });
    const procedures = await call("list_procedures");
    const named = (name) => procedures.filter(({ value }) => value === name);
    const leaf = named("rea_ghidra_shared_leaf").find(
      ({ procedure }) => !procedure.thunk && !procedure.external,
    );
    const thunk = named("rea_ghidra_shared_leaf").find(
      ({ procedure }) =>
        procedure.thunk && procedure.thunk_target === leaf?.address,
    );
    const entry = named("rea_ghidra_shared_entry").find(
      ({ procedure }) => !procedure.thunk && !procedure.external,
    );
    assert.ok(
      leaf && thunk && entry,
      `The fixture has no PLT thunk for its leaf; the compiler may have bound the call directly: ${JSON.stringify(named("rea_ghidra_shared_leaf"))}`,
    );
    const callers = await call("procedure_callers", {
      procedure: leaf.address,
    });
    assert.ok(callers.includes(entry.address), JSON.stringify(callers));
    assert.ok(!callers.includes(thunk.address), JSON.stringify(callers));
    const thunkCallees = await call("procedure_callees", {
      procedure: thunk.address,
    });
    assert.ok(
      thunkCallees.includes(leaf.address),
      JSON.stringify(thunkCallees),
    );
    const dossier = await call("analyze_function", {
      procedure: leaf.address,
      detail: "complete",
    });
    const dossierCallers = dossier.callers.map(({ address }) => address);
    assert.ok(
      dossierCallers.includes(entry.address),
      JSON.stringify(dossierCallers),
    );
    await call("close_binary");
    const cli = await execOwned(
      process.execPath,
      [
        entrypoint,
        "function",
        targetPath,
        leaf.address,
        "--provider",
        "ghidra",
        "--format",
        "json",
      ],
      { env, timeout: 180000, maxBuffer: 32 * 1024 * 1024 },
    );
    const evidence = parseEvidence(JSON.parse(cli.stdout));
    assert.equal(evidence.provider.id, "ghidra");
    assert.equal(evidence.provider.version, SUPPORTED_GHIDRA_VERSION);
    assert.deepEqual(
      evidence.normalized_result.callers.map(({ address }) => address),
      dossierCallers,
    );
    assert.deepEqual(await readFile(targetPath), original);
    report = {
      status: "passed",
      ghidra_version: SUPPORTED_GHIDRA_VERSION,
      entry: entry.address,
      leaf: leaf.address,
      thunk: thunk.address,
      callers,
      thunk_callees: thunkCallees,
      dossier_callers: dossierCallers,
      cli_mcp_parity: true,
      source_unchanged: true,
      coverage_probe: coverageChecks,
      scope: `Real Ghidra ${SUPPORTED_GHIDRA_VERSION} analysis of a source-owned ELF -fPIC shared library through MCP, the CLI and a headless bridge probe. No target execution; Mach-O and PE thunks are not exercised.`,
    };
  } catch (cause) {
    if (stderr.trim()) process.stderr.write(stderr);
    primaryFailure = cause;
  }
  // Close the command owner before release observes the process tree.
  let cleanupFailure;
  try {
    await workspaceFixture.closeEarly([() => commands.close()]);
  } catch (cause) {
    cleanupFailure = cause;
  }
  if (cleanupFailure !== undefined || primaryFailure !== undefined)
    throw workspaceFixture.retainedError(
      `Thunk call verification failed; retained diagnostic workspace: ${workspace}`,
      {
        cause:
          cleanupFailure === undefined
            ? primaryFailure
            : primaryFailure === undefined
              ? cleanupFailure
              : new AggregateError(
                  [primaryFailure, cleanupFailure],
                  "Thunk call verification and command cleanup both failed",
                ),
      },
    );
  const interrupted = commandInterruption.reason();
  if (interrupted !== undefined)
    throw workspaceFixture.retainedError(
      `Thunk call verification interrupted; retained diagnostic workspace: ${workspace}`,
      { cause: interrupted },
    );
});
const releaseInterrupted = commandInterruption.finish();
if (releaseInterrupted !== undefined) throw releaseInterrupted;
console.log(JSON.stringify({ ...verifierRun, report }, null, 2));
