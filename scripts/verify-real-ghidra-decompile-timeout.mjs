import { AnalysisSettings } from "../dist/application/AnalysisSettings.js";
import { runtimeAnalysisConfig } from "../dist/config/runtimeAnalysisSettings.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { parseConfig } from "../dist/config/parseConfig.js";
import { projectAnalysisError } from "../dist/domain/analysisErrorProjection.js";
import { GhidraClient } from "../dist/ghidra/GhidraClient.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { SUPPORTED_GHIDRA_VERSION } from "../dist/ghidra/GhidraReleasePolicy.js";
import { GhidraProvider } from "../dist/ghidra/GhidraProvider.js";
import { silentLogger } from "../dist/logger.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../dist/process/OwnedCommand.js";
import {
  assertVerifierCleanupComplete,
  completeVerifierRun,
  createVerifierRun,
} from "./lib/verifier-run.mjs";

// Volatile straight-line work produces a natural native response above 1 MiB
// and a decompile above one second, without the old branch-heavy fixture.
// Admit the generated source before allocating its line array.
const LIMIT_SECONDS = 1;
const RECOVERY_SECONDS = 20;
const FIXTURE_SOURCE_BYTES = 1024 * 1024;
const FIXTURE_PREFIX = [
  "volatile unsigned rea_state[128];",
  "__attribute__((noinline, used)) unsigned rea_small(unsigned x) {",
  "  unsigned a = x + rea_state[0];",
  "  unsigned b = a ^ rea_state[1];",
  "  return b + (a * 3u);",
  "}",
  "__attribute__((noinline, used)) unsigned rea_slow(unsigned x) {",
  "  unsigned a = x;",
];
const FIXTURE_SUFFIX = ["  return a;", "}", ""];
const MAX_STATEMENT_BYTES = Buffer.byteLength(
  `  a += rea_state[127] ^ (x + ${Number.MAX_SAFE_INTEGER}u); rea_state[127] = a;\n`,
);
const FIXTURE_FIXED_BYTES = Buffer.byteLength(
  [...FIXTURE_PREFIX, ...FIXTURE_SUFFIX].join("\n"),
);
const MAX_STATEMENTS = Math.floor(
  (FIXTURE_SOURCE_BYTES - FIXTURE_FIXED_BYTES) / MAX_STATEMENT_BYTES,
);
const STATEMENTS = Number(process.env.REA_DECOMPILE_TIMEOUT_STATEMENTS ?? 5400);
assert.ok(
  Number.isSafeInteger(STATEMENTS) &&
    STATEMENTS > 0 &&
    STATEMENTS <= MAX_STATEMENTS,
  `REA_DECOMPILE_TIMEOUT_STATEMENTS must be an integer from 1 to ${MAX_STATEMENTS} (generated source budget: ${FIXTURE_SOURCE_BYTES} bytes)`,
);
const fixtureSource = () => {
  const lines = [...FIXTURE_PREFIX];
  for (let index = 0; index < STATEMENTS; index += 1)
    lines.push(
      `  a += rea_state[${index % 128}] ^ (x + ${index}u); rea_state[${(index * 7) % 128}] = a;`,
    );
  lines.push(...FIXTURE_SUFFIX);
  const source = lines.join("\n");
  assert.ok(Buffer.byteLength(source) <= FIXTURE_SOURCE_BYTES);
  return source;
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const value = (result) => {
  if (!result.ok) throw result.error;
  return result.value;
};
const flowSummary = (flow) => ({
  available: flow.available,
  operations: flow.operations?.length,
  largest_input_count: flow.operations?.reduce(
    (largest, operation) => Math.max(largest, operation.inputs.length),
    0,
  ),
  def_use_edges: flow.def_use?.length,
  parameter_uses: flow.parameter_uses?.length,
  truncated: flow.truncated,
  limits: flow.limits,
  limits_reached: flow.limits_reached,
  omitted_operations_lower_bound: flow.omitted_operations_lower_bound,
  known_omitted_inputs: flow.known_omitted_inputs,
  known_omitted_edges: flow.known_omitted_edges,
});

const run = createVerifierRun();
assert.ok(
  process.platform === "linux" || process.platform === "darwin",
  "This regression lane requires Linux or macOS",
);
const environment = {
  ...process.env,
  GHIDRA_HEADLESS_MAXMEM:
    process.env.GHIDRA_HEADLESS_MAXMEM || process.env.GHIDRA_MAXMEM || "1G",
  REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS: String(RECOVERY_SECONDS),
};
const settings = new AnalysisSettings(environment);
const config = value(parseConfig(environment));
const installation = await inspectVerifierGhidraInstallation({
  environment,
  installDir: config.ghidraInstallDir,
  javaHome: config.ghidraJavaHome,
});
assert.equal(installation.status, "available", JSON.stringify(installation));
assert.equal(installation.providerVersion, SUPPORTED_GHIDRA_VERSION);

const workspace = await mkdtemp(
  join(tmpdir(), "rea-ghidra-decompile-timeout-"),
);
const began = performance.now();
const controller = new AbortController();
const outerDeadline = setTimeout(
  () => controller.abort(new Error("Ghidra verifier exceeded 180000 ms")),
  180_000,
);
outerDeadline.unref();
let cleaned = true;
let report;
try {
  const sourcePath = join(workspace, "slow-decompile.c");
  const source = fixtureSource();
  await writeFile(sourcePath, source);
  const targetPath = join(
    workspace,
    process.platform === "darwin"
      ? "slow-decompile.dylib"
      : "slow-decompile.so",
  );
  const compiler = {
    command: process.env.REA_CC ?? "cc",
    arguments: [
      ...(process.platform === "darwin" ? ["-dynamiclib"] : ["-shared"]),
      "-fPIC",
      "-O0",
      sourcePath,
      "-o",
      targetPath,
    ],
  };
  cleaned = false;
  try {
    await runOwnedCommand(
      { ...compiler, runId: run.run_id, expectedCommand: null },
      {
        timeoutMs: 30_000,
        diagnosticBytes: 64 * 1024,
        signal: controller.signal,
      },
    );
    cleaned = true;
  } catch (cause) {
    cleaned =
      cause instanceof OwnedCommandFailure && cause.cleanupOwner === undefined;
    throw cause;
  }
  const targetDigest = digest(await readFile(targetPath));
  let bridgeClient;
  const provider = new GhidraProvider(
    runtimeAnalysisConfig(config, settings.read),
    silentLogger,
    environment,
    undefined,
    (options) => {
      assert.equal(options.runId, undefined);
      bridgeClient = new GhidraClient({
        ...options,
        transport: "authenticated-loopback-tcp",
      });
      return bridgeClient;
    },
  );
  const target = value(await parseBinaryTarget(targetPath));
  const profile = value(await provider.resolveAnalysisProfile(target));
  assert.ok(profile.profile);
  const client = provider.createClient(target, profile.profile);
  const execute = (operation, input) =>
    settings.run(() =>
      client.execute(operation, input, { signal: controller.signal }),
    );
  const update = (changes) =>
    value(
      settings.update({
        changes: changes.map(([setting, selected]) => ({
          setting,
          action: "set",
          value: selected,
        })),
      }),
    );
  const observed = { stages: [] };
  const record = (stage, facts) => observed.stages.push({ stage, ...facts });
  const failures = [];
  cleaned = false;
  try {
    const listed = value(await execute("list_procedures", {}));
    const entry = (name) => {
      const found = listed.result.find(
        (item) => item.value === name || item.value === `_${name}`,
      );
      assert.ok(found, `Missing fixture function ${name}`);
      return found.address;
    };
    const smallEntry = entry("rea_small");
    const slowEntry = entry("rea_slow");
    const initial = value(
      await bridgeClient.ping({ signal: controller.signal }),
    );
    assert.equal(initial.target.sha256, targetDigest);
    observed.initial_session_run_id = initial.run_id;
    const flow = async () =>
      value(await execute("analyze_function", { procedure: smallEntry })).result
        .native_value_flow;

    update([["ghidra.value_flow_max_operations", 1]]);
    const operationsLow = await flow();
    assert.equal(operationsLow.operations.length, 1);
    assert.ok(operationsLow.limits_reached.includes("max_operations"));
    record("operations_low", flowSummary(operationsLow));
    update([["ghidra.value_flow_max_operations", 3000]]);
    const complete = await flow();
    assert.equal(complete.truncated, false);
    assert.ok(complete.operations.length > 2);
    record("operations_recovered", flowSummary(complete));

    update([["ghidra.value_flow_max_inputs_per_operation", 1]]);
    const inputsLow = await flow();
    assert.ok(inputsLow.known_omitted_inputs > 0);
    assert.ok(inputsLow.limits_reached.includes("max_inputs_per_operation"));
    record("inputs_low", flowSummary(inputsLow));
    update([["ghidra.value_flow_max_inputs_per_operation", 64]]);
    const inputsRecovered = await flow();
    assert.equal(inputsRecovered.truncated, false);
    record("inputs_recovered", flowSummary(inputsRecovered));

    update([["ghidra.value_flow_max_edges", 1]]);
    const edgesLow = await flow();
    assert.ok(edgesLow.known_omitted_edges > 0);
    assert.ok(edgesLow.limits_reached.includes("max_edges"));
    record("edges_low", flowSummary(edgesLow));
    update([["ghidra.value_flow_max_edges", 12000]]);
    const edgesRecovered = await flow();
    assert.equal(edgesRecovered.truncated, false);
    assert.ok(edgesRecovered.def_use.length > 1);
    record("edges_recovered", flowSummary(edgesRecovered));

    update([["ghidra.value_flow_max_operations", 2]]);
    const lowered = await flow();
    assert.equal(lowered.operations.length, 2);
    assert.ok(lowered.limits_reached.includes("max_operations"));
    record("operations_lowered", flowSummary(lowered));
    update([
      ["ghidra.value_flow_max_operations", 3000],
      ["ghidra.decompile_max_payload_mib", 1],
    ]);

    let started = performance.now();
    const payloadLow = await execute("procedure_pseudo_code", {
      procedure: slowEntry,
    });
    assert.equal(
      payloadLow.ok,
      false,
      "Fixture did not exhaust the 1 MiB payload allowance; calibrate REA_DECOMPILE_TIMEOUT_STATEMENTS rather than reporting a provider failure.",
    );
    const payloadError = projectAnalysisError(payloadLow.error);
    assert.ok(
      payloadError.message.includes("Response buffer size exceeded"),
      payloadError.message,
    );
    assert.ok(
      payloadError.message.includes("ghidra.decompile_max_payload_mib"),
    );
    record("payload_1_mib", {
      seconds: (performance.now() - started) / 1000,
      code: payloadError.code,
      message: payloadError.message,
    });
    update([["ghidra.decompile_max_payload_mib", 64]]);
    started = performance.now();
    const payloadRecovered = value(
      await execute("procedure_pseudo_code", { procedure: slowEntry }),
    );
    assert.ok(String(payloadRecovered.result).includes("rea_state"));
    record("payload_64_mib_recovered", {
      seconds: (performance.now() - started) / 1000,
      pseudocode_bytes: Buffer.byteLength(String(payloadRecovered.result)),
    });

    update([["ghidra.decompile_timeout_seconds", LIMIT_SECONDS]]);
    const limitText = `exceeded the ${LIMIT_SECONDS}-second configured decompilation limit`;
    started = performance.now();
    const degraded = value(
      await execute("analyze_function", { procedure: slowEntry }),
    );
    const dossier = degraded.result;
    assert.equal(
      dossier.facet_availability.pseudocode.available,
      false,
      "Fixture completed within the one-second native deadline; calibrate REA_DECOMPILE_TIMEOUT_STATEMENTS rather than reporting a provider failure.",
    );
    assert.ok(dossier.facet_availability.pseudocode.reason.includes(limitText));
    assert.equal(dossier.native_api.available, false);
    assert.equal(dossier.native_value_flow.available, false);
    assert.ok(dossier.assembly.length > STATEMENTS);
    assert.ok(dossier.basic_blocks.length > 0);
    assert.equal(degraded.cachePolicy, "live");
    record("deadline_partial_dossier", {
      seconds: (performance.now() - started) / 1000,
      pseudocode: dossier.facet_availability.pseudocode,
      assembly_lines: dossier.assembly.length,
      basic_blocks: dossier.basic_blocks.length,
      cache_policy: degraded.cachePolicy,
    });

    started = performance.now();
    const timedOut = await execute("procedure_pseudo_code", {
      procedure: slowEntry,
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.error._tag, "AnalysisTimeoutError");
    const timeout = projectAnalysisError(timedOut.error);
    assert.equal(timeout.code, "provider_timeout");
    assert.equal(timeout.retryable, true);
    assert.equal(timeout.details.timeout_ms, 1000);
    assert.equal(
      timeout.details.limit.setting,
      "ghidra.decompile_timeout_seconds",
    );
    assert.equal(timeout.details.limit.scope, "rea-runtime");
    assert.ok(timeout.message.includes(limitText), timeout.message);
    record("deadline_pseudocode", {
      seconds: (performance.now() - started) / 1000,
      code: timeout.code,
      message: timeout.message,
      limit: timeout.details.limit,
      remediation: timeout.remediation,
    });

    update([
      ["ghidra.decompile_timeout_seconds", RECOVERY_SECONDS],
      ["ghidra.decompile_max_payload_mib", null],
    ]);
    started = performance.now();
    const recovered = value(
      await execute("procedure_pseudo_code", { procedure: slowEntry }),
    );
    assert.ok(String(recovered.result).includes("rea_state"));
    record("deadline_recovered_payload_null", {
      seconds: (performance.now() - started) / 1000,
      selected_timeout_seconds: RECOVERY_SECONDS,
      selected_payload_mib: null,
      pseudocode_bytes: Buffer.byteLength(String(recovered.result)),
    });
    const small = value(
      await execute("procedure_pseudo_code", { procedure: smallEntry }),
    );
    assert.ok(String(small.result).includes("rea_state"));
    const final = value(await bridgeClient.ping({ signal: controller.signal }));
    assert.equal(final.run_id, initial.run_id);
    assert.equal(final.target.sha256, targetDigest);
    observed.final_session_run_id = final.run_id;
    observed.same_session_next_decompile = "succeeded";
  } catch (cause) {
    failures.push(cause);
  }
  const closed = await client.close();
  if (!closed.ok) failures.push(closed.error);
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "Ghidra runtime budget verification failed",
    );
  assert.equal(digest(await readFile(targetPath)), targetDigest);
  const verifierRun = await completeVerifierRun(run);
  assertVerifierCleanupComplete(verifierRun.process_lineage);
  cleaned = true;
  report = {
    status: "passed",
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    fixture: {
      kind: "volatile-straight-line",
      statements: STATEMENTS,
      source_bytes: Buffer.byteLength(source),
    },
    target_sha256: targetDigest,
    source_sha256: digest(Buffer.from(source)),
    compiler,
    provider: profile.profile.provider,
    analysis_profile_digest: profile.profile.digest,
    configured_jvm_max_heap: environment.GHIDRA_HEADLESS_MAXMEM,
    elapsed_seconds: (performance.now() - began) / 1000,
    ...observed,
    verifier_run: verifierRun,
    scope:
      "Real Ghidra analysis of generated Mach-O/ELF through authenticated loopback: independent value-flow budgets, lowered admission, native payload exhaustion and recovery, natural decompile timeout with listing-backed partial facts, and deadline recovery on the same Program. No target execution. Windows and public CLI/MCP transport recovery are unverified. Timings are observations, not performance comparisons; CPU, peak process-family memory and agent tokens are unmeasured.",
  };
} finally {
  clearTimeout(outerDeadline);
  if (cleaned) await rm(workspace, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...report, cleanup: "complete" }));
