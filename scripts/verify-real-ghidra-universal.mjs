#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../dist/domain/evidence.js";
import {
  createGhidraVerifierMcpOperations,
  resolveGhidraVerifierTimeouts,
} from "./lib/ghidra-verifier-timeouts.mjs";
import {
  mcpTextValue,
  requireMcpOperationResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";

// Public CLI/MCP file coordinates of a universal Mach-O name the container
// that Evidence names, while Ghidra imports only the admitted slice.
if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-universal.mjs");
if (process.platform !== "darwin")
  throw new Error("verify:ghidra:universal supports macOS hosts only.");
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "verify:ghidra:universal prerequisite missing: GHIDRA_INSTALL_DIR (bring your own Ghidra).",
  );
const run = promisify(execFile);
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const source = fileURLToPath(
  new URL("../tests/conformance/ghidra/inventory.c", import.meta.url),
);
const host = process.arch === "arm64" ? "arm64" : "x86_64";
const hostCpu = host === "arm64" ? 0x0100000c : 0x01000007;
const workspace = await mkdtemp(join(tmpdir(), "rea-universal-"));
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const targetPath = join(workspace, "universal");
await run(process.env.REA_CLANG ?? "clang", [
  "-O0",
  "-arch",
  "x86_64",
  "-arch",
  "arm64",
  "-o",
  targetPath,
  source,
]);
const original = await readFile(targetPath);
const sha256 = createHash("sha256").update(original).digest("hex");
assert.equal(original.readUInt32BE(0), 0xcafebabe, "fixture is a FAT file");
const slices = Array.from({ length: original.readUInt32BE(4) }, (_, index) => ({
  cpu: original.readUInt32BE(8 + index * 20),
  offset: original.readUInt32BE(16 + index * 20),
}));
assert.equal(slices.length, 2);
const slice = slices.find(({ cpu }) => cpu === hostCpu);
assert.ok(slice && slice.offset > 0, "host slice at a nonzero offset");
const symbols = (await run("nm", ["-arch", host, targetPath])).stdout;
const symbol = /^([0-9a-f]+) T _rea_ghidra_inventory_entry$/mu.exec(symbols);
assert.ok(symbol, "fixture exports rea_ghidra_inventory_entry");
// The linker maps __TEXT at 0x100000000 from slice offset 0.
const local = Number(BigInt(`0x${symbol[1]}`) - 0x100000000n);
assert.ok(local > 0 && local < slice.offset);
const address = `0x${BigInt(`0x${symbol[1]}`).toString(16)}`;
const expected = slice.offset + local;

const environment = {
  ...process.env,
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_LOG_LEVEL: "silent",
  TMPDIR: runtime,
};
const { requestOptions } = resolveGhidraVerifierTimeouts(environment);
const client = new Client({ name: "rea-universal-offsets", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: environment,
  stderr: "pipe",
});
const mcp = createGhidraVerifierMcpOperations(client, requestOptions);
const call = async (name, arguments_ = {}) => {
  const result = await mcp.callTool({ name, arguments: arguments_ });
  const projected = requireMcpOperationResult(result, name);
  return ["open_binary", "close_binary"].includes(name)
    ? projected
    : (result.structuredContent ?? JSON.parse(mcpTextValue(result)));
};
const assertContainerSubject = (evidence) => {
  assert.equal(evidence.subject.identity.sha256, sha256);
  assert.equal(evidence.subject.identity.format, "mach-o-universal");
  assert.equal(evidence.subject.identity.selection.offset, slice.offset);
};
let complete = false;
try {
  await mcp.connect(transport);
  await call("open_binary", { path: targetPath, provider_id: "ghidra" });
  const mapping = parseEvidence(
    await call("address_to_file_offset", { address }),
  );
  assertContainerSubject(mapping);
  assert.equal(mapping.normalized_result.file_offset, expected);
  const selected = parseEvidence(
    await call("procedure_pseudo_code", {
      procedure: `file-offset:0x${expected.toString(16)}`,
    }),
  );
  assertContainerSubject(selected);
  assert.equal(selected.raw_result.selection.mapped_address, address);
  assert.equal(selected.raw_result.selection.file_offset, expected);
  const sliceLocal = await mcp.callTool({
    name: "procedure_pseudo_code",
    arguments: { procedure: `file-offset:0x${local.toString(16)}` },
  });
  assert.ok(
    JSON.stringify(requireMcpToolError(sliceLocal)).includes(
      "no loaded source mapping",
    ),
  );
  await call("close_binary");
  await client.close();
  const cli = parseEvidence(
    JSON.parse(
      (
        await run(
          process.execPath,
          [
            entrypoint,
            "address-to-file-offset",
            targetPath,
            address,
            "--provider",
            "ghidra",
            "--json",
          ],
          { env: environment, timeout: requestOptions.timeout },
        )
      ).stdout,
    ),
  );
  assertContainerSubject(cli);
  assert.equal(cli.normalized_result.file_offset, expected);
  assert.deepEqual(await readFile(targetPath), original);
  assert.deepEqual(await readdir(runtime), []);
  complete = true;
  process.stdout.write(
    `${JSON.stringify({
      host_architecture: host,
      slice_offset: slice.offset,
      universal_file_offset: expected,
      container_evidence_identity: true,
      cli_mcp_parity: true,
      slice_local_selector_rejected: true,
      source_unchanged: true,
      cleanup: "complete",
    })}\n`,
  );
} finally {
  await client.close();
  if (complete) await rm(workspace, { recursive: true, force: true });
  else
    process.stderr.write(
      `Retained universal verifier workspace: ${workspace}\n`,
    );
}
