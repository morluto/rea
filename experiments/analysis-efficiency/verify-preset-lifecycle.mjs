import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { createReadStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    revision: { type: "string" },
    path: { type: "string" },
    providers: { type: "string" },
    output: { type: "string" },
    "disabled-analyzers": {
      type: "string",
      default: "Decompiler Switch Analysis",
    },
    "timeout-ms": { type: "string", default: "900000" },
  },
});
for (const key of ["runtime-root", "path", "providers", "output"])
  assert.ok(values[key] && isAbsolute(values[key]), "Supply --" + key + " ABS");
assert.match(values.revision ?? "", /^[a-f0-9]{40}$/u);
assert.equal(process.platform, "linux");
assert.notEqual(
  process.getuid(),
  0,
  "Permission fault injection requires a non-root user",
);
const timeout = Number(values["timeout-ms"]);
assert.ok(Number.isSafeInteger(timeout) && timeout > 0);
const lab = values.output,
  runtime = values["runtime-root"];
const { ghidraDisabledAnalyzersSchema } = await import(
  pathToFileURL(runtime + "/dist/config/ghidraDisabledAnalyzers.js")
);
assert.ok(
  ghidraDisabledAnalyzersSchema.parse(values["disabled-analyzers"]) !==
    undefined,
  "Select at least one analyzer to disable",
);
await mkdir(lab, { mode: 0o700 });
const providerBytes = await readFile(values.providers);
const providers = JSON.parse(providerBytes.toString("utf8"));
assert.ok(
  providers !== null &&
    !Array.isArray(providers) &&
    typeof providers === "object",
);
assert.ok(Object.values(providers).every((x) => typeof x === "string"));
const verifierSource = await readFile(new URL(import.meta.url));
const {
  observeOwnedProcessLineage,
  observeProcessStartIdentity,
  systemProcessOwnershipHost: host,
} = await import(
  pathToFileURL(runtime + "/dist/process/ProcessOwnershipObservation.js")
);
const { verifyNoTokenOwnedProcesses } = await import(
  pathToFileURL(runtime + "/dist/process/ProcessOwnership.js")
);
const target = values.path;
const sha = (x) => createHash("sha256").update(x).digest("hex");
const fileSha = async (path) => {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
};
const before = await fileSha(target);
const rows = [];
const roots = async (work) =>
  (await readdir(work))
    .filter((x) => x.startsWith("rea-ghidra-"))
    .map((x) => join(work, x));
const ownershipSchema = z
  .object({
    run_id: z.string().uuid(),
    pid: z.number().int().positive(),
    process_group_id: z.number().int().positive(),
    parent_pid: z.number().int().positive(),
    launcher: z.string().min(1),
    endpoint_path: z.string().min(1),
    ownership_kind: z.literal("posix-process-group"),
  })
  .passthrough();
const manifest = async (root) =>
  ownershipSchema.parse(
    JSON.parse(await readFile(join(root, "ownership.json"), "utf8")),
  );
const verifyWithCleanup = async (verify, cleanups) => {
  const failures = [];
  let result;
  try {
    result = await verify();
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
    throw new AggregateError(
      failures,
      "Verification or resource cleanup failed",
    );
  return result;
};
const restoreProject = async (project, mode) => {
  if (project === undefined || mode === undefined) return;
  try {
    await chmod(project, mode);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};
const unreadyLaunch = async (work) => {
  for (const root of await roots(work)) {
    let record;
    try {
      record = await manifest(root);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const lineage = await observeOwnedProcessLineage(owned(record));
    if (lineage.status !== "verified") continue;
    const identity = await observeProcessStartIdentity(
      record.pid,
      undefined,
      record.run_id,
    );
    if (identity?.state !== "readable") continue;
    try {
      await access(record.endpoint_path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { root, manifest: record, lineage, start_identity: identity };
    }
  }
};
const owned = (m) => ({
  runId: m.run_id,
  leaderPid: m.pid,
  processGroupId: m.process_group_id,
  expectedParentPid: m.parent_pid,
  expectedCommand: m.launcher,
});
const cancelStartup = async ({ client, defs, work, call }) => {
  const baseline = await host.captureBaseline();
  const controller = new AbortController();
  const pattern = "rea-lifecycle-" + randomUUID();
  let settled = false;
  const pending = client
    .callTool(
      { name: "search_procedures", arguments: { pattern } },
      {
        toolDefinition: defs.get("search_procedures"),
        timeout,
        signal: controller.signal,
      },
    )
    .then(
      (reply) => {
        settled = true;
        return { reply };
      },
      (error) => {
        settled = true;
        return {
          error: {
            name: error.name,
            message: error.message,
            code: error.code,
          },
        };
      },
    );
  let launch;
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !settled) {
      launch = await unreadyLaunch(work);
      if (launch) break;
      await delay(50);
    }
    assert.ok(launch, "No token-verified live JVM before endpoint readiness");
    assert.equal(settled, false);
  } finally {
    controller.abort(new Error("Preset startup cancellation"));
    await pending;
  }
  const canceled = await pending;
  assert.ok(canceled.error, "Pending SDK request did not cancel");
  await writeFile(work + "/cancellation.json", JSON.stringify(canceled), {
    flag: "wx",
    mode: 0o600,
  });
  let cleanup;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    cleanup = await verifyNoTokenOwnedProcesses(
      launch.manifest.run_id,
      undefined,
      baseline,
      {
        leaderPid: launch.manifest.pid,
        processGroupId: launch.manifest.process_group_id,
      },
    );
    const liveRoots = await roots(work);
    if (cleanup.cleaned && liveRoots.length === 0) break;
    await delay(100);
  }
  assert.equal(cleanup.cleaned, true, JSON.stringify(cleanup));
  assert.deepEqual(await roots(work), []);
  await assert.rejects(access(dirname(launch.manifest.endpoint_path)), {
    code: "ENOENT",
  });
  const afterCancel = (await call("binary_session")).result;
  assert.equal(afterCancel.open, true);
  assert.notEqual(afterCancel.analysis_activity.status, "busy");
  return { launch, cleanup, afterCancel, pattern };
};
for (const profile of ["default", "disabled"]) {
  const work = lab + "/" + profile;
  await mkdir(work, { mode: 0o700 });
  const client = new Client({
    name: "rea-real-preset-lifecycle",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [runtime + "/scripts/rea.mjs", "mcp"],
    env: {
      ...process.env,
      ...providers,
      NODE_OPTIONS: "--max-old-space-size=512",
      TMPDIR: work,
      REA_GHIDRA_DISABLED_ANALYZERS:
        profile === "default" ? "" : values["disabled-analyzers"],
    },
    stderr: "pipe",
  });
  const defs = new Map();
  let count = 0;
  const call = async (name, args = {}, error = false) => {
    const definition = defs.get(name);
    assert.ok(definition, "Missing named contract " + name);
    const reply = await client.callTool(
      { name, arguments: args },
      { toolDefinition: definition, timeout },
    );
    await writeFile(
      work + "/call-" + ++count + ".json",
      JSON.stringify(reply),
      { flag: "wx", mode: 0o600 },
    );
    const value =
      reply.structuredContent ??
      JSON.parse(reply.content.find((x) => x.type === "text").text);
    assert.equal(reply.isError === true, error, JSON.stringify(value));
    return value;
  };
  let project, mode;
  const row = await verifyWithCleanup(async () => {
    await client.connect(transport);
    transport.stderr?.resume();
    for (const t of (await client.listTools()).tools) defs.set(t.name, t);
    await call("open_binary", { path: target, provider_id: "ghidra" });
    const selectedProfile = (await call("binary_session")).result
      .analysis_provider_binding.analysis_profile;
    const { launch, cleanup, afterCancel, pattern } = await cancelStartup({
      client,
      defs,
      work,
      call,
    });
    const recovered = await call("search_procedures", { pattern });
    assert.deepEqual(recovered.normalized_result, []);
    const activeRoots = await roots(work);
    assert.equal(activeRoots.length, 1);
    const active = await manifest(activeRoots[0]);
    const activeIdentity = await observeProcessStartIdentity(
      active.pid,
      undefined,
      active.run_id,
    );
    assert.equal(activeIdentity?.state, "readable");
    assert.notEqual(activeIdentity.identity, launch.start_identity.identity);
    const activeLineage = await observeOwnedProcessLineage(owned(active));
    assert.equal(activeLineage.status, "verified");
    const activeBaseline = await host.captureBaseline();
    project = join(activeRoots[0], "project");
    const info = await lstat(project);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(
      info.uid,
      process.getuid(),
      "Fault must affect only this user-owned project",
    );
    mode = info.mode & 0o777;
    await chmod(project, 0o500);
    const refusal = await verifyWithCleanup(
      () => call("close_binary", {}, true),
      [() => restoreProject(project, mode)],
    );
    assert.equal(refusal.error.code, "cleanup_incomplete");
    assert.ok(refusal.error.details.resources.includes(activeRoots[0]));
    await writeFile(work + "/cleanup-refusal.json", JSON.stringify(refusal), {
      flag: "wx",
      mode: 0o600,
    });
    assert.ok(
      (await roots(work)).includes(activeRoots[0]),
      "Failed cleanup resource ownership disappeared",
    );
    await call("close_binary");
    assert.deepEqual(await roots(work), []);
    await assert.rejects(access(dirname(active.endpoint_path)), {
      code: "ENOENT",
    });
    const retried = await verifyNoTokenOwnedProcesses(
      active.run_id,
      undefined,
      activeBaseline,
      { leaderPid: active.pid, processGroupId: active.process_group_id },
    );
    assert.equal(retried.cleaned, true, JSON.stringify(retried));
    assert.equal((await call("binary_session")).result.open, false);
    assert.equal(await fileSha(target), before);
    return {
      profile,
      selected_profile: selectedProfile,
      source_sha256: before,
      actual_pending_startup_canceled: true,
      verified_launch: launch,
      token_cleanup: cleanup,
      post_cancellation_activity: afterCancel.analysis_activity,
      recovery_preserves_selected_target: true,
      logical_run_id_after_recovery: active.run_id,
      recovered_ownership: active,
      new_verified_process_generation_after_recovery: activeIdentity,
      real_permission_cleanup_failure: refusal,
      retry_cleanup: retried,
      source_bytes_unchanged: true,
    };
  }, [() => restoreProject(project, mode), () => client.close()]);
  rows.push(row);
  await writeFile(
    lab + "/progress.json",
    JSON.stringify(rows, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ profile, status: "passed" }) + "\n");
}
assert.deepEqual(
  await readFile(new URL(import.meta.url)),
  verifierSource,
  "Verifier source changed during execution",
);
await writeFile(
  lab + "/summary.json",
  JSON.stringify(
    {
      caller_supplied_runtime_revision: values.revision,
      verifier_source_sha256: sha(verifierSource),
      provider_settings_sha256: sha(providerBytes),
      source_path: target,
      source_sha256: before,
      rows,
      scope:
        "Actual public MCP on Linux: token/start-identity verified pending Ghidra startup cancellation, fresh work under the selected target, controlled permission failure in an owned temporary project, retained-resource close retry and read-only token sweeps. Original input is unchanged. Runtime revision is caller-supplied; this is lifecycle verification, not paired performance or general OS coverage.",
    },
    null,
    2,
  ) + "\n",
  { flag: "wx", mode: 0o600 },
);
