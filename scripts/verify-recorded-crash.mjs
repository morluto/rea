#!/usr/bin/env node
import assert from "node:assert/strict";
import { writeFile, readFile, copyFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateRuntimeRoot } from "../dist/process/PrivateRuntimeRoot.js";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { verifyCompleteToolCatalog } from "./lib/verify-package-core.mjs";
import { connectRecordedCrash } from "./verify/recorded-crash/public.mjs";
import {
  createRecordedCore,
  fixtureCommand,
  startCoreSentinel,
} from "./verify/recorded-crash/fixtures.mjs";
import { verifyCoreInspectionTrace } from "./verify/recorded-crash/trace.mjs";

const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
environment.REA_PWNDBG_GDB ??= "/usr/bin/gdb";
for (const key of [
  "REA_PWNTOOLS_PYTHON",
  "REA_PWNDBG_GDB",
  "REA_PWNDBG_GDBINIT",
  "REA_PWNDBG_VENV_PATH",
  "REA_VERIFY_STRACE_COMMAND",
])
  if (!isAbsolute(environment[key] ?? ""))
    throw new Error(
      `verify:recorded:crash requires absolute ${key}; see docs/recorded-crashes.md. No dependencies are installed by this verifier.`,
    );
if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("verify:recorded:crash requires Linux x64.");
const run = createVerifierRun();
environment.REA_PROCESS_RUN_ID = run.run_id;
const root = await PrivateRuntimeRoot.create({ prefix: "rea-core-verifier-" });
const options = { root: root.path, environment, runId: run.run_id };
const entrypoint =
  process.argv[2] ?? fileURLToPath(new URL("./rea.mjs", import.meta.url));
const failures = [];
const sessions = [];
let sentinel;
let cases = 0;
let trace;
let catalogTools;
try {
  for (const [command, args] of [
    ["gcc", ["--version"]],
    [environment.REA_PWNDBG_GDB, ["--version"]],
    [environment.REA_VERIFY_STRACE_COMMAND, ["-V"]],
  ]) {
    try {
      await fixtureCommand(command, args, options);
    } catch (cause) {
      throw new Error(
        `verify:recorded:crash prerequisite unavailable: ${command}`,
        { cause },
      );
    }
  }
  const core = await createRecordedCore(options);
  sentinel = await startCoreSentinel(options);
  sentinel.assertAlive();
  const fixtures = JSON.parse(
    await fixtureCommand(
      environment.REA_PWNTOOLS_PYTHON,
      [
        "-I",
        fileURLToPath(
          new URL("./lib/recorded-core-fixtures.py", import.meta.url),
        ),
        core,
        root.path,
        String(sentinel.pid),
      ],
      options,
    ),
  );
  const spaced = join(root.path, "recording with spaces.core");
  await copyFile(core, spaced);
  const basic = await connectRecordedCrash({ entrypoint, environment });
  sessions.push(basic);
  const advertised = (await basic.client.listTools()).tools;
  assert.equal(
    advertised.filter((tool) => tool.name === "inspect_recorded_crash").length,
    1,
  );
  const catalog = await verifyCompleteToolCatalog(basic.client, {
    timeout: 90_000,
  });
  for (const name of [
    "inspect_binary_layout",
    "inspect_recorded_crash",
    "inspect_evm_interface",
  ])
    assert.ok(catalog.includes(name));
  catalogTools = catalog.length;
  for (const mode of ["cli", "mcp"]) {
    const report = await basic.inspect(mode, spaced);
    assert.equal(report.threads.length, 2);
    assert.ok(
      report.threads.some((thread) =>
        thread.registers.some(
          (register) =>
            register.name === "rdi" && register.value === "0x1122334455667788",
        ),
      ),
    );
    assert.ok(
      report.threads.some((thread) =>
        thread.registers.some(
          (register) =>
            register.name === "r12" && register.value === "0xfedcba9876543210",
        ),
      ),
    );
    assert.ok(
      report.signals.some(
        (signal) =>
          signal.number === 11 &&
          signal.code === 1 &&
          signal.fault_address === "0x123",
      ),
    );
    assert.ok(
      report.signals.some(
        (signal) => signal.code === -6 && signal.fault_address === null,
      ),
    );
    cases++;
    const enriched = await basic.inspect(mode, spaced, {
      debuggerContext: true,
    });
    assert.deepEqual(enriched.threads, report.threads);
    assert.deepEqual(enriched.notes, report.notes);
    assert.ok(enriched.debugger.pwndbg_version.startsWith("2026.09.15"));
    assert.equal(enriched.debugger.connection, "core");
    assert.equal(enriched.debugger.executable, null);
    assert.ok(enriched.debugger.maps.length > 0);
    assert.ok(
      enriched.debugger.maps.every(
        (map) => map.reported_flags !== 0 || map.permissions === null,
      ),
    );
    assert.ok(
      enriched.debugger.maps.every(
        (map) => map.current_file_identity === "unknown",
      ),
    );
    assert.ok(
      enriched.debugger.reported_limits.address_space_bytes <= 3 * 1024 ** 3,
    );
    assert.ok(enriched.debugger.reported_limits.cpu_seconds <= 30);
    assert.ok(
      enriched.debugger.reported_limits.file_size_bytes <= 64 * 1024 ** 2,
    );
    assert.ok(enriched.diagnostics.stdout.includes("[core decoder]"));
    assert.equal(enriched.decoder_diagnostics.truncated, false);
    cases++;
    for (const name of [
      "truncated-header",
      "truncated-status",
      "truncated-owner",
    ]) {
      await basic.inspect(mode, fixtures[name], { category: "invalid_input" });
      cases++;
    }
    const opaque = await basic.inspect(mode, fixtures["opaque-owner"]);
    assert.ok(
      opaque.notes.some(
        (note) => Buffer.from(note.owner_bytes_base64, "base64")[0] === 255,
      ),
    );
    assert.equal(opaque.threads.length, 1);
    cases++;
    const noSignals = await basic.inspect(mode, fixtures["unknown-signals"]);
    assert.equal(noSignals.signals.length, 0);
    assert.equal(noSignals.threads.length, 2);
    cases++;
    const noNotes = await basic.inspect(mode, fixtures["missing-notes"]);
    assert.equal(noNotes.notes.length, 0);
    assert.equal(noNotes.threads.length, 0);
    assert.equal(noNotes.note_interpretation_completeness, "unknown");
    cases++;
    const negative = await basic.inspect(mode, fixtures["negative-pid"]);
    assert.ok(negative.threads.some((thread) => thread.historical_pid === -2));
    cases++;
    const collision = await basic.inspect(
      mode,
      fixtures["historical-pid-collision"],
      { debuggerContext: true },
    );
    assert.ok(
      collision.threads.some(
        (thread) => thread.historical_pid === sentinel.pid,
      ),
    );
    sentinel.assertAlive();
    cases++;
  }
  for (const [name, changes] of [
    ["missing", { REA_PWNDBG_GDBINIT: join(root.path, "missing-plugin.py") }],
    [
      "wrong-profile",
      { REA_PWNDBG_GDBINIT: join(root.path, "wrong-profile.py") },
    ],
  ]) {
    if (name === "wrong-profile") {
      // Source-owned failure injection changes only the in-memory reported version.
      // The selected upstream checkout and its installed files remain unchanged.
      await writeFile(
        changes.REA_PWNDBG_GDBINIT,
        `from pathlib import Path\nentry = ${JSON.stringify(environment.REA_PWNDBG_GDBINIT)}\nexec(compile(Path(entry).read_bytes(), entry, 'exec'), {'__name__': '__main__', '__file__': entry})\nimport pwndbg.lib.version\npwndbg.lib.version.__version__ = '0.0.0-source-owned'\n`,
      );
    }
    const session = await connectRecordedCrash({
      entrypoint,
      environment: { ...environment, ...changes },
    });
    sessions.push(session);
    for (const mode of ["cli", "mcp"]) {
      const error = await session.inspect(mode, core, {
        debuggerContext: true,
        category: "unsupported_provider",
      });
      assert.ok(
        JSON.stringify(error).includes(
          name === "missing" ? "REA_PWNDBG_GDBINIT" : "source-owned",
        ),
      );
      cases++;
    }
  }
  const executableCarrier = join(root.path, "executable-as-core");
  const executableBytes = Buffer.from(await readFile(core));
  executableBytes.writeUInt16LE(2, 16);
  await writeFile(executableCarrier, executableBytes);
  for (const mode of ["cli", "mcp"]) {
    const error = await basic.inspect(mode, executableCarrier, {
      category: "unsupported_target",
    });
    assert.ok(JSON.stringify(error).includes("ET_CORE"));
    cases++;
  }
  trace = await verifyCoreInspectionTrace({
    ...options,
    entrypoint,
    core: fixtures["historical-pid-collision"],
    sentinel,
  });
  cases += trace.length;
  assert.ok((await readFile(core)).length > 0);
} catch (cause) {
  failures.push(cause);
} finally {
  for (const close of [
    ...sessions.map((session) => () => session.close()),
    ...(sentinel ? [() => sentinel.close()] : []),
    () => root.close(),
  ]) {
    try {
      await close();
    } catch (cause) {
      failures.push(cause);
    }
  }
}
const verifier = await completeVerifierRun(run);
try {
  assert.equal(verifier.process_lineage.status, "verified");
  assert.deepEqual(verifier.process_lineage.descendants, []);
} catch (cause) {
  failures.push(cause);
}
const result = {
  status: failures.length === 0 ? "passed" : "failed",
  public_cases: cases,
  catalog_tools: catalogTools,
  profile:
    "Linux x64; pwntools4.15.0/pyelftools0.33/Unicorn2.1.2; core-only BYO GDB/pwndbg2026.09.15",
  fixture_generation: "owned test program executed",
  inspection_trace: trace,
  verifier,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0)
  throw new AggregateError(
    failures,
    "Recorded crash verification failed; cleanup failures are retained.",
  );
