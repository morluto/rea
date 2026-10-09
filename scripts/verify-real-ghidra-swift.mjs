#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { inspectGhidraInstallation } from "../dist/ghidra/GhidraInstallation.js";
import { toolContract } from "../dist/contracts/toolContracts.js";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

const execute = promisify(execFile);
const run = createVerifierRun();
const installation = inspectGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  javaHome: process.env.JAVA_HOME,
});
if (process.platform !== "darwin" || installation.status !== "available")
  throw new Error(
    "verify:ghidra:swift requires macOS, Ghidra 12.1.4 with its native decompiler, and JDK 21; set GHIDRA_INSTALL_DIR and JAVA_HOME.",
  );
try {
  await execute("swiftc", ["--version"], { timeout: 10_000 });
} catch (cause) {
  throw new Error(
    "verify:ghidra:swift requires the host Swift compiler (swiftc).",
    { cause },
  );
}
const root = await mkdtemp(join(tmpdir(), "rea-ghidra-swift-"));
const client = new Client({ name: "ghidra-swift-verifier", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("./rea.mjs", import.meta.url)), "mcp"],
  env: Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => value !== undefined),
  ),
  stderr: "pipe",
});
const source = fileURLToPath(
  new URL("../tests/conformance/swift/type-inventory.swift", import.meta.url),
);
const binary = join(root, "swift-inventory");
const reports = [];
try {
  await execute("swiftc", ["-O", "-g", source, "-o", binary], {
    timeout: 60_000,
  });
  await mkdir(join(root, "copied"));
  const copied = join(root, "copied", "swift-inventory");
  await copyFile(binary, copied);
  await client.connect(transport);
  for (const [variant, path] of [
    ["debug", binary],
    ["without-dsym", copied],
  ]) {
    await call("open_binary", { path, provider_id: "ghidra" });
    try {
      const procedures = await call("list_procedures", {});
      const inventory = await call("analyze_swift_types", {});
      assert(
        inventory.total > 0,
        "Swift procedures disappeared from the inventory",
      );
      assert(
        inventory.categories.other.count > 0,
        "Top-level Swift symbols were lost",
      );
      const structs = await call("analyze_swift_types", {
        category: "structs",
      });
      assert(
        structs.categories.structs.count > 0,
        "Modern struct symbols were lost",
      );
      const metadata = await call("analyze_swift_types", {
        category: "structs",
        pattern: "VMa",
      });
      assert.equal(
        metadata.total,
        2,
        "Pair and Scorer metadata accessors must both be classified",
      );
      const pair = await call("analyze_swift_types", {
        category: "structs",
        pattern: "Pair",
      });
      assert(pair.total > 0, "Literal name filtering lost Pair symbols");
      const unresolved = await call("analyze_swift_types", {
        category: "structs",
        pattern: "swiftIndirect",
      });
      assert(
        unresolved.unclassified.length > 0,
        "Unsupported categories must remain explicit",
      );
      const entries = Object.values(inventory.categories).flatMap(
        (category) => category.items,
      );
      assert.equal(
        new Set(entries.map((entry) => entry.name)).size,
        inventory.total,
      );
      assert(
        !entries.some(
          (entry) =>
            entry.name === "entry" || entry.name === "_swift_allocObject",
        ),
      );
      for (const entry of entries)
        assert(
          procedures.some(
            (procedure) =>
              procedure.address === entry.address &&
              procedure.value === entry.name,
          ),
        );
      reports.push({
        variant,
        total: inventory.total,
        structs: structs.total,
        metadata_accessors: metadata.total,
        unclassified: inventory.unclassified.length,
      });
    } finally {
      await call("close_binary", {});
    }
  }
} finally {
  await client.close();
  await transport.close();
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      ok: true,
      provider: "ghidra",
      fixtures: reports,
      verifier_run: await completeVerifierRun(run),
    },
    null,
    2,
  ),
);

async function call(name, arguments_) {
  const response = await client.callTool(
    { name, arguments: arguments_ },
    { timeout: 180_000 },
  );
  if (name === "analyze_swift_types")
    toolContract(name).outputSchema.parse(response.structuredContent);
  return requireMcpOperationResult(response, name);
}
