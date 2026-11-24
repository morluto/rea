import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { parseConfig } from "../dist/config/parseConfig.js";
import { GhidraClient } from "../dist/ghidra/GhidraClient.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { SUPPORTED_GHIDRA_VERSION } from "../dist/ghidra/GhidraReleasePolicy.js";
import { GhidraProvider } from "../dist/ghidra/GhidraProvider.js";
import { silentLogger } from "../dist/logger.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { bindVerifierCommandInterruption } from "./lib/verifier-command-interruption.mjs";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";

const run = createVerifierRun();
const procedureName = (name) =>
  process.platform === "darwin" ? `_${name}` : name;
assert.ok(
  process.platform === "linux" || process.platform === "darwin",
  "This regression lane requires Linux or macOS",
);
assert.ok(
  process.arch === "x64" || process.arch === "arm64",
  "This regression lane requires x86-64 or arm64",
);
const config = parseConfig(process.env);
if (!config.ok) throw config.error;
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: config.value.ghidraInstallDir,
  javaHome: config.value.ghidraJavaHome,
});
assert.equal(installation.status, "available", JSON.stringify(installation));
assert.equal(installation.providerVersion, SUPPORTED_GHIDRA_VERSION);
const fixtures = fileURLToPath(
  new URL("../tests/conformance/ghidra", import.meta.url),
);
const bridge = fileURLToPath(new URL("../bridge/ghidra", import.meta.url));
const workspaceFixture = await VerifierFixture.open({
  prefix: "rea-ghidra-noreturn-",
});
const workspace = workspaceFixture.path;
let cleaned = true;
let report;
let verifierRun;
// cc uses this command owner. A timeout stops its process group.
const commands = await createVerifierCommands();
const commandInterruption = bindVerifierCommandInterruption(commands);
const execOwned = commandInterruption.exec;
const { untilInterrupted, throwIfInterrupted } = commandInterruption;
const finishCommandInterruption = () => commandInterruption.finish();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The workspace stays while an owned Ghidra process or server may still use
// it: this cleanup confirms only once their cleanup was verified.
workspaceFixture.releaseAfter(async () => {
  if (!cleaned)
    throw new Error(
      `Owned Ghidra cleanup is unverified; retaining ${workspace}.`,
    );
  verifierRun = await completeVerifierRun(run);
  assertVerifierCleanupComplete(verifierRun.process_lineage);
});
commandInterruption.retainWorkspaceIfInterrupted(workspaceFixture);
await withVerifierFixture(workspaceFixture, async () => {
  let primaryFailure;
  try {
    const targetPath = join(
      workspace,
      process.platform === "darwin" ? "noreturn.dylib" : "noreturn.so",
    );
    const targetOptions =
      process.platform === "darwin"
        ? [
            "-dynamiclib",
            "-undefined",
            "dynamic_lookup",
            "-U_FORTIFY_SOURCE",
            "-D_FORTIFY_SOURCE=0",
          ]
        : ["-shared"];
    await execOwned(process.env.REA_CC ?? "cc", [
      ...targetOptions,
      "-fPIC",
      "-O0",
      "-fno-builtin",
      join(fixtures, "no-return.c"),
      "-o",
      targetPath,
    ]);
    const targetDigest = digest(await readFile(targetPath));
    const sourceDigests = Object.fromEntries(
      await Promise.all(
        ["ReaGhidraBridge.java", "ReaGhidraNoReturnFix.java"].map(
          async (name) => [name, digest(await readFile(join(bridge, name)))],
        ),
      ),
    );
    const project = join(workspace, "project");
    await mkdir(project);
    const launch = await spawnOwnedProviderProcess({
      command: installation.analyzeHeadlessPath,
      arguments: [
        project,
        "NoReturn",
        "-import",
        targetPath,
        "-readOnly",
        "-deleteProject",
        "-scriptPath",
        `${fixtures};${bridge}`,
        "-postScript",
        join(fixtures, "ReaNoReturnProbe.java"),
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
    let probe;
    try {
      assert.ok(
        await untilInterrupted(supervisor.waitForExit(120000)),
        "No-return probe timed out",
      );
      assert.ok(
        await untilInterrupted(supervisor.waitForOutputClose(1000)),
        "No-return probe output did not close",
      );
      const snapshot = supervisor.snapshot();
      const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
      assert.equal(snapshot.exitCode, 0, output);
      const reports = [
        ...output.matchAll(/REA_NO_RETURN_PROBE_JSON (\{[^\r\n]*\})/gu),
      ];
      assert.equal(reports.length, 1, output);
      probe = JSON.parse(reports[0][1]);
      assert.equal(probe.status, "passed");
      assert.equal(probe.ghidra_version, SUPPORTED_GHIDRA_VERSION);
      assert.equal(probe.target_sha256, targetDigest);
      for (const [name, expected] of Object.entries(sourceDigests))
        assert.equal(probe[name], expected);
      assert.ok(probe.checks.includes("independent_entry_preserved"));
      assert.ok(
        probe.checks.includes("propagated_flag_repaired_rea_tls_outer"),
      );
      assert.ok(probe.checks.includes("recovered_pseudocode"));
    } finally {
      const stopped = await supervisor.stop();
      cleaned = stopped.status === "verified-cleanup";
      assert.ok(
        cleaned,
        `Owned cleanup incomplete; retained ${workspace}: ${JSON.stringify(stopped)}`,
      );
    }

    // Exercise the actual Java server, authenticated transport, request queue and Evidence
    // projection. This read-only TCP lane also runs where AF_UNIX is unavailable; it does
    // not claim Windows authority or validation of the default Linux Unix-socket transport.
    const provider = new GhidraProvider(
      config.value,
      silentLogger,
      process.env,
      undefined,
      (options) =>
        new GhidraClient({
          ...options,
          transport: "authenticated-loopback-tcp",
        }),
    );
    const target = await parseBinaryTarget(targetPath);
    if (!target.ok) throw target.error;
    const profile = await provider.resolveAnalysisProfile(target.value);
    if (!profile.ok) throw profile.error;
    assert.ok(profile.value.profile);
    assert.equal(
      profile.value.profile.parameters.no_return_repair,
      "returning-imports-decoded-return",
    );
    const client = provider.createClient(target.value, profile.value.profile);
    cleaned = false;
    const observations = [];
    const failures = [];
    try {
      for (const operation of [
        "procedure_pseudo_code",
        "procedure_assembly",
        "procedure_info",
        "read_function_instructions",
        "analyze_function",
      ]) {
        throwIfInterrupted();
        const result = await untilInterrupted(
          client.execute(
            operation,
            { procedure: procedureName("rea_abort") },
            { signal: commandInterruption.signal },
          ),
        );
        if (!result.ok) throw result.error;
        const warnings = result.value.limitations.filter((value) =>
          /terminal call/u.test(value),
        );
        assert.ok(
          warnings.some(
            (value) => /abort/u.test(value) && /fallthrough/u.test(value),
          ),
          operation,
        );
        observations.push({ operation, warnings });
      }
      throwIfInterrupted();
      const healthy = await untilInterrupted(
        client.execute(
          "procedure_pseudo_code",
          { procedure: procedureName("rea_tls") },
          { signal: commandInterruption.signal },
        ),
      );
      if (!healthy.ok) throw healthy.error;
      assert.ok(
        !healthy.value.limitations.some((value) =>
          /terminal call/u.test(value),
        ),
      );
    } catch (cause) {
      failures.push(cause);
    }
    const closed = await client.close();
    cleaned = closed.ok;
    if (!closed.ok) failures.push(closed.error);
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "No-return Evidence verification failed",
      );
    assert.equal(digest(await readFile(targetPath)), targetDigest);
    report = {
      status: "passed",
      probe,
      observations,
      scope:
        "Real Ghidra ELF or Mach-O analysis with injected flags; real read-only TCP Evidence projection. No target execution; exact Amethyst artifact and Windows are unverified.",
    };
  } catch (cause) {
    primaryFailure = cause;
  }
  // Close the command owner before release observes the parent tree.
  let cleanupFailure;
  try {
    await workspaceFixture.closeEarly([() => commands.close()]);
  } catch (cause) {
    cleanupFailure = cause;
  }
  if (cleanupFailure !== undefined || primaryFailure !== undefined)
    throw workspaceFixture.retainedError(
      `No-return verification failed; retained diagnostic workspace: ${workspace}`,
      {
        cause:
          cleanupFailure === undefined
            ? primaryFailure
            : primaryFailure === undefined
              ? cleanupFailure
              : new AggregateError(
                  [primaryFailure, cleanupFailure],
                  "No-return verification and command cleanup both failed",
                ),
      },
    );
  const interrupted = commandInterruption.reason();
  if (interrupted !== undefined)
    throw workspaceFixture.retainedError(
      `No-return verification interrupted; retained diagnostic workspace: ${workspace}`,
      { cause: interrupted },
    );
});
const releaseInterrupted = finishCommandInterruption();
if (releaseInterrupted !== undefined) throw releaseInterrupted;
console.log(
  JSON.stringify({
    ...report,
    cleanup: "complete",
    verifier_run: verifierRun,
  }),
);
