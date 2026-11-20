#!/usr/bin/env node
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import assert from "node:assert/strict";
import {
  requireMcpOperationResult,
  requireMcpOutput,
} from "./lib/mcp-verifier-results.mjs";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  buildSwitchSource,
  switchSymbolOracle,
  assertCompiledSwitchOracle,
} from "../tests/conformance/ghidra/switch-fixture.mjs";
import {
  assertSwitchBoundary,
  assertSwitchOracleControls,
} from "./verify-real-ghidra-switch-assertions.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import {
  assertVerifierCleanupComplete,
  createVerifierRun,
  completeVerifierRun,
} from "./lib/verifier-run.mjs";
import { verifySwitchEvidenceControls } from "./verify-real-ghidra-switch-controls.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";

// Narrow compiler-shape lane; no cross compiler or game artifact prerequisites.
const { values } = parseArgs({
  options: {
    "compiler-oracle-only": { type: "boolean", default: false },
    entrypoint: { type: "string" },
  },
});
const compilerOnly = values["compiler-oracle-only"];
const entrypoint =
  values.entrypoint === undefined
    ? fileURLToPath(new URL("./rea.mjs", import.meta.url))
    : resolve(values.entrypoint);
assert.ok(
  process.platform === "linux" && process.arch === "x64",
  "Ghidra switch compiler lane requires Linux x64; macOS/Windows and cross targets use their separate provider lanes.",
);
// Compiler, reader and CLI launches share one command owner, including the
// pre-workspace version probes. A timeout stops that process group.
const commands = await createVerifierCommands();
// Ctrl-C must abort the detached command and wait for its cleanup. Node's
// default SIGINT would exit first and leave that process group running.
const commandInterruption = new AbortController();
const interruptOwnedCommand = (signal) =>
  commandInterruption.abort(new Error(`Verifier interrupted by ${signal}`));
process.on("SIGINT", interruptOwnedCommand);
process.on("SIGTERM", interruptOwnedCommand);
const execOwned = (command, args, options = {}) =>
  commands.exec(command, args, {
    ...options,
    signal: commandInterruption.signal,
  });
const finishCommandInterruption = () => {
  process.off("SIGINT", interruptOwnedCommand);
  process.off("SIGTERM", interruptOwnedCommand);
  return commandInterruption.signal.aborted
    ? commandInterruption.signal.reason
    : undefined;
};
const throwIfInterrupted = () => {
  if (commandInterruption.signal.aborted)
    throw commandInterruption.signal.reason;
};
// Analysis calls do not share the command process group. Stop waiting for them
// on interrupt, then let the existing cleanup run.
const untilInterrupted = (promise) =>
  new Promise((resolve, reject) => {
    if (commandInterruption.signal.aborted) {
      reject(commandInterruption.signal.reason);
      return;
    }
    const onAbort = () => reject(commandInterruption.signal.reason);
    commandInterruption.signal.addEventListener("abort", onAbort, {
      once: true,
    });
    Promise.resolve(promise).then(
      (value) => {
        commandInterruption.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause) => {
        commandInterruption.signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
const toolchain = {
  gcc: process.env.REA_GCC ?? "gcc",
  clang: process.env.REA_CLANG ?? "clang",
  nm: process.env.REA_NM ?? "nm",
  objdump: process.env.REA_OBJDUMP ?? "objdump",
  strip: process.env.REA_STRIP ?? "strip",
};
const versions = {};
try {
  for (const [role, command] of Object.entries(toolchain)) {
    try {
      const { stdout } = await execOwned(command, ["--version"]);
      versions[role] = stdout.split("\n")[0];
    } catch (cause) {
      if (commandInterruption.signal.aborted) throw cause;
      throw new Error(
        `Ghidra switch compiler lane prerequisite missing: ${role} '${command}'`,
        { cause },
      );
    }
  }
} catch (cause) {
  try {
    await commands.close();
  } catch (closeCause) {
    throw new AggregateError(
      [cause, closeCause],
      "Switch toolchain probe failed and command cleanup failed",
    );
  }
  throw cause;
}
let installation;
try {
  if (!compilerOnly) {
    const { inspectVerifierGhidraInstallation } =
      await import("./lib/ghidra-installation-inspection.mjs");
    assert.ok(
      process.env.GHIDRA_INSTALL_DIR,
      "Ghidra switch lane prerequisite missing: GHIDRA_INSTALL_DIR (bring your own)",
    );
    installation = await inspectVerifierGhidraInstallation({
      environment: process.env,
      installDir: process.env.GHIDRA_INSTALL_DIR,
      ...(process.env.JAVA_HOME === undefined
        ? {}
        : { javaHome: process.env.JAVA_HOME }),
    });
    assert.equal(
      installation.status,
      "available",
      JSON.stringify(installation),
    );
  }
} catch (cause) {
  try {
    await commands.close();
  } catch (closeCause) {
    throw new AggregateError(
      [cause, closeCause],
      "Switch prerequisite check failed and command cleanup failed",
    );
  }
  throw cause;
}
const run = createVerifierRun();
// Ghidra children use the workspace as TMPDIR; a plain root admits them on every host.
const workspaceFixture = await VerifierFixture.open({
  prefix: "rea-switch-proof-",
  private: false,
});
const workspace = workspaceFixture.path;
const retainWorkspace = (message, options) => {
  workspaceFixture.retain(message);
  return new Error(message, options);
};
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const source = join(workspace, "switch.c");
await writeFile(source, buildSwitchSource());
const flags = ["-O2", "-g", "-fno-pie", "-no-pie"];
const results = [];
let productionControls = null;
// The workspace is removed only once no owned runtime or process survives.
let lifecycle;
workspaceFixture.releaseAfter(async () => {
  assert.deepEqual(
    (await readdir(runtime)).filter((name) => name.startsWith("rea-ghidra-")),
    [],
    "Owned Ghidra runtime survived close",
  );
  lifecycle = await completeVerifierRun(run);
  assertVerifierCleanupComplete(lifecycle.process_lineage);
});
await withVerifierFixture(workspaceFixture, async () => {
  let primaryFailure;
  try {
    for (const compiler of ["gcc", "clang"]) {
      const original = join(workspace, `${compiler}-optimized`);
      await execOwned(toolchain[compiler], [
        ...flags,
        source,
        "-o",
        original,
      ]);
      const bytes = await readFile(original);
      const { stdout: symbols } = await execOwned(toolchain.nm, [
        "-n",
        original,
      ]);
      const { stdout: disassembly } = await execOwned(toolchain.objdump, [
        "-d",
        original,
      ]);
      const fixtures = assertCompiledSwitchOracle(
        bytes,
        switchSymbolOracle(symbols),
        disassembly,
      );
      const oracleFaultControls = assertSwitchOracleControls(fixtures);
      if (!compilerOnly && productionControls === null) {
        productionControls = await verifySwitchEvidenceControls({
          installation,
          entrypoint,
          target: original,
          workspace,
          runId: run.run_id,
        });
        assert.equal(
          digest(await readFile(original)),
          digest(bytes),
          "Guard changed compiler-oracled input",
        );
      }
      const stripped = join(workspace, `${compiler}-stripped`);
      await copyFile(original, stripped);
      await execOwned(toolchain.strip, ["--strip-all", stripped]);
      // Byte/physical target oracle survives removal of the names that REA could use.
      assertCompiledSwitchOracle(
        await readFile(stripped),
        fixtures,
        disassembly,
      );
      for (const [variant, path] of [
        ["optimized", original],
        ["stripped", stripped],
      ]) {
        const sha256 = digest(await readFile(path));
        const observation = compilerOnly
          ? null
          : await verifyTarget(path, sha256, fixtures, variant);
        assert.equal(
          digest(await readFile(path)),
          sha256,
          "REA analysis changed original compiled fixture",
        );
        results.push({
          compiler,
          variant,
          oracle_fault_controls: oracleFaultControls,
          sha256,
          compiler_oracle: fixtures.map(
            ({
              name,
              address,
              dispatch_address,
              table_address,
              slots,
              default_address,
            }) => ({
              name,
              address,
              dispatch_address,
              table_address,
              slots,
              default_address,
            }),
          ),
          observation,
        });
      }
    }
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
    throw retainWorkspace(
      `Switch verification failed; retained diagnostic workspace: ${workspace}`,
      {
        cause:
          cleanupFailure === undefined
            ? primaryFailure
            : primaryFailure === undefined
              ? cleanupFailure
              : new AggregateError(
                  [primaryFailure, cleanupFailure],
                  "Switch verification and command cleanup both failed",
                ),
      },
    );
  const interrupted = finishCommandInterruption();
  if (interrupted !== undefined)
    throw retainWorkspace(
      `Switch verification interrupted; retained diagnostic workspace: ${workspace}`,
      { cause: interrupted },
    );
});
process.stdout.write(
  `${JSON.stringify({ lane: "linux-x64-compiler-switch", compiler_only: compilerOnly, entrypoint, versions, compiler_flags: flags, verifier_run: lifecycle, production_controls: productionControls, results, limitations: ["Exact compiler oracle admits absolute 8-byte native x86-64 ELF tables and fails explicitly when a compiler changes lowering.", "Compiled binaries are analyzed read-only; target programs are never executed.", "Comparison-only control proves absence of a fabricated table and preservation of provider limitations, not recovery of C source.", "Detached Ghidra object controls exercise actual bridge methods through reflection; they do not claim naturally compiled ambiguous dispatches.", "CLI/MCP comparison covers switch observations, excluding process-specific Evidence IDs."], cleanup: "complete" })}\n`,
);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
async function verifyTarget(path, sha256, fixtures, variant) {
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
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-real-switch-proof", version: "1" });
  let opened = false;
  let stderr = "";
  const observations = [];
  return withVerifierCleanup(async () => {
    await untilInterrupted(
      client.connect(transport, { signal: commandInterruption.signal }),
    );
    transport.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    const target = await call(client, "open_binary", {
      path,
      provider_id: "ghidra",
    });
    opened = true;
    assert.equal(target.sha256, sha256);
    assert.equal(target.architecture, "x86_64");
    assert.equal(target.format, "elf");
    const procedures = await call(client, "list_procedures");
    for (const fixture of fixtures) {
      const observationFixture = {
        ...fixture,
        allow_unsigned_32_labels:
          variant === "stripped" && fixture.name === "negative",
      };
      const procedure = procedures.find(
        ({ address }) => address === fixture.address,
      );
      assert.ok(
        procedure,
        `Source-owned function at ${fixture.address} not discovered in optimized/stripped fixture`,
      );
      const observed = await toolResult(client, "inspect_native_api", {
        procedure: procedure.address,
      });
      assertWorkflowIdentity(observed, sha256);
      assert.equal(
        observed.normalized_result.procedure.address,
        procedure.address,
      );
      const summary = assertSwitchBoundary(
        observed.normalized_result.boundary,
        observationFixture,
      );
      assert.deepEqual(
        [...observed.normalized_result.residual_unknowns].sort(),
        expectedResidualUnknowns(
          observed.normalized_result.boundary,
          fixture,
        ).sort(),
        "Residual unknowns must preserve unresolved ABI types and exactly the expected switch uncertainty",
      );
      const cli = await cliSwitchEvidence(
        entrypoint,
        path,
        procedure.address,
        env,
      );
      assertWorkflowIdentity(cli, sha256);
      assert.equal(cli.normalized_result.procedure.address, procedure.address);
      assertSwitchBoundary(cli.normalized_result.boundary, observationFixture);
      assert.deepEqual(
        cli.normalized_result.boundary.jump_tables,
        observed.normalized_result.boundary.jump_tables,
        "CLI/MCP switch mappings/defaults/data-source evidence differ",
      );
      assert.deepEqual(
        cli.normalized_result.residual_unknowns,
        observed.normalized_result.residual_unknowns,
      );
      observations.push({
        name: fixture.name,
        ...summary,
        cli_mcp_equal: true,
        limitations: observed.normalized_result.boundary.limitations,
        residual_unknowns: observed.normalized_result.residual_unknowns,
        jump_tables: observed.normalized_result.boundary.jump_tables,
      });
    }
    return { observations, stderr };
  }, [
    async () => {
      if (opened) await call(client, "close_binary");
    },
    () => client.close(),
    () => transport.close(),
  ]);
}
function assertWorkflowIdentity(evidence, sha256) {
  assert.equal(evidence.subject.identity.sha256, sha256);
  assert.equal(evidence.operation, "inspect_native_api");
  assert.equal(evidence.provider.id, "rea-workflow");
  assert.equal(evidence.analysis_profile.provider.id, "rea-workflow");
  assert.equal(
    evidence.analysis_profile.parameters.upstream_analysis_profile.parameters
      .language_id,
    "auto-from-header",
  );
}

function expectedResidualUnknowns(boundary, fixture) {
  const unknowns = [boundary.return_type, ...boundary.parameters]
    .filter(({ confidence }) => confidence === "low")
    .map(
      ({ role, data_type: type }) =>
        `Can the inferred ${role} type ${type} be confirmed with imported metadata or an ABI probe?`,
    );
  if (fixture.unsafe_integer)
    unknowns.push(
      `Which source-level case values correspond to every target dispatched at ${boundary.jump_tables[0].dispatch_address}?`,
    );
  return [...new Set(unknowns)];
}
async function toolResult(client, name, arguments_ = {}) {
  throwIfInterrupted();
  const result = await client.callTool(
    { name, arguments: arguments_ },
    { timeout: 240000, signal: commandInterruption.signal },
  );
  assert.ok(result.structuredContent, `${name} omitted structured result`);
  return requireMcpOutput(result, name);
}
async function call(client, name, arguments_ = {}) {
  throwIfInterrupted();
  const result = await client.callTool(
    { name, arguments: arguments_ },
    { timeout: 240000, signal: commandInterruption.signal },
  );
  return requireMcpOperationResult(result, name);
}

async function cliSwitchEvidence(entrypoint, path, procedure, env) {
  const { stdout } = await execOwned(
    process.execPath,
    [
      entrypoint,
      "inspect-native-api",
      path,
      procedure,
      "--provider",
      "ghidra",
      "--json",
    ],
    { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
