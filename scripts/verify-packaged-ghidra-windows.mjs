#!/usr/bin/env node

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
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error(
    "Packaged Windows Ghidra acceptance requires a Windows x64 host.",
  );
const workspace = await mkdtemp(join(tmpdir(), "rea-packaged-ghidra-"));
const exec = promisify(execFile);
let packageRoot = resolve(process.argv[2] ?? ".");
// The default lane verifies the npm artifact in an isolated prefix. Explicit
// package roots support an already-installed artifact without a second install.
if (process.argv[2] === undefined) {
  try {
    const npmEntry =
      process.env.npm_execpath ??
      join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    const packed = JSON.parse(
      (
        await exec(
          process.execPath,
          [
            npmEntry,
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            workspace,
          ],
          { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
        )
      ).stdout,
    );
    assert.equal(
      packed.length,
      1,
      "The package lane must produce one artifact.",
    );
    const prefix = join(workspace, "installed");
    await exec(
      process.execPath,
      [
        npmEntry,
        "install",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        join(workspace, packed[0].filename),
      ],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    packageRoot = join(prefix, "node_modules", "rea-agents");
  } catch (cause) {
    await rm(workspace, { recursive: true, force: true });
    throw cause;
  }
}
const target = resolve(
  process.argv[3] ?? "build/fixtures/rea-ghidra-windows.exe",
);
let TOOL_CONTRACTS, native, token, sha256;
try {
  ({ TOOL_CONTRACTS } = await import(
    pathToFileURL(join(packageRoot, "dist/contracts/toolContracts.js"))
  ));
  const { requireWindowsNativeAuthority } = await import(
    pathToFileURL(join(packageRoot, "dist/windows/WindowsNativeLoader.js"))
  );
  native = requireWindowsNativeAuthority();
  token = native.call("process_caller_token", []);
  assert.equal(
    token.administrator,
    false,
    "The real-provider lane must run as an ordinary user.",
  );
  assert.equal(
    token.elevated,
    false,
    "The real-provider lane must use a non-elevated token.",
  );
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  sha256 = digest(await readFile(target));
} catch (cause) {
  await rm(workspace, { recursive: true, force: true });
  throw cause;
}
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runtimeParent = join(workspace, "runtime with spaces");
await mkdir(runtimeParent);
const callerDirectory = join(workspace, "caller cwd with spaces");
const scriptCollisions = ["ReaGhidraBridge.java", "ReaGhidraPrepareCom.java"];
await mkdir(callerDirectory);
for (const name of scriptCollisions) await mkdir(join(callerDirectory, name));
const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.toLowerCase() !== "comspec",
    ),
  ),
  ComSpec: (
    process.env.ComSpec ??
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
  ).replaceAll("\\", "/"),
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_LOG_LEVEL: "error",
  GHIDRA_HEADLESS_MAXMEM: "512m",
  NODE_OPTIONS: "--max-old-space-size=512",
  TEMP: runtimeParent.replaceAll("\\", "/"),
  TMP: runtimeParent.replaceAll("\\", "/"),
  HOME: workspace,
  USERPROFILE: workspace,
  APPDATA: join(workspace, "appdata"),
  LOCALAPPDATA: join(workspace, "localappdata"),
};
const entry = join(packageRoot, "scripts/rea.mjs");
const report = {
  ok: false,
  platform: "win32",
  architecture: "x64",
  nonAdmin: true,
  targetSha256: sha256,
  cli: {},
  mcpOperations: [],
  nativeControls: "available",
  runtimeCleanup: false,
};
const assertCleanup = async () => {
  const entries = await readdir(runtimeParent);
  report.runtimeResidualCount = entries.length;
  report.runtimeResidualKinds = entries.map((name) =>
    name.startsWith("rea-")
      ? "rea-runtime"
      : name.startsWith("hsperfdata_")
        ? "jvm-performance-data"
        : "other",
  );
  assert.equal(entries.length, 0, "Provider runtime cleanup left files.");
};
try {
  const providers = JSON.parse(
    (
      await exec(process.execPath, [entry, "providers", "--json"], {
        env: environment,
        cwd: callerDirectory,
        timeout: 30_000,
      })
    ).stdout,
  );
  assert.ok(JSON.stringify(providers).includes("ghidra"));
  report.cli.providers = true;
  const inspected = await exec(
    process.execPath,
    [entry, "inspect", target, "--provider", "ghidra", "--format", "json"],
    {
      env: environment,
      cwd: callerDirectory,
      timeout: 360_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const inspection = JSON.parse(inspected.stdout);
  assert.ok(inspection.error === undefined);
  report.cli.inspect = true;
  await assertCleanup();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    env: environment,
    cwd: callerDirectory,
    stderr: "pipe",
  });
  const client = new Client({
    name: "rea-packaged-windows-ghidra",
    version: "1.0.0",
  });
  const call = async (name, arguments_) => {
    report.lastOperation = name;
    if (process.argv[4] !== undefined)
      await writeFile(process.argv[4], `${JSON.stringify(report)}\n`);
    const contract = TOOL_CONTRACTS.find((value) => value.name === name);
    assert.ok(contract !== undefined, `Missing canonical contract: ${name}`);
    const argumentsParsed = contract.inputSchema.parse(arguments_);
    const result = await client.callTool(
      { name, arguments: argumentsParsed },
      { timeout: 360_000 },
    );
    assert.notEqual(result.isError, true, `Packaged operation failed: ${name}`);
    const structured =
      result.structuredContent ??
      JSON.parse(result.content.find((item) => item.type === "text").text);
    const parsed = contract.outputSchema.parse(structured);
    report.mcpOperations.push(name);
    return parsed.result;
  };
  try {
    await client.connect(transport);
    await call("open_binary", { path: target, provider_id: "ghidra" });
    assert.equal((await call("list_documents", {})).length, 1);
    await call("list_names", {});
    const procedures = await call("list_procedures", {});
    assert.ok(procedures.length > 0);
    assert.ok((await call("list_segments", {})).length > 0);
    await call("list_strings", {});
    const procedure =
      procedures.find((item) => item.procedure?.external === false) ??
      procedures[0];
    assert.ok(procedure !== undefined);
    const loadImage = await call("inspect_native_load_image", {});
    assert.equal(
      loadImage.status,
      "unsupported",
      "PE load-image attestation must remain explicitly unsupported.",
    );
    assert.ok(loadImage.observations !== undefined);
    const memory = await call("read_bytes", {
      address: procedure.address,
      length: 16,
    });
    const mapping = await call("address_to_file_offset", {
      address: procedure.address,
    });
    assert.equal(memory.complete, true);
    assert.equal(memory.returned_bytes, 16);
    assert.equal(
      memory.bytes_hex,
      (await readFile(target))
        .subarray(mapping.file_offset, mapping.file_offset + 16)
        .toString("hex"),
    );
    await call("address_name", { address: procedure.address });
    assert.equal(
      await call("procedure_address", { procedure: procedure.value }),
      procedure.address,
    );
    await call("resolve_containing_procedure", { address: procedure.address });
    await call("search_procedures", { pattern: procedure.value });
    await call("search_strings", { pattern: "rea" });
    for (const name of [
      "procedure_assembly",
      "procedure_callees",
      "procedure_callers",
      "procedure_info",
      "procedure_pseudo_code",
      "read_function_instructions",
      "procedure_references",
      "analyze_function",
    ])
      await call(name, { procedure: procedure.value });
    await call("xrefs", { address: procedure.address });
    await call("inspect_native_data_type", { type: "/undefined8" });
    await call("inspect_native_instruction", { address: procedure.address });
    await call("resolve_native_call_targets", { address: procedure.address });
    const expected = (
      await import(
        pathToFileURL(join(packageRoot, "dist/ghidra/GhidraSessionValues.js"))
      )
    ).GHIDRA_SESSION_CAPABILITIES.filter(
      (name) =>
        name !== "ping" &&
        name !== "shutdown" &&
        name !== "annotate_native_function",
    );
    assert.ok(
      expected.every((name) => report.mcpOperations.includes(name)),
      "Packaged verification omitted an admitted operation.",
    );
    await call("binary_session", {});
    await call("close_binary", {});
    await assertCleanup();
  } finally {
    await client.close();
  }
  assert.equal(
    digest(await readFile(target)),
    sha256,
    "Analysis modified the selected target.",
  );
  assert.deepEqual(
    native.call("process_caller_token", []),
    token,
    "Analysis changed caller token authority.",
  );
  assert.deepEqual((await readdir(callerDirectory)).sort(), scriptCollisions);
  for (const name of scriptCollisions)
    assert.deepEqual(await readdir(join(callerDirectory, name)), []);
  report.callerScriptCollisionsPreserved = true;
  report.runtimeCleanup = true;
  report.ok = true;
  if (process.argv[4] !== undefined)
    await writeFile(process.argv[4], `${JSON.stringify(report)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (cause) {
  report.failure = {
    name: cause.name,
    message: cause.message
      .replaceAll(packageRoot, "<package>")
      .replaceAll(target, "<target>")
      .replaceAll(workspace, "<workspace>"),
  };
  if (process.argv[4] !== undefined)
    await writeFile(process.argv[4], `${JSON.stringify(report)}\n`);
  throw cause;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
