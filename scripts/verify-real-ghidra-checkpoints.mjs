#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ghidraCheckpointOriginLimitations } from "../dist/ghidra/GhidraProviderCapabilities.js";
import {
  requireMcpOperationResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import {
  createVerifierRun,
  completeVerifierRun,
  assertVerifierCleanupComplete,
} from "./lib/verifier-run.mjs";

if (process.platform === "win32")
  throw new Error(
    "Owned Ghidra checkpoints currently support Linux/macOS only.",
  );
const run = createVerifierRun(),
  exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "rea-ghidra-checkpoints-"));
const runtime = join(root, "runtime"),
  checkpointDirectory = join(root, "checkpoints");
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const sourcePath = join(root, "fixture.c"),
  target = join(root, "checkpoint-fixture");
const env = {
  ...process.env,
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_DATA_HOME: join(root, "data"),
  TMPDIR: runtime,
  JDK_JAVA_OPTIONS: `-Duser.home=${root}`,
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_GHIDRA_CHECKPOINT_DIR: checkpointDirectory,
};
for (const name of [
  "REA_GHIDRA_PROJECT_PATH",
  "REA_GHIDRA_PROGRAM_NAME",
  "REA_GHIDRA_SEED_FILE",
  "REA_GHIDRA_NATIVEAOT_JAR",
  "REA_GHIDRA_LANGUAGE_ID",
  "REA_GHIDRA_COMPILER_SPEC_ID",
  "REA_GHIDRA_DISABLED_ANALYZERS",
])
  delete env[name];
const report = {
  verifier: "ghidra-owned-checkpoints",
  phases: [],
  target: null,
};
const sha = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function phase(name, operation) {
  const start = performance.now();
  try {
    const facts = await operation();
    report.phases.push({
      name,
      status: "verified",
      elapsed_ms: Math.round(performance.now() - start),
      ...facts,
    });
  } catch (cause) {
    report.phases.push({
      name,
      status: "failed",
      elapsed_ms: Math.round(performance.now() - start),
    });
    throw cause;
  }
}
async function cli(procedure, flags = [], path = target) {
  const { stdout } = await exec(
    process.execPath,
    [
      entrypoint,
      "decompile",
      path,
      procedure,
      "--provider",
      "ghidra",
      "--json",
      ...flags,
    ],
    { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}
async function refuseCli(procedure, flags, expected) {
  let refusal;
  try {
    await cli(procedure, flags);
  } catch (cause) {
    assert.equal(cause.code, 1, cause.stderr);
    refusal = JSON.parse(cause.stdout);
  }
  assert.ok(refusal, "CLI unexpectedly accepted unavailable checkpoint state");
  assert.equal(refusal.code, expected, JSON.stringify(refusal));
  return refusal;
}
async function connect(environment = {}) {
  const client = new Client({
    name: "rea-ghidra-checkpoint-verifier",
    version: "1",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env: { ...env, ...environment },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  try {
    await client.connect(transport);
  } catch (cause) {
    await client.close();
    await transport.close();
    throw cause;
  }
  const raw = (name, args = {}) =>
    client.callTool({ name, arguments: args }, { timeout: 240000 });
  return {
    raw,
    call: async (name, args = {}) =>
      requireMcpOperationResult(await raw(name, args), name),
    close: async () => {
      await client.close();
      await transport.close();
    },
  };
}
let manifestPath;
const manifest = async () => JSON.parse(await readFile(manifestPath, "utf8"));
try {
  await mkdir(runtime);
  await writeFile(
    sourcePath,
    `typedef struct CheckpointRecord { int value; int flag; } CheckpointRecord;
__attribute__((noinline)) int rea_checkpoint_leaf(CheckpointRecord *record) { return record->value * 7 + record->flag; }
int main(void) { CheckpointRecord record = { 3, 11 }; return rea_checkpoint_leaf(&record); }
`,
  );
  await exec("cc", [
    "-O0",
    "-g",
    "-gdwarf-4",
    "-fno-inline",
    sourcePath,
    "-o",
    target,
  ]);
  const targetDigest = await sha(target);
  report.target = {
    sha256: targetDigest,
    source: "self-built C struct/function fixture; never executed",
    host: process.platform,
    architecture: process.arch,
  };
  let original, initialManifest;
  const snapshotPath = join(root, "analysis-snapshot.json");
  await phase(
    "a cold MCP session keeps its live Program across initial save and repeated open",
    async () => {
      const cold = await connect({
        REA_GHIDRA_CHECKPOINT_DIR: join(root, "cold-session-checkpoints"),
      });
      try {
        await cold.call("open_binary", { path: target, provider_id: "ghidra" });
        await cold.call("procedure_pseudo_code", {
          procedure: "rea_checkpoint_leaf",
        });
        const id = (await cold.call("binary_session")).analysis_run.run_id;
        await cold.call("annotate_native_function", {
          procedure: "rea_checkpoint_leaf",
          comment: "cold-session unsaved comment",
        });
        await cold.call("open_binary", { path: target, provider_id: "ghidra" });
        assert.equal(
          (await cold.call("binary_session")).analysis_run.run_id,
          id,
        );
        const current = await cold.call("procedure_pseudo_code", {
          procedure: "rea_checkpoint_leaf",
        });
        assert.match(JSON.stringify(current), /cold-session unsaved comment/);
        await cold.call("close_binary");
        return { same_live_run: true, unsaved_metadata_retained: true };
      } finally {
        await cold.close();
      }
    },
  );
  await phase("first analysis creates a checkpoint", async () => {
    original = await cli("rea_checkpoint_leaf", ["--snapshot", snapshotPath]);
    assert.match(JSON.stringify(original.normalized_result), /value/);
    for (const limitation of ghidraCheckpointOriginLimitations(null))
      assert.ok(original.limitations.includes(limitation));
    const keys = await readdir(checkpointDirectory);
    assert.equal(keys.length, 1);
    manifestPath = join(checkpointDirectory, keys[0], "current.json");
    initialManifest = await manifest();
    assert.equal(initialManifest.target_sha256, targetDigest);
    assert.equal(
      await sha(
        join(checkpointDirectory, keys[0], initialManifest.source.file),
      ),
      initialManifest.source.sha256,
    );
    assert.deepEqual(
      original.analysis_profile.parameters.owned_checkpoint.state,
      { kind: "initial-analysis" },
    );
    return {
      provider_version: original.provider.version,
      response_bytes: Buffer.byteLength(JSON.stringify(original)),
    };
  });
  await phase(
    "the first checkpoint publication preserves initial immutable snapshot identity",
    async () => {
      const cached = await cli("rea_checkpoint_leaf", [
        "--snapshot",
        snapshotPath,
      ]);
      assert.deepEqual(cached, original);
      assert.deepEqual(await manifest(), initialManifest);
      return {};
    },
  );
  await phase(
    "fresh CLI restores the Program and does not rewrite it",
    async () => {
      const restored = await cli("rea_checkpoint_leaf");
      assert.deepEqual(restored.normalized_result, original.normalized_result);
      assert.equal(
        restored.analysis_profile.digest,
        original.analysis_profile.digest,
      );
      const source = {
        path: join(dirname(manifestPath), initialManifest.source.file),
        sha256: initialManifest.source.sha256,
      };
      assert.equal(await sha(source.path), source.sha256);
      assert.ok(
        restored.limitations.some(
          (value) =>
            value.includes(source.path) && value.includes(source.sha256),
        ),
      );
      for (const limitation of ghidraCheckpointOriginLimitations(source))
        assert.ok(restored.limitations.includes(limitation));
      for (const limitation of ghidraCheckpointOriginLimitations(null))
        assert.ok(!restored.limitations.includes(limitation));
      assert.deepEqual(await manifest(), initialManifest);
      return {
        checkpoint_sha256: initialManifest.source.sha256,
        response_bytes: Buffer.byteLength(JSON.stringify(restored)),
      };
    },
  );
  await phase(
    "another path with identical target bytes reuses the same Program",
    async () => {
      const alias = join(root, "renamed-target");
      await copyFile(target, alias);
      const restored = await cli("rea_checkpoint_leaf", [], alias);
      assert.deepEqual(restored.normalized_result, original.normalized_result);
      assert.equal(restored.caller_input_path, alias);
      assert.deepEqual(await manifest(), initialManifest);
      return {};
    },
  );
  await phase(
    "MCP preserves a live run, refuses a concurrent writer, and saves edits",
    async () => {
      const active = await connect();
      try {
        await active.call("open_binary", {
          path: target,
          provider_id: "ghidra",
        });
        await active.call("procedure_pseudo_code", {
          procedure: "rea_checkpoint_leaf",
        });
        const id = (await active.call("binary_session")).analysis_run.run_id;
        const other = await connect();
        try {
          await other.call("open_binary", {
            path: target,
            provider_id: "ghidra",
          });
          const error = requireMcpToolError(await other.raw("list_documents"));
          assert.equal(error.code, "configuration_invalid");
          assert.match(error.message, /another REA session/);
          await other.call("close_binary");
        } finally {
          await other.close();
        }
        await active.call("open_binary", {
          path: target,
          provider_id: "ghidra",
        });
        assert.equal(
          (await active.call("binary_session")).analysis_run.run_id,
          id,
        );
        await active.call("annotate_native_function", {
          procedure: "rea_checkpoint_leaf",
          name: "rea_checkpoint_retained",
          comment: "REA checkpoint first comment",
        });
        await active.call("close_binary");
        assert.notDeepEqual(await manifest(), initialManifest);
        return { same_live_run: true, concurrent_owner_refused: true };
      } finally {
        await active.close();
      }
    },
  );
  await phase("new MCP restores edits and remains editable", async () => {
    const resumed = await connect();
    try {
      await resumed.call("open_binary", {
        path: target,
        provider_id: "ghidra",
      });
      const analysis = await resumed.call("analyze_function", {
        procedure: "rea_checkpoint_retained",
        detail: "complete",
      });
      assert.equal(analysis.procedure.name, "rea_checkpoint_retained");
      assert.match(JSON.stringify(analysis), /REA checkpoint first comment/);
      assert.match(analysis.pseudocode, /value/);
      await resumed.call("annotate_native_function", {
        procedure: "rea_checkpoint_retained",
        comment: "REA checkpoint second comment",
      });
      await resumed.call("close_binary");
      return { structure_field_preserved: true };
    } finally {
      await resumed.close();
    }
  });
  await phase("CLI sees the second MCP edit", async () => {
    const result = await cli("rea_checkpoint_retained");
    assert.match(
      JSON.stringify(result.normalized_result),
      /REA checkpoint second comment/,
    );
    return {};
  });
  await phase(
    "an older immutable REA snapshot refuses the changed checkpoint",
    async () => {
      const refusal = await refuseCli(
        "rea_checkpoint_leaf",
        ["--snapshot", snapshotPath],
        "evidence_integrity_mismatch",
      );
      assert.ok(refusal.details.binding_mismatch.profile_digest);
      return {};
    },
  );
  await phase(
    "an edited live Program switches to identical bytes at another path",
    async () => {
      const active = await connect();
      const alias = join(root, "live-alias");
      await copyFile(target, alias);
      try {
        await active.call("open_binary", {
          path: target,
          provider_id: "ghidra",
        });
        await active.call("annotate_native_function", {
          procedure: "rea_checkpoint_retained",
          comment: "REA checkpoint second comment; saved during alias switch",
        });
        await active.call("open_binary", {
          path: alias,
          provider_id: "ghidra",
        });
        const result = await active.call("procedure_pseudo_code", {
          procedure: "rea_checkpoint_retained",
        });
        assert.match(JSON.stringify(result), /saved during alias switch/);
        await active.call("close_binary");
        return { alias_switch_preserved_edits: true };
      } finally {
        await active.close();
      }
    },
  );
  const current = await manifest(),
    bytes = await readFile(manifestPath);
  await phase(
    "target/profile mismatch is refused without replacing the saved state",
    async () => {
      try {
        await writeFile(
          manifestPath,
          JSON.stringify({ ...current, target_sha256: "0".repeat(64) }),
        );
        await refuseCli("rea_checkpoint_retained", [], "configuration_invalid");
      } finally {
        await writeFile(manifestPath, bytes);
      }
      return {};
    },
  );
  await phase(
    "malformed manifest is refused without a fresh import",
    async () => {
      try {
        await writeFile(manifestPath, "{");
        await refuseCli("rea_checkpoint_retained", [], "configuration_invalid");
      } finally {
        await writeFile(manifestPath, bytes);
      }
      return {};
    },
  );
  await phase(
    "corrupt packed data is refused and explicit restoration recovers",
    async () => {
      const packed = join(
          checkpointDirectory,
          (await readdir(checkpointDirectory))[0],
          current.source.file,
        ),
        backup = join(root, "good.gzf");
      await copyFile(packed, backup);
      try {
        await writeFile(packed, "corrupted packed data");
        await refuseCli("rea_checkpoint_retained", [], "configuration_invalid");
      } finally {
        await copyFile(backup, packed);
      }
      const result = await cli("rea_checkpoint_retained");
      assert.match(
        JSON.stringify(result.normalized_result),
        /REA checkpoint second comment/,
      );
      return {};
    },
  );
  assert.equal(await sha(target), targetDigest);
  assert.deepEqual(await readdir(runtime), []);
  const checkpointFiles = await readdir(
    join(checkpointDirectory, (await readdir(checkpointDirectory))[0]),
  );
  assert.equal(
    checkpointFiles.length,
    2,
    "Only the current manifest and packed Program should remain",
  );
  report.status = "verified";
} catch (cause) {
  report.status = "failed";
  report.error = cause instanceof Error ? cause.stack : String(cause);
  if (typeof cause?.stdout === "string")
    report.failure_stdout = cause.stdout.slice(-12000);
  if (typeof cause?.stderr === "string")
    report.failure_stderr = cause.stderr.slice(-4000);
  process.exitCode = 1;
} finally {
  report.run = await completeVerifierRun(run);
  let cleanupVerified = false;
  try {
    assertVerifierCleanupComplete(report.run.process_lineage);
    cleanupVerified = true;
  } catch (cause) {
    report.cleanup_error = String(cause);
    report.retained_workspace = root;
    process.exitCode = 1;
  }
  if (cleanupVerified) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cause) {
      report.cleanup_error = String(cause);
      report.retained_workspace = root;
      process.exitCode = 1;
    }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
