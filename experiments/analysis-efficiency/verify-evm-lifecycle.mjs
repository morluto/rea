import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    revision: { type: "string" },
    path: { type: "string" },
    "peer-path": { type: "string" },
    providers: { type: "string" },
    output: { type: "string" },
  },
});
for (const key of ["runtime-root", "path", "peer-path", "providers", "output"])
  assert.ok(isAbsolute(values[key] ?? ""), "Supply --" + key + " ABS");
assert.match(values.revision ?? "", /^[a-f0-9]{40}$/u);
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.notEqual(
  process.getuid(),
  0,
  "Permission faults require a non-root user",
);
const runtime = values["runtime-root"],
  lab = values.output;
const providers = z
  .record(z.string(), z.string())
  .parse(JSON.parse(await readFile(values.providers, "utf8")));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileSha = async (path) => {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
};
const sourceBefore = await fileSha(new URL(import.meta.url));
const targetBefore = await fileSha(values.path);
const peerBefore = await fileSha(values["peer-path"]);
const corpus = JSON.parse(
  await readFile(new URL("./corpus.json", import.meta.url)),
);
assert.ok(corpus.artifacts.some((x) => x.sha256 === targetBefore));
assert.equal(
  corpus.artifacts.find((x) => x.id === "sqlite.wasm").sha256,
  peerBefore,
);
const load = (path) => import(pathToFileURL(join(runtime, "dist", path)));
const { toolContract } = await load("contracts/toolContracts.js");
const { analysisErrorProjectionSchema } = await load(
  "contracts/errorSchemas.js",
);
const { parseEvidence } = await load("domain/evidence.js");
const { evmoleInterfaceReplySchema } = await load(
  "evm/EvmoleInterfaceAdapter.js",
);
const {
  observeOwnedProcessLineage,
  observeProcessStartIdentity,
  systemProcessOwnershipHost: host,
} = await load("process/ProcessOwnershipObservation.js");
const { verifyNoTokenOwnedProcesses } = await load(
  "process/ProcessOwnership.js",
);
const { createVerifierRun, completeVerifierRun } = await import(
  pathToFileURL(join(runtime, "scripts/lib/verifier-run.mjs"))
);
const run = createVerifierRun();
await mkdir(lab, { mode: 0o700 });
const runtimeFiles = [];
const fingerprint = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await fingerprint(path);
    else if (entry.isFile())
      runtimeFiles.push({
        path: path.slice(runtime.length + 1),
        sha256: await fileSha(path),
      });
    else throw new Error("Runtime fingerprint must not follow symlinks");
  }
};
await fingerprint(join(runtime, "dist"));
await fingerprint(join(runtime, "bridge"));
runtimeFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
await writeFile(join(lab, "runtime-files.json"), JSON.stringify(runtimeFiles), {
  flag: "wx",
  mode: 0o600,
});
const work = join(lab, "temporary");
await mkdir(work, { mode: 0o700 });
const wrapper = join(lab, "gated-prlimit.mjs");
// Only gate command completion AFTER unchanged EVMole has produced its reply.
// This does not measure interruption inside its synchronous WASM computation.
await writeFile(
  wrapper,
  `#!${process.execPath}
import { spawn } from "node:child_process";
import { access, appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const gate = process.env.REA_VERIFY_EVM_GATE;
await appendFile(join(gate, "launches.log"), process.cwd() + "\\n", { mode: 0o600 });
const child = spawn("/usr/bin/prlimit", process.argv.slice(2), { stdio: "inherit" });
const code = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => signal ? reject(new Error(signal)) : resolve(code));
});
if (code !== 0) process.exit(code ?? 1);
if (await readFile(join(gate, "mode"), "utf8") === "hold") {
  await writeFile(join(gate, "ready.pending.json"), JSON.stringify({
    pid: process.pid, parent_pid: process.ppid, run_id: process.env.REA_PROCESS_RUN_ID,
    root: process.cwd(), worker_exit: code,
  }), { flag: "wx", mode: 0o600 });
  await rename(join(gate, "ready.pending.json"), join(gate, "ready.json"));
  const end = Date.now() + 15000;
  for (;;) {
    try { await access(join(gate, "release")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (Date.now() >= end) throw new Error("Verification gate exceeded 15 seconds");
    await delay(25);
  }
}
`,
  { flag: "wx", mode: 0o700 },
);
const markerSchema = z.strictObject({
  pid: z.number().int().positive(),
  parent_pid: z.number().int().positive(),
  run_id: z.string().regex(/^rea-evm-interface-[a-f0-9-]+$/u),
  root: z.string(),
  worker_exit: z.literal(0),
});
const roots = async () =>
  (await readdir(work)).filter((x) => x.startsWith("rea-evm-interface-"));
const gateMode = async (mode) => {
  await rm(join(lab, "ready.json"), { force: true });
  await rm(join(lab, "ready.pending.json"), { force: true });
  await rm(join(lab, "release"), { force: true });
  await writeFile(join(lab, "mode"), mode, { mode: 0o600 });
};
await gateMode("off");
const client = new Client({ name: "rea-real-evm-lifecycle", version: "1" });
const environment = {
  ...process.env,
  ...providers,
  TMPDIR: work,
  REA_EVM_PRLIMIT_COMMAND: wrapper,
  REA_VERIFY_EVM_GATE: lab,
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(runtime, "scripts/rea.mjs"), "mcp"],
  env: environment,
  stderr: "pipe",
});
const rows = [];
let fault;
const textValue = (reply) =>
  JSON.parse(reply.content.find((x) => x.type === "text").text);
const errorValue = (reply) => {
  assert.equal(reply.isError, true);
  return analysisErrorProjectionSchema.parse(textValue(reply).error);
};
const evidenceValue = (reply, name) => {
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return parseEvidence(
    toolContract(name).outputSchema.parse(reply.structuredContent),
  );
};
const request = (path = values.path, signal) =>
  client.callTool(
    {
      name: "inspect_evm_interface",
      arguments: { path, encoding: "hex" },
    },
    { timeout: 45000, ...(signal === undefined ? {} : { signal }) },
  );
const waitFor = async (probe, message, milliseconds = 10000) => {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await delay(50);
  }
  throw new Error(message);
};
const observeGate = async (expectedSuccess) => {
  const marker = await waitFor(async () => {
    try {
      return markerSchema.parse(
        JSON.parse(await readFile(join(lab, "ready.json"))),
      );
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }, "No completed real worker at the pending command gate");
  assert.equal(marker.root.startsWith(work + "/rea-evm-interface-"), true);
  const rootStat = await lstat(marker.root);
  assert.equal(rootStat.isDirectory(), true);
  assert.equal(rootStat.uid, process.getuid());
  const processRow = (await host.listProcesses()).find(
    (x) => x.pid === marker.pid,
  );
  assert.ok(processRow, "Gated owned launcher already exited");
  const ownership = {
    runId: marker.run_id,
    leaderPid: marker.pid,
    processGroupId: processRow.processGroupId,
    expectedParentPid: marker.parent_pid,
  };
  const lineage = await observeOwnedProcessLineage(ownership);
  assert.equal(lineage.status, "verified", JSON.stringify(lineage));
  const identity = await observeProcessStartIdentity(
    marker.pid,
    undefined,
    marker.run_id,
  );
  assert.equal(identity?.state, "readable");
  const rawBytes = await readFile(join(marker.root, "reply.json"));
  const raw = JSON.parse(rawBytes);
  assert.equal(raw.ok, expectedSuccess);
  if (raw.ok) {
    assert.equal(raw.version, "0.9.3");
    evmoleInterfaceReplySchema.parse(raw.raw);
  } else assert.equal(raw.reason, "format");
  return {
    marker,
    ownership,
    lineage,
    identity,
    root_mode: rootStat.mode & 0o777,
    worker_reply_sha256: sha(rawBytes),
    worker_reply: raw,
  };
};
const confirmCleanup = async (launch, baseline, absentRoot) =>
  waitFor(async () => {
    const result = await verifyNoTokenOwnedProcesses(
      launch.marker.run_id,
      undefined,
      baseline,
      {
        leaderPid: launch.ownership.leaderPid,
        processGroupId: launch.ownership.processGroupId,
      },
    );
    if (!result.cleaned) return;
    if (absentRoot && (await roots()).length !== 0) return;
    return result;
  }, "Owned EVM cleanup not verified");
const peer = async () =>
  evidenceValue(
    await client.callTool(
      {
        name: "inspect_wasm_artifact",
        arguments: {
          path: values["peer-path"],
          glue_paths: [],
          candidate_paths: [],
          detail: "summary",
        },
      },
      { timeout: 45000 },
    ),
    "inspect_wasm_artifact",
  );
const restore = async () => {
  if (fault === undefined) return;
  await chmod(fault.path, fault.mode);
  fault = undefined;
};
const verifyWithCleanup = async (verify, cleanups) => {
  const failures = [];
  let value;
  try {
    value = await verify();
  } catch (error) {
    failures.push(error);
  }
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Verification or cleanup failed");
  return value;
};
const verifyLateCancellation = async (original) => {
  const baseline = await host.captureBaseline();
  await gateMode("hold");
  const controller = new AbortController();
  let settled = false;
  const pending = request(values.path, controller.signal).then(
    (reply) => {
      settled = true;
      return { reply };
    },
    (error) => {
      settled = true;
      return {
        error: { name: error.name, code: error.code, message: error.message },
      };
    },
  );
  let launch;
  try {
    launch = await observeGate(true);
    assert.deepEqual(launch.worker_reply.raw, original.raw_result);
    assert.deepEqual(launch.worker_reply.bytecode, {
      sha256: original.normalized_result.bytecode.sha256,
      bytes: original.normalized_result.bytecode.bytes,
      hex: original.normalized_result.bytecode.hex,
    });
    assert.equal(settled, false, "Request completed before SDK cancellation");
  } finally {
    controller.abort(
      new Error("Late real EVM worker cancellation verification"),
    );
    await pending;
  }
  const canceled = await pending;
  assert.equal(canceled.error?.code, "REQUEST_TIMEOUT");
  const cleanup = await confirmCleanup(launch, baseline, true);
  await assert.rejects(access(launch.marker.root), { code: "ENOENT" });
  await gateMode("off");
  const recovered = evidenceValue(await request(), "inspect_evm_interface");
  assert.deepEqual(recovered.normalized_result, original.normalized_result);
  return {
    scenario: "late-cancellation",
    launch,
    canceled,
    cleanup,
    recovery_evidence_id: recovered.evidence_id,
  };
};
await verifyWithCleanup(async () => {
  await client.connect(transport);
  const catalog = await client.listTools();
  assert.equal(
    catalog.tools.filter((x) => x.name === "inspect_evm_interface").length,
    1,
  );
  const original = evidenceValue(await request(), "inspect_evm_interface");
  assert.equal(original.subject.digest.sha256, targetBefore);
  assert.equal(original.provider.version, "evmole@0.9.3");
  const cli = await promisify(execFile)(
    process.execPath,
    [
      join(runtime, "scripts/rea.mjs"),
      "inspect-evm-interface",
      values.path,
      "hex",
      "--json",
    ],
    { env: environment, timeout: 45000, maxBuffer: 32 * 1024 * 1024 },
  );
  const cliEvidence = parseEvidence(JSON.parse(cli.stdout));
  assert.deepEqual(cliEvidence.normalized_result, original.normalized_result);
  assert.deepEqual(cliEvidence.parameters, original.parameters);
  assert.deepEqual(cliEvidence.subject, original.subject);
  await writeFile(join(lab, "cli.json"), cli.stdout, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(lab, "original.json"), JSON.stringify(original), {
    flag: "wx",
    mode: 0o600,
  });
  rows.push(await verifyLateCancellation(original));

  const malformed = join(lab, "odd-nibble.hex");
  await writeFile(malformed, "0x0\n", { flag: "wx", mode: 0o600 });
  for (const scenario of ["success", "format-failure"]) {
    const baseline = await host.captureBaseline();
    await gateMode("hold");
    const pending = request(scenario === "success" ? values.path : malformed);
    let launch;
    await verifyWithCleanup(async () => {
      launch = await observeGate(scenario === "success");
      fault = { path: launch.marker.root, mode: launch.root_mode };
      await chmod(fault.path, 0o500);
      await writeFile(join(lab, "release"), "release", {
        flag: "wx",
        mode: 0o600,
      });
      const failed = errorValue(await pending);
      assert.equal(failed.code, "cleanup_incomplete");
      assert.deepEqual(failed.details.resources, [launch.marker.root]);
      assert.match(failed.details.diagnostics.reason, /EACCES/u);
      const previous = failed.details.diagnostics.previous_error;
      if (scenario === "success") assert.equal(previous, null);
      else assert.equal(previous.category, "invalid_input");
      const cleanup = await confirmCleanup(launch, baseline, false);
      assert.deepEqual(await roots(), [
        launch.marker.root.slice(work.length + 1),
      ]);
      await gateMode("off");
      const launchLogBefore = await readFile(join(lab, "launches.log"));
      const retryBeforeRepair = errorValue(await request());
      assert.equal(retryBeforeRepair.code, "cleanup_incomplete");
      assert.deepEqual(retryBeforeRepair.details.resources, [
        launch.marker.root,
      ]);
      assert.deepEqual(
        await readFile(join(lab, "launches.log")),
        launchLogBefore,
      );
      const peerEvidence = await peer();
      assert.equal(peerEvidence.subject.digest.sha256, peerBefore);
      await restore();
      const recovered = evidenceValue(await request(), "inspect_evm_interface");
      assert.deepEqual(recovered.normalized_result, original.normalized_result);
      await assert.rejects(access(launch.marker.root), { code: "ENOENT" });
      assert.deepEqual(await roots(), []);
      rows.push({
        scenario: "cleanup-retry-after-" + scenario,
        launch,
        failed,
        cleanup,
        retry_before_permission_repair: retryBeforeRepair,
        launch_log_sha256_before_retry: sha(launchLogBefore),
        peer_evidence_id: peerEvidence.evidence_id,
        recovery_evidence_id: recovered.evidence_id,
      });
    }, [
      restore,
      () => writeFile(join(lab, "release"), "release", { mode: 0o600 }),
      () => pending,
    ]);
  }
}, [
  restore,
  () => writeFile(join(lab, "release"), "release", { mode: 0o600 }),
  () => client.close(),
  () => transport.close(),
]);
assert.deepEqual(await roots(), []);
const finalRun = await completeVerifierRun(run);
assert.equal(
  finalRun.process_lineage.status,
  "verified",
  JSON.stringify(finalRun),
);
assert.deepEqual(finalRun.process_lineage.descendants, []);
assert.equal(await fileSha(values.path), targetBefore);
assert.equal(await fileSha(values["peer-path"]), peerBefore);
assert.equal(await fileSha(new URL(import.meta.url)), sourceBefore);
const runtimeTable = JSON.stringify(runtimeFiles);
runtimeFiles.length = 0;
await fingerprint(join(runtime, "dist"));
await fingerprint(join(runtime, "bridge"));
runtimeFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
assert.equal(
  JSON.stringify(runtimeFiles),
  runtimeTable,
  "Runtime changed during verification",
);
await writeFile(
  join(lab, "summary.json"),
  JSON.stringify({
    revision: values.revision,
    verifier_run: finalRun,
    verifier_sha256: sourceBefore,
    runtime_file_table_sha256: sha(JSON.stringify(runtimeFiles)),
    cli_default_parity: true,
    fixture_sha256: await fileSha(wrapper),
    artifact: { path: values.path, sha256: targetBefore },
    peer: { path: values["peer-path"], sha256: peerBefore },
    scope:
      "Linux x64; actual EVMole reply before fixture-held command completion; no mid-WASM interruption claim",
    rows,
    source_bytes_unchanged: true,
    target_bytes_unchanged: true,
    peer_bytes_unchanged: true,
    owned_runtime_roots_removed: true,
    runtime_files_unchanged: true,
  }),
  { flag: "wx", mode: 0o600 },
);
console.log(
  JSON.stringify({ pass: true, scenarios: rows.map((x) => x.scenario) }),
);
