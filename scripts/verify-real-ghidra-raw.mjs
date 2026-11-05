import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { parseEvidence } from "../dist/domain/evidence.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import {
  requireMcpLifecycleResult,
  requireMcpOutput,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";

if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-raw.mjs");
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "Raw-binary verification requires a Linux or macOS Ghidra host.",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to a bring-your-own Ghidra installation.",
  );
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
assert.equal(installation.status, "available", JSON.stringify(installation));

const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-raw-proof-"));
let fixtureCleaned = true;
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const bytes = Buffer.from("1eff2fe1", "hex"); // ARM little-endian bx lr.
const sha256 = createHash("sha256").update(bytes).digest("hex");
const path = join(workspace, "image.bin");
await writeFile(path, bytes);
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
  GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.REA_MCP_INPUT_SCHEMA_PROFILE === undefined
    ? {}
    : {
        REA_MCP_INPUT_SCHEMA_PROFILE: process.env.REA_MCP_INPUT_SCHEMA_PROFILE,
      }),
  ...(process.env.REA_MCP_OUTPUT_SCHEMA_PROFILE === undefined
    ? {}
    : {
        REA_MCP_OUTPUT_SCHEMA_PROFILE:
          process.env.REA_MCP_OUTPUT_SCHEMA_PROFILE,
      }),
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { JAVA_HOME: process.env.JAVA_HOME }),
  ...(process.env.GHIDRA_HEADLESS_MAXMEM === undefined
    ? {}
    : { GHIDRA_HEADLESS_MAXMEM: process.env.GHIDRA_HEADLESS_MAXMEM }),
  ...(process.env.REA_GHIDRA_DISABLED_ANALYZERS === undefined
    ? {}
    : {
        REA_GHIDRA_DISABLED_ANALYZERS:
          process.env.REA_GHIDRA_DISABLED_ANALYZERS,
      }),
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "rea-real-raw-proof", version: "1" });
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});
let report;
let searchDefinition;
try {
  await client.connect(transport);
  searchDefinition = (await client.listTools()).tools.find(
    (tool) => tool.name === "search_bytes",
  );
  assert.ok(searchDefinition?.outputSchema);
  const profiles = [];
  const sessions = [];
  for (const entryPoint of ["0x08000000", "0x8000000", "0x09000000"]) {
    // Omit provider_id to exercise reuse of the current provider route.
    const opened = await call("open_binary", {
      path,
      format: "raw-binary",
      architecture: "arm",
      entry_point: entryPoint,
    });
    const entry = `0x${BigInt(entryPoint).toString(16)}`;
    assert.equal(opened.entry_point, entry);
    const image = await call("inspect_native_load_image");
    assert.equal(
      image.normalized_result.status,
      "verified",
      JSON.stringify(image),
    );
    assert.equal(image.normalized_result.base_address, entry);
    assert.equal(image.normalized_result.entry.address, entry);
    assert.equal(
      image.normalized_result.observations.language_id,
      "ARM:LE:32:v7",
    );
    assert.ok(
      image.normalized_result.observations.entry_points.includes(entry),
    );
    assert.equal(image.analysis_profile.parameters.entry_point, entry);
    profiles.push(image.analysis_profile.digest);
    const status = await call("binary_session");
    assert.equal(status.entry_point, entry);
    sessions.push(status.analysis_run.run_id);
    const memory = await call("read_bytes", {
      address: entry,
      length: bytes.length,
    });
    assert.equal(memory.normalized_result.bytes_hex, bytes.toString("hex"));
    const signature = await call("search_bytes", {
      pattern: "1e ?? 2f e1",
      limit: 1000,
    });
    assert.equal(signature.normalized_result.complete, true);
    assert.equal(signature.normalized_result.next_cursor, null);
    assert.equal(signature.normalized_result.searched.bytes, bytes.length);
    assert.deepEqual(
      signature.normalized_result.matches.map((match) => match.address),
      [entry],
    );
    assert.equal(signature.normalized_result.matches[0].file_offset, 0);
    assert.equal(
      signature.normalized_result.matches[0].procedure.address,
      entry,
    );
    const procedures = await call("list_procedures");
    assert.ok(
      procedures.normalized_result.some(
        (procedure) => procedure.address === entry,
      ),
    );
    const instruction = await call("inspect_native_instruction", {
      address: entry,
    });
    assert.equal(instruction.normalized_result.address, entry);
    assert.ok(Array.isArray(instruction.normalized_result.decoder_context));
    const tmodeContext = instruction.normalized_result.decoder_context.find(
      (ctx) => ctx.register === "TMode",
    );
    assert.ok(tmodeContext !== undefined);
    assert.equal(tmodeContext.source, "ghidra-program-context");
    assert.ok([null, "0", "1"].includes(tmodeContext.value));
  }
  assert.equal(profiles[0], profiles[1]);
  assert.notEqual(profiles[1], profiles[2]);
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[1], sessions[2]);
  const rejected = await client.callTool({
    name: "open_binary",
    arguments: {
      path,
      format: "raw-binary",
      architecture: "arm64",
      entry_point: "0x8000001",
    },
  });
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected.content), /must be 4-byte aligned/);
  const unchanged = await call("binary_session");
  assert.equal(unchanged.analysis_run.run_id, sessions[2]);
  assert.equal(unchanged.entry_point, "0x9000000");
  await call("close_binary");

  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      entrypoint,
      "inspect-native-load-image",
      path,
      "--target-format",
      "raw-binary",
      "--architecture",
      "arm",
      "--entry-point",
      "0x08000000",
      "--provider",
      "ghidra",
      "--json",
    ],
    { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  const cli = parseEvidence(JSON.parse(stdout));
  assert.equal(cli.subject.digest.sha256, sha256);
  assert.equal(cli.normalized_result.status, "verified");
  assert.equal(cli.normalized_result.base_address, "0x8000000");
  assert.equal(cli.analysis_profile.digest, profiles[0]);
  assert.deepEqual(await readFile(path), bytes);
  const x86Targets = [];
  for (const architecture of ["x86", "x86_64"]) {
    const x86Bytes = Buffer.from("b82a000000c3", "hex"); // mov eax, 42; ret.
    const x86Sha256 = createHash("sha256").update(x86Bytes).digest("hex");
    const x86Path = join(workspace, `${architecture}.bin`);
    await writeFile(x86Path, x86Bytes);
    await call("open_binary", {
      path: x86Path,
      format: "raw-binary",
      architecture,
      entry_point: "0x1000",
    });
    const image = await call("inspect_native_load_image", {}, x86Sha256);
    assert.equal(
      image.normalized_result.status,
      "verified",
      JSON.stringify(image),
    );
    assert.equal(image.normalized_result.base_address, "0x1000");
    assert.equal(image.normalized_result.observations.compiler_spec_id, "gcc");
    assert.equal(image.analysis_profile.parameters.compiler_spec_id, "gcc");
    const memory = await call(
      "read_bytes",
      { address: "0x1000", length: x86Bytes.length },
      x86Sha256,
    );
    assert.equal(memory.normalized_result.bytes_hex, x86Bytes.toString("hex"));
    const pseudo = await call(
      "procedure_pseudo_code",
      { procedure: "0x1000" },
      x86Sha256,
    );
    assert.match(pseudo.normalized_result, /\b(?:42|0x2a)\b/iu);
    await call("close_binary");
    assert.deepEqual(await readFile(x86Path), x86Bytes);
    x86Targets.push({
      architecture,
      sha256: x86Sha256,
      compiler_spec_id: "gcc",
      return_42: true,
    });
  }
  const repeatedPath = join(workspace, "signatures.bin");
  const repeatedBytes = Buffer.from("b82a000000c3".repeat(1005), "hex");
  const repeatedSha256 = createHash("sha256")
    .update(repeatedBytes)
    .digest("hex");
  await writeFile(repeatedPath, repeatedBytes);
  await call("open_binary", {
    path: repeatedPath,
    format: "raw-binary",
    architecture: "x86_64",
    entry_point: "0x1000",
  });
  // Import/analysis is complete before timing the first uncached search.
  await call("read_bytes", { address: "0x1000", length: 6 }, repeatedSha256);
  const started = performance.now();
  const page = await call(
    "search_bytes",
    { pattern: "b8 ?? 00 00 00 c3", limit: 1000 },
    repeatedSha256,
  );
  const searchElapsedMs = performance.now() - started;
  assert.equal(page.normalized_result.matches.length, 1000);
  assert.equal(page.normalized_result.complete, false);
  const rest = await call(
    "search_bytes",
    {
      pattern: "b8 ?? 00 00 00 c3",
      limit: 1000,
      cursor: page.normalized_result.next_cursor,
    },
    repeatedSha256,
  );
  assert.equal(rest.normalized_result.matches.length, 5);
  assert.equal(
    rest.normalized_result.matches[0].address,
    `0x${(0x1000 + 6000).toString(16)}`,
  );
  assert.equal(rest.normalized_result.complete, true);
  const masked = await call(
    "search_bytes",
    { pattern: "bf", mask: "f0", start: "0x1000", end: "0x1005" },
    repeatedSha256,
  );
  assert.deepEqual(
    masked.normalized_result.matches.map((match) => match.address),
    ["0x1000"],
  );
  const overlapping = await call(
    "search_bytes",
    { pattern: "00 00", start: "0x1000", end: "0x1005" },
    repeatedSha256,
  );
  assert.deepEqual(
    overlapping.normalized_result.matches.map((match) => match.address),
    ["0x1002", "0x1003"],
  );
  const wrongCursor = await client.callTool({
    name: "search_bytes",
    arguments: { pattern: "c3", cursor: page.normalized_result.next_cursor },
  });
  assert.equal(wrongCursor.isError, true);
  await call("close_binary");
  assert.deepEqual(await readFile(repeatedPath), repeatedBytes);

  // Two adjacent virtual regions backed by disjoint file ranges. The same
  // signature crosses their boundary and overlaps at every possible start.
  const splitPath = join(workspace, "split.elf");
  const splitBytes = splitSearchElf(0);
  const splitSha256 = createHash("sha256").update(splitBytes).digest("hex");
  await writeFile(splitPath, splitBytes);
  await call("open_binary", { path: splitPath, provider_id: "ghidra" });
  let cursorReopened = false;
  for (const pattern of ["aa aa aa", "aa ?? aa"]) {
    let cursor;
    const addresses = [];
    const pages = [];
    do {
      const evidence = await call(
        "search_bytes",
        {
          pattern,
          start: "0x401000",
          end: "0x401007",
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        },
        splitSha256,
        "elf",
      );
      const result = evidence.normalized_result;
      addresses.push(...result.matches.map((match) => match.address));
      pages.push({
        matches: result.matches.map(({ address, segment, file_offset }) => ({
          address,
          segment,
          file_offset,
        })),
        blocks: result.searched.blocks,
      });
      cursor = result.next_cursor ?? undefined;
      if (cursor !== undefined && !cursorReopened) {
        const snapshot = join(workspace, "split-snapshot.json");
        await call("close_binary", { snapshot_path: snapshot });
        await call("open_binary", {
          path: splitPath,
          provider_id: "ghidra",
          snapshot_path: snapshot,
        });
        cursorReopened = true;
      }
    } while (cursor !== undefined);
    assert.deepEqual(addresses, [
      "0x401000",
      "0x401001",
      "0x401002",
      "0x401003",
      "0x401004",
      "0x401005",
    ]);
    assert.deepEqual(pages, [
      {
        matches: [
          { address: "0x401000", segment: "segment_0", file_offset: 0x1000 },
          { address: "0x401001", segment: "segment_0", file_offset: 0x1001 },
        ],
        blocks: [
          {
            segment: "segment_0",
            start: "0x401000",
            end: "0x401003",
            bytes: 4,
          },
          {
            segment: "segment_1",
            start: "0x401004",
            end: "0x401004",
            bytes: 1,
          },
        ],
      },
      {
        matches: [
          { address: "0x401002", segment: "segment_0", file_offset: 0x1002 },
          { address: "0x401003", segment: "segment_0", file_offset: 0x1003 },
        ],
        blocks: [
          {
            segment: "segment_0",
            start: "0x401002",
            end: "0x401003",
            bytes: 2,
          },
          {
            segment: "segment_1",
            start: "0x401004",
            end: "0x401006",
            bytes: 3,
          },
        ],
      },
      {
        matches: [
          { address: "0x401004", segment: "segment_1", file_offset: 0x3000 },
          { address: "0x401005", segment: "segment_1", file_offset: 0x3001 },
        ],
        blocks: [
          {
            segment: "segment_1",
            start: "0x401004",
            end: "0x401007",
            bytes: 4,
          },
        ],
      },
    ]);
    const bounded = await call(
      "search_bytes",
      {
        pattern,
        start: "0x401000",
        end: "0x401005",
        limit: 20,
      },
      splitSha256,
      "elf",
    );
    assert.deepEqual(
      bounded.normalized_result.matches.map((match) => match.address),
      addresses.slice(0, 4),
    );
  }
  assert.equal(cursorReopened, true);
  const fileStart = await call(
    "address_to_file_offset",
    { address: "0x401000" },
    splitSha256,
    "elf",
  );
  const fileSecond = await call(
    "address_to_file_offset",
    { address: "0x401004" },
    splitSha256,
    "elf",
  );
  assert.equal(fileStart.normalized_result.file_offset, 0x1000);
  assert.equal(fileSecond.normalized_result.file_offset, 0x3000);
  await call("close_binary");
  assert.deepEqual(await readFile(splitPath), splitBytes);
  await verifyCrossBlockProject(splitPath, splitSha256);
  const gapPath = join(workspace, "gap.elf");
  const gapBytes = splitSearchElf(1);
  const gapSha256 = createHash("sha256").update(gapBytes).digest("hex");
  await writeFile(gapPath, gapBytes);
  await call("open_binary", { path: gapPath, provider_id: "ghidra" });
  const gap = await call(
    "search_bytes",
    {
      pattern: "aa aa aa aa ?? aa aa aa aa",
      start: "0x401000",
      end: "0x401008",
    },
    gapSha256,
    "elf",
  );
  assert.deepEqual(gap.normalized_result.matches, []);
  await call("close_binary");
  assert.deepEqual(await readFile(gapPath), gapBytes);
  const zeroFillPath = join(workspace, "initialized-zerofill.elf");
  const zeroFillBytes = splitSearchElf(1, true);
  const zeroFillSha256 = createHash("sha256")
    .update(zeroFillBytes)
    .digest("hex");
  await writeFile(zeroFillPath, zeroFillBytes);
  await call("open_binary", { path: zeroFillPath, provider_id: "ghidra" });
  const zeroFill = await call(
    "search_bytes",
    {
      pattern: "aa aa aa aa ?? aa aa aa aa",
      start: "0x401000",
      end: "0x401008",
    },
    zeroFillSha256,
    "elf",
  );
  // This Ghidra loader initializes the ELF zero-fill byte in this fixture.
  assert.deepEqual(
    zeroFill.normalized_result.matches.map((match) => match.address),
    ["0x401000"],
  );
  assert.deepEqual(
    zeroFill.normalized_result.searched.skipped_uninitialized,
    [],
  );
  await call("close_binary");
  assert.deepEqual(await readFile(zeroFillPath), zeroFillBytes);
  report = {
    ok: true,
    mocked: false,
    lane: "ghidra-raw",
    host: process.platform,
    provider: { id: "ghidra", version: installation.providerVersion },
    target: {
      format: "raw-binary",
      architecture: "arm",
      sha256,
      bytes: bytes.length,
    },
    transport: { cli: true, stdio_mcp: true },
    canonical_entry_reuses_session: true,
    changed_entry_replaces_session: true,
    lifecycle_entry_preserved: true,
    invalid_entry_preserves_active_session: true,
    load_images_verified: true,
    original_unchanged: true,
    x86_targets: x86Targets,
    byte_search: {
      cross_block_paging_and_gap: true,
      matches: 1005,
      page_size: 1000,
      first_search_elapsed_ms: searchElapsedMs,
      timing_scope: "MCP request after import; first uncached search",
      token_usage: "unmeasured",
      process_family_cpu_time: "unmeasured",
      peak_process_family_memory: "unmeasured",
    },
  };
} catch (error) {
  if (stderr.trim()) process.stderr.write(stderr);
  throw error;
} finally {
  await client.close();
  await transport.close();
  if (fixtureCleaned) await rm(workspace, { recursive: true, force: true });
}
const verifierRun = await completeVerifierRun(run);
assert.equal(verifierRun.process_lineage.status, "verified");
assert.deepEqual(verifierRun.process_lineage.descendants, []);
process.stdout.write(
  JSON.stringify({
    verifier_run: verifierRun,
    ...report,
    cleanup: "complete",
  }) + "\n",
);

async function call(
  name,
  args = {},
  targetSha256 = sha256,
  targetFormat = "raw-binary",
) {
  const result = await client.callTool(
    { name, arguments: args },
    {
      timeout: 240000,
      ...(name === "search_bytes" ? { toolDefinition: searchDefinition } : {}),
    },
  );
  if (["open_binary", "close_binary", "binary_session"].includes(name))
    return requireMcpLifecycleResult(result, name);
  const output = requireMcpOutput(result, name);
  const evidence = parseEvidence(output);
  assert.equal(evidence.subject.digest.sha256, targetSha256);
  assert.equal(evidence.subject.format, targetFormat);
  return evidence;
}

// Minimal static ELF64 with adjacent (or one-byte-separated) virtual segments
// and noncontiguous file backing. The target is never executed.
function splitSearchElf(gap, zeroFill = false) {
  const result = Buffer.alloc(0x3004);
  result.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  result.writeUInt16LE(2, 16); // ET_EXEC
  result.writeUInt16LE(62, 18); // EM_X86_64
  result.writeUInt32LE(1, 20);
  result.writeBigUInt64LE(0x401000n, 24);
  result.writeBigUInt64LE(64n, 32);
  result.writeUInt16LE(64, 52);
  result.writeUInt16LE(56, 54);
  result.writeUInt16LE(2, 56);
  const segment = (offset, fileOffset, address, memorySize = 4) => {
    result.writeUInt32LE(1, offset); // PT_LOAD
    result.writeUInt32LE(4, offset + 4); // PF_R
    result.writeBigUInt64LE(BigInt(fileOffset), offset + 8);
    result.writeBigUInt64LE(BigInt(address), offset + 16);
    result.writeBigUInt64LE(BigInt(address), offset + 24);
    result.writeBigUInt64LE(4n, offset + 32);
    result.writeBigUInt64LE(BigInt(memorySize), offset + 40);
    result.writeBigUInt64LE(1n, offset + 48);
    result.fill(0xaa, fileOffset, fileOffset + 4);
  };
  segment(64, 0x1000, 0x401000, zeroFill ? 5 : 4);
  segment(120, 0x3000, 0x401004 + gap);
  return result;
}

// Add test-only memory to an owned project, then let REA inspect its private copy.
async function verifyCrossBlockProject(target, targetSha256) {
  const projectDirectory = join(workspace, "boundary-project");
  await mkdir(projectDirectory);
  const scriptDirectory = fileURLToPath(
    new URL("../tests/conformance/ghidra", import.meta.url),
  );
  const launch = await spawnOwnedProviderProcess({
    command: installation.analyzeHeadlessPath,
    arguments: [
      projectDirectory,
      "Boundary",
      "-import",
      target,
      "-noanalysis",
      "-scriptPath",
      scriptDirectory,
      "-postScript",
      "ReaCrossBlockFixture.java",
    ],
    env,
    runId: run.run_id,
    expectedCommand: null,
  });
  fixtureCleaned = false;
  const supervisor = new ProviderProcessSupervisor({
    ...launch,
    ownsProcessLifetime: true,
    cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
  });
  await withVerifierCleanup(async () => {
    assert.ok(await supervisor.waitForExit(180000), "Fixture setup timed out");
    assert.ok(
      await supervisor.waitForOutputClose(1000),
      "Fixture output did not close",
    );
    const snapshot = supervisor.snapshot();
    const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
    assert.equal(snapshot.exitCode, 0, output);
    assert.doesNotMatch(output, /REPORT SCRIPT ERROR/u);
  }, [
    async () => {
      const stopped = await supervisor.stop();
      fixtureCleaned = stopped.status === "verified-cleanup";
      assert.ok(
        fixtureCleaned,
        `Owned cleanup incomplete; retained ${workspace}: ${JSON.stringify(stopped)}`,
      );
    },
  ]);
  const beforeProject = await fingerprintFiles(projectDirectory);
  const projectTransport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env: {
      ...env,
      REA_GHIDRA_PROJECT_PATH: join(projectDirectory, "Boundary.gpr"),
    },
    stderr: "pipe",
  });
  const projectClient = new Client({
    name: "rea-cross-block-project-proof",
    version: "1",
  });
  try {
    await projectClient.connect(projectTransport);
    const definition = (await projectClient.listTools()).tools.find(
      (tool) => tool.name === "search_bytes",
    );
    assert.ok(definition?.outputSchema);
    const projectCall = async (name, args) => {
      const reply = await projectClient.callTool(
        { name, arguments: args },
        {
          timeout: 240000,
          ...(name === "search_bytes" ? { toolDefinition: definition } : {}),
        },
      );
      if (name === "open_binary" || name === "close_binary")
        return requireMcpLifecycleResult(reply, name);
      const output = requireMcpOutput(reply, name);
      const evidence = parseEvidence(output);
      assert.equal(evidence.subject.digest.sha256, targetSha256);
      return evidence.normalized_result;
    };
    await projectCall("open_binary", { path: target, provider_id: "ghidra" });
    const pattern = "de ad ?? ?? be ef";
    const adjacent = await projectCall("search_bytes", {
      pattern,
      start: "0x60000000",
      end: "0x60000005",
    });
    assert.deepEqual(
      adjacent.matches.map((match) => match.address),
      ["0x60000000"],
    );
    const gap = await projectCall("search_bytes", {
      pattern,
      start: "0x60000100",
      end: "0x60000105",
    });
    assert.deepEqual(gap.matches, []);
    assert.ok(
      gap.searched.skipped_uninitialized.some(
        (block) => block.start === "0x60000102" && block.end === "0x60000103",
      ),
    );
    const all = await projectCall("search_bytes", { pattern });
    assert.ok(all.matches.some((match) => match.address === "0x60000000"));
    assert.ok(
      !all.matches.some((match) => match.address.startsWith("overlay_test:")),
    );
    assert.ok(
      all.searched.skipped_not_loaded.some(
        (block) => block.segment === "overlay_test",
      ),
    );
    const overlay = await projectCall("search_bytes", {
      pattern,
      start: "overlay_test:0x60000000",
      end: "overlay_test:0x60000005",
    });
    assert.deepEqual(
      overlay.matches.map((match) => match.address),
      ["overlay_test:0x60000000"],
    );
    await projectCall("close_binary", {});
  } finally {
    await projectClient.close();
    await projectTransport.close();
  }
  assert.deepEqual(await fingerprintFiles(projectDirectory), beforeProject);
}

async function fingerprintFiles(directory) {
  const result = [];
  const visit = async (relative) => {
    const entries = await readdir(join(directory, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile())
        result.push([
          name,
          createHash("sha256")
            .update(await readFile(join(directory, name)))
            .digest("hex"),
        ]);
      else throw new Error(`Unexpected project entry: ${name}`);
    }
  };
  await visit("");
  return result;
}
