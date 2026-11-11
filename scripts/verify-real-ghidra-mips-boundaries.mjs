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
import { assertMipsLoadedImage } from "../tests/conformance/ghidra/mips-checks.mjs";
import { buildMips1Fixture } from "../tests/conformance/ghidra/mips1-fixture.mjs";
import {
  createGhidraVerifierMcpOperations,
  resolveGhidraVerifierTimeouts,
} from "./lib/ghidra-verifier-timeouts.mjs";
import {
  requireMcpOperationResult,
  requireMcpOutput,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { prepareVerifierTokenCleanup } from "./lib/verifier-token-cleanup.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import {
  assertVerifierCleanupComplete,
  createVerifierRun,
  completeVerifierRun,
} from "./lib/verifier-run.mjs";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { parseEvidence } from "../dist/domain/evidence.js";

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
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cli = fileURLToPath(new URL("./rea.mjs", import.meta.url));
// Only declared tool prerequisites and resource settings reach REA children.
// Ambient REA seeds, analyzer controls and session settings cannot alter controls.
const environment = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_LOG_LEVEL: "silent",
  GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
  JAVA_HOME: process.env.JAVA_HOME,
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
};
for (const setting of [
  "GHIDRA_HEADLESS_MAXMEM",
  "GHIDRA_MAXMEM",
  "REA_GHIDRA_STARTUP_TIMEOUT_MS",
]) {
  if (process.env[setting] !== undefined)
    environment[setting] = process.env[setting];
}
const { requestOptions } = resolveGhidraVerifierTimeouts(environment);
const run = createVerifierRun();
const root = await mkdtemp(join(tmpdir(), "rea-mips-boundaries-"));
const env = { ...environment, TMPDIR: root, REA_PROCESS_RUN_ID: run.run_id };
const reports = [];
async function runControls(cleanup) {
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
      process.env.REA_MIPS_READELF ?? "readelf",
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
    const mcp = createGhidraVerifierMcpOperations(client, requestOptions);
    const invoke = (name, args = {}) => mcp.callTool({ name, arguments: args });
    const call = async (name, args = {}) =>
      requireMcpOperationResult(await invoke(name, args), name);
    const currentGhidraRun = async () => {
      const status = await call("binary_session");
      assert.equal(status.open, true);
      assert.equal(status.analysis_provider_binding?.provider.id, "ghidra");
      assert.ok(
        status.analysis_run,
        "Ghidra session run receipt is unavailable",
      );
      return status.analysis_run;
    };
    await withVerifierCleanup(async () => {
      await mcp.connect(transport);
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
            { env, timeout: requestOptions.timeout },
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
        // The session ID is authoritative before analyze_function can launch
        // Ghidra. Its token stays in the sweep even if that first call fails.
        const providerRunId = (await currentGhidraRun()).run_id;
        cleanup.registerProviderRun(providerRunId);
        const evidence = parseEvidence(
          requireMcpOutput(
            await invoke("analyze_function", {
              procedure: original.entry,
              detail: "complete",
            }),
            "analyze_function",
          ),
        );
        const dossier = functionDossierSchema.parse(evidence.normalized_result);
        assert.ok(dossier.pseudocode.length > 0);
        const activeRun = await currentGhidraRun();
        assert.equal(activeRun.run_id, providerRunId);
        const providerLineage = activeRun.process_lineage.snapshots?.find(
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
        await cleanup.retainProviderRun(providerRunId, providerScope);
        const isMips1 = path === recordlessMips1Path;
        // The provider's session limitations belong to the public Evidence;
        // the normalized function payload has its own local observations.
        const mips1Limitation = evidence.limitations.find((limitation) =>
          /generic 32-bit MIPS language.*conformance to the MIPS-I subset is not established/u.test(
            limitation,
          ),
        );
        if (isMips1)
          assert.ok(
            mips1Limitation,
            "MIPS-I dossier Evidence omitted its decoder limitation",
          );
        else
          assert.equal(
            mips1Limitation,
            undefined,
            "MIPS32 dossier Evidence reports a MIPS-I decoder limitation",
          );
        const image = await call("inspect_native_load_image");
        assertMipsLoadedImage(image.observations, byteOrder, digest(expected));
        providerRuns.push({
          control: isMips1 ? "recordless_mips1" : "recordless_mips32",
          run_id: providerRunId,
          language_id: image.observations.language_id,
          ...(isMips1 ? { dossier_evidence_limitation: mips1Limitation } : {}),
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
          "real Ghidra dossier with decoder limitation, pinned 32-bit import language and exact loaded bytes; load-delay semantics unverified",
        gnu_fp_attributes:
          "independently decoded soft-float declaration; refused by CLI and MCP",
        existing_mips32_control:
          "real Ghidra dossier, pinned 32-bit import language and exact loaded bytes",
        hashes: {
          mips1: digest(initial),
          gnu: digest(gnu),
          legacy: digest(legacy),
          recordless_mips1: digest(recordlessMips1),
        },
        source_unchanged: true,
        target_executed: false,
      });
    }, [() => client.close(), () => transport.close()]);
  }
}
let tokenCleanup;
let completed;
try {
  const cleanup = await prepareVerifierTokenCleanup(run);
  await withVerifierCleanup(
    () => runControls(cleanup),
    [
      async () => {
        tokenCleanup = await cleanup.verify();
        if (!tokenCleanup.cleaned)
          throw new Error(
            `Token cleanup unverified: ${JSON.stringify(tokenCleanup)}`,
          );
      },
      cleanup.close,
      async () => {
        completed = await completeVerifierRun(run);
        assertVerifierCleanupComplete(completed.process_lineage);
      },
    ],
  );
} catch (cause) {
  throw new Error(
    `MIPS boundary verification failed; retained workspace: ${root}`,
    { cause },
  );
}
await rm(root, { recursive: true, force: true });
console.log(
  JSON.stringify(
    { ...completed, token_cleanup: tokenCleanup, status: "passed", reports },
    null,
    2,
  ),
);
