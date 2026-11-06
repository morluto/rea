#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildMips1Fixture } from "../tests/conformance/ghidra/mips1-fixture.mjs";
import {
  requireMcpOperationResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { prepareVerifierTokenCleanup } from "./lib/verifier-token-cleanup.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";

// Static source-owned controls. Never execute an ELF or acquire a toolchain.
if (!["darwin", "linux"].includes(process.platform))
  throw new Error(
    "MIPS boundary verification requires a Linux/macOS Ghidra host with verified process lineage.",
  );
if (!process.env.GHIDRA_INSTALL_DIR || !process.env.JAVA_HOME)
  throw new Error(
    "Supply GHIDRA_INSTALL_DIR and JAVA_HOME for the MIPS32 positive control.",
  );
const execute = promisify(execFile);
const run = createVerifierRun();
const root = await mkdtemp(join(tmpdir(), "rea-mips-boundaries-"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cli = fileURLToPath(new URL("./rea.mjs", import.meta.url));
// Only declared tool prerequisites and resource settings reach REA children.
// Ambient REA seeds, analyzer controls and session settings cannot alter controls.
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: root,
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_LOG_LEVEL: "silent",
  REA_PROCESS_RUN_ID: run.run_id,
  GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
  JAVA_HOME: process.env.JAVA_HOME,
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
};
for (const setting of ["GHIDRA_HEADLESS_MAXMEM", "GHIDRA_MAXMEM"]) {
  if (process.env[setting] !== undefined) env[setting] = process.env[setting];
}
const reports = [];
let primaryFailure;
const cleanup = await prepareVerifierTokenCleanup(run);
try {
  for (const byteOrder of ["little", "big"]) {
    const original = await buildMips1Fixture(root, byteOrder);
    const initial = await readFile(original.path);
    const legacy = Buffer.from(initial);
    const u32 = (bytes, offset, value) =>
      byteOrder === "little"
        ? bytes.writeUInt32LE(value, offset)
        : bytes.writeUInt32BE(value, offset);
    const u16 = (bytes, offset, value) =>
      byteOrder === "little"
        ? bytes.writeUInt16LE(value, offset)
        : bytes.writeUInt16BE(value, offset);
    u32(legacy, 36, 0x50000001); // Existing recordless MIPS32 lane.
    const legacyPath = join(root, `legacy-${byteOrder}.elf`);
    await writeFile(legacyPath, legacy);
    const recordlessMips1 = Buffer.from(initial);
    u32(recordlessMips1, 36, 0x1);
    const recordlessMips1Path = join(root, `recordless-mips1-${byteOrder}.elf`);
    await writeFile(recordlessMips1Path, recordlessMips1);
    const gnu = Buffer.alloc(0x1200);
    legacy.copy(gnu);
    u32(gnu, 68, gnu.length);
    u32(gnu, 72, gnu.length);
    u16(gnu, 48, 6);
    u32(gnu, 0x1188 + 4, 0x6ffffff5);
    u32(gnu, 0x1188 + 16, 0x11d0);
    u32(gnu, 0x1188 + 20, 16);
    gnu[0x11d0] = 0x41;
    u32(gnu, 0x11d1, 15);
    gnu.write("gnu\0", 0x11d5, "ascii");
    gnu[0x11d9] = 1;
    u32(gnu, 0x11da, 7);
    gnu[0x11de] = 4; // Tag_GNU_MIPS_ABI_FP
    gnu[0x11df] = 3; // Soft float.
    const gnuPath = join(root, `gnu-fp-${byteOrder}.elf`);
    await writeFile(gnuPath, gnu);
    const { stdout: attributes } = await execute(
      process.env.REA_READELF ?? "readelf",
      ["-A", gnuPath],
      { env: { PATH: env.PATH, LC_ALL: "C" } },
    );
    assert.match(attributes, /Tag_GNU_MIPS_ABI_FP.*Soft float/iu);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "mcp"],
      env,
      stderr: "inherit",
    });
    const client = new Client({ name: "rea-mips-boundaries", version: "1" });
    const invoke = (name, args = {}) =>
      client.callTool({ name, arguments: args }, { timeout: 240_000 });
    const call = async (name, args = {}) =>
      requireMcpOperationResult(await invoke(name, args), name);
    try {
      await client.connect(transport);
      for (const [path, pattern] of [
        [
          original.path,
          /requires EF_MIPS_ARCH_32R2 for headers that declare an ABI/u,
        ],
        [gnuPath, /GNU floating-point ABI attribute/u],
      ]) {
        const error = requireMcpToolError(
          await invoke("open_binary", { path, provider_id: "ghidra" }),
        );
        assert.match(JSON.stringify(error), pattern);
        let stdout;
        try {
          await execute(
            process.execPath,
            [
              cli,
              "function",
              path,
              original.entry,
              "--provider",
              "ghidra",
              "--full-output",
              "--json",
            ],
            { env, timeout: 240_000 },
          );
          assert.fail("CLI admitted an unsupported MIPS declaration");
        } catch (cause) {
          assert.equal(cause.code, 1);
          stdout = cause.stdout;
        }
        const reply = JSON.parse(stdout);
        assert.equal(reply.ok, false);
        assert.match(JSON.stringify(reply), pattern);
      }
      const providerRuns = [];
      for (const [path, expected] of [
        [legacyPath, legacy],
        [recordlessMips1Path, recordlessMips1],
      ]) {
        await call("open_binary", { path, provider_id: "ghidra" });
        // Composite open/health does not launch Ghidra; analyze_function does.
        const dossier = functionDossierSchema.parse(
          await call("analyze_function", {
            procedure: original.entry,
            detail: "complete",
          }),
        );
        assert.ok(dossier.pseudocode.length > 0);
        const status = await call("binary_session");
        assert.equal(status.analysis_provider_binding?.provider.id, "ghidra");
        assert.equal(typeof status.analysis_run?.run_id, "string");
        // The session owner generated this ID, and the launcher installs it on
        // Ghidra in place of the surrounding verifier's process-run token.
        assert.equal(status.open, true);
        const providerLineage =
          status.analysis_run.process_lineage.snapshots?.find(
            ({ provider }) => provider.id === "ghidra",
          )?.observation;
        const providerScope =
          providerLineage?.status === "verified"
            ? {
                leaderPid: providerLineage.launcher_pid,
                processGroupId: providerLineage.process_group_id,
                sampledProcessGroupIds: providerLineage.descendants.map(
                  ({ process_group_id }) => process_group_id,
                ),
              }
            : undefined;
        // Capture native token-verified identities while the provider is live;
        // A public lineage snapshot is optional; native ownership is mandatory.
        await cleanup.retainProviderRun(
          status.analysis_run.run_id,
          providerScope,
        );
        providerRuns.push({
          control:
            path === legacyPath ? "recordless_mips32" : "recordless_mips1",
          run_id: status.analysis_run.run_id,
          ...(providerScope === undefined
            ? { public_lineage: "not_observed" }
            : providerScope),
        });
        const loaded = await call("read_bytes", {
          address: original.entry,
          length: 24,
        });
        assert.equal(
          loaded.bytes_hex,
          expected.subarray(0x1000, 0x1018).toString("hex"),
        );
        await call("close_binary");
      }
      assert.deepEqual(await readFile(original.path), initial);
      assert.deepEqual(await readFile(gnuPath), gnu);
      assert.deepEqual(await readFile(legacyPath), legacy);
      assert.deepEqual(await readFile(recordlessMips1Path), recordlessMips1);
      reports.push({
        byte_order: byteOrder,
        provider_runs: providerRuns,
        declared_o32_mips1: "refused by CLI and MCP",
        recordless_mips1:
          "real Ghidra dossier and exact loaded bytes; instruction subset/load-delay semantics unverified",
        gnu_fp_attributes:
          "independently decoded soft-float declaration; refused by CLI and MCP",
        existing_mips32_control: "real Ghidra dossier and exact loaded bytes",
        hashes: {
          mips1: digest(initial),
          gnu: digest(gnu),
          legacy: digest(legacy),
          recordless_mips1: digest(recordlessMips1),
        },
        source_unchanged: true,
        target_executed: false,
      });
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
  }
} catch (cause) {
  primaryFailure = cause;
}
let tokenCleanup;
try {
  tokenCleanup = await cleanup.verify();
} finally {
  await cleanup.close();
}
const completed = await completeVerifierRun(run);
if (
  !tokenCleanup.cleaned ||
  completed.process_lineage.status !== "verified" ||
  completed.process_lineage.descendants.length !== 0
)
  throw new Error(
    `Cleanup unverified (${JSON.stringify(tokenCleanup)}); retained diagnostic workspace: ${root}`,
    { cause: primaryFailure },
  );
if (primaryFailure !== undefined)
  throw new Error(
    `MIPS boundary verification failed; retained workspace: ${root}`,
    { cause: primaryFailure },
  );
await rm(root, { recursive: true, force: true });
console.log(
  JSON.stringify(
    { ...completed, token_cleanup: tokenCleanup, status: "passed", reports },
    null,
    2,
  ),
);
