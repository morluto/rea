import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs, promisify, isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    revision: { type: "string" },
    path: { type: "string" },
    providers: { type: "string" },
    strace: { type: "string" },
    output: { type: "string" },
    procedure: { type: "string" },
    "timeout-ms": { type: "string", default: "900000" },
    "disabled-analyzers": {
      type: "string",
      default: "Decompiler Switch Analysis",
    },
  },
});
for (const key of ["runtime-root", "path", "providers", "strace", "output"])
  assert.ok(values[key] && isAbsolute(values[key]), `Supply --${key} ABS`);
assert.match(values.revision ?? "", /^[a-f0-9]{40}$/u);
assert.equal(process.platform, "linux", "This verifier requires Linux strace");
const timeout = Number(values["timeout-ms"]);
assert.ok(Number.isSafeInteger(timeout) && timeout > 0);
assert.ok(values["disabled-analyzers"].trim().length > 0);
const verifierSource = await readFile(new URL(import.meta.url));
await mkdir(values.output, { mode: 0o700 });
const fileSha = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};
const before = await fileSha(values.path);
const providerBytes = await readFile(values.providers);
const providers = JSON.parse(providerBytes.toString("utf8"));
assert.ok(
  providers !== null &&
    !Array.isArray(providers) &&
    typeof providers === "object",
);
assert.ok(Object.values(providers).every((value) => typeof value === "string"));
const entrypoint = resolve(values["runtime-root"], "scripts/rea.mjs");
const { parseAnalysisSnapshot } = await import(
  pathToFileURL(
    resolve(values["runtime-root"], "dist/domain/analysisSnapshot.js"),
  )
);
const { parseEvidence } = await import(
  pathToFileURL(resolve(values["runtime-root"], "dist/domain/evidence.js"))
);
const { createVerifierRun, completeVerifierRun } = await import(
  pathToFileURL(resolve(values["runtime-root"], "scripts/lib/verifier-run.mjs"))
);
const run = createVerifierRun();
const snapshotPath = resolve(values.output, "default.snapshot.json");
const changedSnapshotPath = resolve(values.output, "changed.snapshot.json");
const tracedArgs = (work, args) => [
  "-ff",
  "-s",
  "4096",
  "-e",
  "trace=execve,execveat",
  "-o",
  resolve(work, "exec.trace"),
  process.execPath,
  entrypoint,
  ...args,
];
const headlessLaunches = async (work) => {
  const files = (await readdir(work)).filter((name) =>
    name.startsWith("exec.trace."),
  );
  assert.ok(files.length > 0, "No actual syscall trace was recorded");
  const lines = (
    await Promise.all(
      files.map((name) => readFile(resolve(work, name), "utf8")),
    )
  ).flatMap((text) => text.split("\n"));
  // This checks the complete known Ghidra launch argument, not arbitrary target execution.
  return lines.filter(
    (line) =>
      line.includes("ghidra.app.util.headless.AnalyzeHeadless") &&
      line.endsWith("= 0"),
  ).length;
};
const environmentFor = (work, disabled) => ({
  ...process.env,
  ...providers,
  NODE_OPTIONS: "--max-old-space-size=512",
  TMPDIR: work,
  REA_PROCESS_RUN_ID: run.run_id,
  REA_GHIDRA_DISABLED_ANALYZERS: disabled,
});
const exactTaskFacts = (actual, expected) => {
  assert.deepEqual(actual.normalized_result, expected.normalized_result);
  assert.deepEqual(actual.subject, expected.subject);
  assert.deepEqual(actual.analysis_profile, expected.analysis_profile);
  assert.deepEqual(actual.parameters, expected.parameters);
};
let selected = values.procedure,
  original,
  profile,
  snapshotBytes;
const rows = [];
for (const scenario of [
  "default",
  "same-profile",
  "changed-profile",
  "restored-default",
]) {
  const work = resolve(values.output, scenario);
  await mkdir(work, { mode: 0o700 });
  const environment = environmentFor(
    work,
    scenario === "changed-profile" ? values["disabled-analyzers"] : "",
  );
  const client = new Client({
    name: "rea-preset-snapshot-verifier",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: values.strace,
    args: tracedArgs(work, ["mcp"]),
    env: environment,
    stderr: "pipe",
  });
  const definitions = new Map();
  const calls = [];
  const call = async (name, args = {}, expectedError = false) => {
    const definition = definitions.get(name);
    assert.ok(definition, `Missing named contract ${name}`);
    const start = performance.now();
    const reply = await client.callTool(
      { name, arguments: args },
      { toolDefinition: definition, timeout },
    );
    await writeFile(
      resolve(work, `call-${calls.length + 1}.json`),
      JSON.stringify(reply),
      { flag: "wx", mode: 0o600 },
    );
    const value =
      reply.structuredContent ??
      JSON.parse(reply.content.find((item) => item.type === "text").text);
    calls.push({
      name,
      arguments: args,
      elapsed_ms: performance.now() - start,
      is_error: reply.isError === true,
      evidence_id: value.evidence_id ?? null,
    });
    assert.equal(reply.isError === true, expectedError, JSON.stringify(value));
    return value;
  };
  try {
    await client.connect(transport);
    transport.stderr?.resume();
    for (const definition of (await client.listTools()).tools)
      definitions.set(definition.name, definition);
    if (scenario === "changed-profile") {
      const rejected = await call(
        "open_binary",
        {
          path: values.path,
          provider_id: "ghidra",
          snapshot_path: snapshotPath,
        },
        true,
      );
      assert.equal(rejected.error.code, "evidence_integrity_mismatch");
      assert.match(JSON.stringify(rejected.error), /profile_mismatch/u);
      assert.equal((await call("binary_session")).result.open, false);
      assert.equal(await headlessLaunches(work), 0);
      await client.ping();
      await call("open_binary", { path: values.path, provider_id: "ghidra" });
      const changed = (await call("binary_session")).result
        .analysis_provider_binding.analysis_profile;
      assert.notEqual(changed.digest, profile.digest);
      assert.notEqual(
        changed.parameters.analyzer_preset,
        profile.parameters.analyzer_preset,
      );
      const fact = parseEvidence(
        await call("analyze_function", { procedure: selected }),
      );
      assert.deepEqual(fact.analysis_profile, changed);
      await call("close_binary", { snapshot_path: changedSnapshotPath });
      rows.push({
        scenario,
        wrong_snapshot_rejected_before_headless_launch: true,
        selected_profile: changed,
        source_snapshot_unchanged: true,
        selected_function_facts_match_default: isDeepStrictEqual(
          fact.normalized_result,
          original.normalized_result,
        ),
        limitations: fact.limitations,
        calls,
      });
    } else {
      if (scenario === "restored-default") {
        const rejected = await call(
          "open_binary",
          {
            path: values.path,
            provider_id: "ghidra",
            snapshot_path: changedSnapshotPath,
          },
          true,
        );
        assert.equal(rejected.error.code, "evidence_integrity_mismatch");
        assert.match(JSON.stringify(rejected.error), /profile_mismatch/u);
        assert.equal((await call("binary_session")).result.open, false);
        assert.equal(await headlessLaunches(work), 0);
      }
      await call("open_binary", {
        path: values.path,
        provider_id: "ghidra",
        ...(scenario === "default" ? {} : { snapshot_path: snapshotPath }),
      });
      if (selected === undefined) {
        const procedures = (await call("list_procedures")).normalized_result;
        const observed = procedures.find(
          (row) =>
            row.procedure?.external === false && row.procedure.thunk === false,
        );
        assert.ok(
          observed,
          "No provider-observed internal procedure; select --procedure explicitly",
        );
        selected = observed.address;
      }
      const fact = parseEvidence(
        await call("analyze_function", { procedure: selected }),
      );
      const actualProfile = (await call("binary_session")).result
        .analysis_provider_binding.analysis_profile;
      assert.equal(actualProfile.parameters.analyzer_preset, "ghidra-default");
      if (scenario === "default") {
        original = fact;
        profile = actualProfile;
        await call("close_binary", { snapshot_path: snapshotPath });
        snapshotBytes = await readFile(snapshotPath);
        const snapshot = parseAnalysisSnapshot(
          JSON.parse(snapshotBytes.toString("utf8")),
        );
        assert.ok(
          snapshot.entries.some(
            (entry) => entry.operation === "analyze_function",
          ),
          "The actual query must be stored, not merely equal after re-analysis",
        );
        assert.ok(
          snapshot.evidence_bundle.records.some(
            (record) => record.evidence_id === original.evidence_id,
          ),
        );
      } else {
        assert.deepEqual(actualProfile, profile);
        exactTaskFacts(fact, original);
        assert.ok(
          fact.limitations.some((limitation) =>
            limitation.includes("local REA analysis snapshot"),
          ),
          "No producer cache-reuse marker",
        );
        await call("close_binary");
      }
      rows.push({
        scenario,
        selected_profile: actualProfile,
        original_evidence_id: original.evidence_id,
        returned_evidence_id: fact.evidence_id,
        limitations: fact.limitations,
        calls,
      });
    }
    assert.equal((await call("binary_session")).result.open, false);
  } finally {
    await client.close();
  }
  const launches = await headlessLaunches(work);
  assert.equal(
    launches,
    scenario === "default" || scenario === "changed-profile" ? 1 : 0,
  );
  rows.at(-1).headless_launches = launches;
  assert.equal(await fileSha(values.path), before);
  assert.deepEqual(await readFile(snapshotPath), snapshotBytes);
  await writeFile(
    resolve(values.output, "progress.json"),
    JSON.stringify(rows, null, 2),
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      scenario,
      status: "passed",
      headless_launches: launches,
    }) + "\n",
  );
}
const cliWork = resolve(values.output, "cli");
await mkdir(cliWork, { mode: 0o700 });
const cliStart = performance.now();
const { stdout, stderr } = await promisify(execFile)(
  values.strace,
  tracedArgs(cliWork, [
    "function",
    values.path,
    selected,
    "--provider",
    "ghidra",
    "--snapshot",
    snapshotPath,
    "--json",
  ]),
  {
    env: environmentFor(cliWork, ""),
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  },
);
await writeFile(resolve(cliWork, "reply.json"), stdout, {
  flag: "wx",
  mode: 0o600,
});
await writeFile(resolve(cliWork, "stderr.log"), stderr, {
  flag: "wx",
  mode: 0o600,
});
const cli = parseEvidence(JSON.parse(stdout));
exactTaskFacts(cli, original);
assert.equal(cli.evidence_id, original.evidence_id);
assert.deepEqual(await readFile(snapshotPath), snapshotBytes);
assert.equal(await headlessLaunches(cliWork), 0);
assert.equal(await fileSha(values.path), before);
const lineage = await completeVerifierRun(run);
assert.equal(lineage.process_lineage.status, "verified");
assert.deepEqual(lineage.process_lineage.descendants, []);
const report = {
  caller_supplied_runtime_revision: values.revision,
  verifier_source_sha256: createHash("sha256")
    .update(verifierSource)
    .digest("hex"),
  source_sha256: before,
  source_path: values.path,
  provider_settings_sha256: createHash("sha256")
    .update(providerBytes)
    .digest("hex"),
  original_evidence_id: original.evidence_id,
  source_snapshot_sha256: createHash("sha256")
    .update(snapshotBytes)
    .digest("hex"),
  selected_procedure: selected,
  original_record_and_source_bytes_unchanged: true,
  rows,
  cli: {
    elapsed_ms: performance.now() - cliStart,
    returned_evidence_id: cli.evidence_id,
    exact_original_task_facts: true,
    headless_launches: 0,
  },
  lineage,
  scope:
    "Actual Ghidra public SDK and CLI, explicit default/disabled profiles and immutable JSON snapshot reuse. Revision is caller-supplied. Selection/discovery and all verification calls are included; timings are not paired performance evidence. No engine database cache, target execution or annotation is requested. Final descendant observation is point-in-time; syscall audit covers the known headless launch command.",
};
assert.deepEqual(
  await readFile(new URL(import.meta.url)),
  verifierSource,
  "Verifier source changed during execution",
);
await writeFile(
  resolve(values.output, "summary.json"),
  JSON.stringify(report, null, 2),
  { flag: "wx", mode: 0o600 },
);
