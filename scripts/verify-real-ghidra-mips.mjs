#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import {
  inspectMipsReadelf,
  assertMipsLoadedImage,
  assertMipsProbe,
  assertMipsGlobal,
} from "../tests/conformance/ghidra/mips-checks.mjs";
import { parseEvidence } from "../dist/domain/evidence.js";
import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { functionDossierSchema } from "../dist/domain/hopperValues.js";
import { inspectGhidraInstallation } from "../dist/ghidra/GhidraInstallation.js";
import { buildMipsFixture } from "../tests/conformance/ghidra/mips-fixture.mjs";
import {
  buildPspFixture,
  assertPspLoadedImage,
  assertPspProbe,
} from "../tests/conformance/ghidra/psp-fixture.mjs";
import {
  requireMcpToolError,
  requireMcpOperationResult,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

// Optional cross-target lane. No tool acquisition and no target execution.
const mode = process.argv[2];
const psp = mode === "--psp" || mode === "--psp-missing-extension";
const missingExtension = mode === "--psp-missing-extension";
if (process.argv.length > 3 || (mode !== undefined && !psp))
  throw new Error(
    "Usage: node scripts/verify-real-ghidra-mips.mjs [--psp|--psp-missing-extension]",
  );
const prefix = psp ? "rea_psp" : "rea_mips";
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "MIPS verification requires a supported Linux/macOS Ghidra host",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error("Missing prerequisite: caller-supplied GHIDRA_INSTALL_DIR");
const installation = inspectGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (installation.status !== "available")
  throw new Error(
    `Ghidra prerequisite unavailable: ${JSON.stringify(installation)}`,
  );
const execute = promisify(execFile);
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-mips-proof-"));
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
  GHIDRA_INSTALL_DIR: installation.installDir,
  JAVA_HOME: installation.javaHome,
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
};
const reports = [];
let primaryFailure;
try {
  for (const byteOrder of psp ? ["little"] : ["little", "big"]) {
    const fixture = psp
      ? await buildPspFixture(workspace)
      : await buildMipsFixture(workspace, byteOrder);
    const independent = psp
      ? fixture
      : await inspectMipsReadelf(fixture.path, byteOrder);
    const resolved = await parseBinaryTarget(fixture.path);
    if (!resolved.ok) throw resolved.error;
    if (psp) {
      assert.equal(resolved.value.mips.flags, 0x10a23001);
      assert.deepEqual(
        resolved.value.mips,
        independent.mips,
        "REA PSP ELF/ABI interpretation disagrees with GNU readelf and raw ABI bytes",
      );
    } else {
      assert.deepEqual(
        resolved.value.mips,
        independent.mips,
        "REA ELF/ABI interpretation disagrees with GNU readelf",
      );
    }
    assert.equal(resolved.value.sha256, fixture.sha256);
    const snapshotPath = join(workspace, `${byteOrder}.snapshot.json`);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "mcp"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "rea-real-mips-proof", version: "1" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    const call = async (name, args = {}) => {
      const reply = await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: 180000 },
      );
      return requireMcpOperationResult(reply, name);
    };
    try {
      await client.connect(transport);
      if (missingExtension) {
        const rejected = await client.callTool(
          {
            name: "open_binary",
            arguments: { path: fixture.path, provider_id: "ghidra" },
          },
          undefined,
          { timeout: 60000 },
        );
        const error = requireMcpToolError(rejected);
        assert.match(JSON.stringify(error), /PSP_EXTENSION_UNAVAILABLE/u);
        let cliError;
        try {
          await execute(
            process.execPath,
            [
              entrypoint,
              "function",
              fixture.path,
              `${prefix}_entry`,
              "--provider",
              "ghidra",
              "--json",
            ],
            { env, timeout: 60000, maxBuffer: 1024 * 1024 },
          );
        } catch (cause) {
          cliError = cause;
        }
        assert.ok(
          cliError && Number.isInteger(cliError.code) && cliError.code !== 0,
          "Expected a typed public rejection, not a timeout or success",
        );
        assert.match(
          `${cliError.stdout}\n${cliError.stderr}`,
          /PSP_EXTENSION_UNAVAILABLE/u,
        );
        reports.push({
          path: fixture.path,
          status: "expected-missing-extension-refusal",
          cli_exit: cliError.code,
          mcp_error: error,
        });
        continue;
      }
      const target = await call("open_binary", {
        path: fixture.path,
        provider_id: "ghidra",
      });
      assert.equal(target.architecture, "mips");
      assert.equal(target.sha256, fixture.sha256);
      // ELF load-image verification is not the DOS comparison lane. Its retained
      // observations still expose the actual Ghidra language and loaded bytes.
      const image = await call("inspect_native_load_image");
      if (psp) assertPspLoadedImage(image.observations, fixture.sha256);
      else assertMipsLoadedImage(image.observations, byteOrder, fixture.sha256);
      const procedures = await call("list_procedures");
      const entry = procedures.find((p) => p.value === `${prefix}_entry`);
      const leaf = procedures.find((p) => p.value === `${prefix}_leaf`);
      assert.ok(entry, "Entry function missing from real Ghidra inventory");
      assert.ok(leaf, "Leaf function missing from real Ghidra inventory");
      assert.equal(
        BigInt(entry.address),
        BigInt(independent.symbols[`${prefix}_entry`]),
      );
      assert.equal(
        BigInt(leaf.address),
        BigInt(independent.symbols[`${prefix}_leaf`]),
      );
      const probe = independent.symbols[`${prefix}_probe`];
      assert.ok(
        procedures.some(
          (p) =>
            p.value === `${prefix}_probe` &&
            BigInt(p.address) === BigInt(probe),
        ),
      );
      const move = await call("inspect_native_instruction", { address: probe });
      const branch = await call("inspect_native_instruction", {
        address: `0x${(BigInt(probe) + 4n).toString(16)}`,
      });
      if (psp) assertPspProbe(move, branch);
      else assertMipsProbe(move, branch, byteOrder, probe);
      const global = await call("read_bytes", {
        address: independent.symbols[`${prefix}_global`],
        length: 4,
      });
      assert.equal(global.returned_bytes, 4);
      assertMipsGlobal(global.bytes_hex, byteOrder);
      const marker = await call("read_bytes", {
        address: independent.symbols[`${prefix}_marker`],
        length: Buffer.byteLength(
          psp
            ? "rea-psp-source-owned-fixture\0"
            : "rea-mips-source-owned-fixture\0",
        ),
      });
      assert.equal(
        marker.bytes_hex,
        Buffer.from(
          psp
            ? "rea-psp-source-owned-fixture\0"
            : "rea-mips-source-owned-fixture\0",
        ).toString("hex"),
      );
      const callees = await call("procedure_callees", {
        procedure: entry.address,
      });
      assert.ok(
        callees.includes(leaf.address),
        "Expected direct call not recovered",
      );
      const assembly = await call("procedure_assembly", {
        procedure: entry.address,
      });
      assert.ok(assembly.trim().length > 0);
      const dossier = functionDossierSchema.parse(
        await call("analyze_function", { procedure: entry.address }),
      );
      assert.ok(dossier.pseudocode.trim().length > 0);
      const mapping = await call("address_to_file_offset", {
        address: entry.address,
      });
      const memory = await call("read_bytes", {
        address: entry.address,
        length: 16,
      });
      const sourceBytes = await readFile(fixture.path);
      assert.equal(memory.returned_bytes, 16);
      assert.equal(
        memory.bytes_hex,
        sourceBytes
          .subarray(mapping.file_offset, mapping.file_offset + 16)
          .toString("hex"),
      );
      const saved = await call("close_binary", {
        snapshot_path: snapshotPath,
      });
      assert.ok(saved.evidence_records > 0);
      const snapshot = parseAnalysisSnapshot(
        JSON.parse(await readFile(snapshotPath, "utf8")),
      );
      assert.equal(snapshot.target.architecture, "mips");
      const abi = independent.mips.abiFlags;
      assert.deepEqual(
        snapshot.binding.analysis_profile.parameters.mips_elf,
        {
          elf_class: independent.mips.elfClass,
          byte_order: independent.mips.byteOrder,
          type: independent.mips.type,
          flags: independent.mips.flags,
          abi_flags: {
            version: abi.version,
            isa_level: abi.isaLevel,
            isa_revision: abi.isaRevision,
            gpr_size: abi.gprSize,
            cpr1_size: abi.cpr1Size,
            cpr2_size: abi.cpr2Size,
            fp_abi: abi.fpAbi,
            isa_extension: abi.isaExtension,
            ases: abi.ases,
            flags1: abi.flags1,
            flags2: abi.flags2,
          },
        },
        "Snapshot profile did not retain the independently inspected ELF/ABI declaration",
      );
      assert.ok(snapshot.evidence_bundle.records.length > 0);
      if (psp) {
        assert.equal(
          snapshot.binding.analysis_profile.parameters.language_id,
          "Allegrex:LE:32:default",
        );
        assert.match(
          snapshot.binding.analysis_profile.parameters.psp_extension.sha256,
          /^[a-f0-9]{64}$/u,
        );
        assert.ok(
          snapshot.evidence_bundle.records.some((record) =>
            JSON.stringify(record).includes("VFPU prefix"),
          ),
          "PSP limitations missing from retained Evidence",
        );
      }
      for (const evidence of snapshot.evidence_bundle.records)
        assert.equal(parseEvidence(evidence).subject?.architecture, "mips");
      await call("open_binary", {
        path: fixture.path,
        provider_id: "ghidra",
        snapshot_path: snapshotPath,
      });
      assert.deepEqual(await call("list_procedures"), procedures);
      await call("close_binary");

      if (psp) {
        const alternate = join(workspace, "alternate");
        await mkdir(alternate);
        const other = await buildPspFixture(alternate, 11);
        assert.notEqual(other.sha256, fixture.sha256);
        assert.equal(
          other.symbols.rea_psp_global,
          fixture.symbols.rea_psp_global,
          "Target-switch control must reuse the same global address",
        );
        for (const item of [fixture, other, fixture]) {
          const selected = await call("open_binary", {
            path: item.path,
            provider_id: "ghidra",
          });
          assert.equal(selected.sha256, item.sha256);
          const word = await call("read_bytes", {
            address: item.symbols.rea_psp_global,
            length: 4,
          });
          const expected = Buffer.alloc(4);
          expected.writeUInt32LE(item.global_value);
          assert.equal(word.bytes_hex, expected.toString("hex"));
          await call("close_binary");
        }
        const wrongSnapshot = await client.callTool(
          {
            name: "open_binary",
            arguments: {
              path: other.path,
              provider_id: "ghidra",
              snapshot_path: snapshotPath,
            },
          },
          undefined,
          { timeout: 180000 },
        );
        requireMcpToolError(wrongSnapshot);
        // A bad snapshot must not poison the next clean public session.
        await call("open_binary", {
          path: fixture.path,
          provider_id: "ghidra",
        });
        await call("close_binary");
      }

      // Same public operation through CLI, not a private injected provider.
      const cli = await execute(
        process.execPath,
        [
          entrypoint,
          "function",
          fixture.path,
          `${prefix}_entry`,
          "--provider",
          "ghidra",
          "--json",
        ],
        { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
      );
      const evidence = parseEvidence(JSON.parse(cli.stdout));
      assert.equal(evidence.subject?.architecture, "mips");
      assert.equal(evidence.subject?.digest.sha256, fixture.sha256);
      const cliDossier = functionDossierSchema.parse(
        evidence.normalized_result,
      );
      assert.equal(cliDossier.procedure.address, dossier.procedure.address);
      assert.ok(cliDossier.pseudocode.trim().length > 0);
      assert.equal(
        createHash("sha256")
          .update(await readFile(fixture.path))
          .digest("hex"),
        fixture.sha256,
        "Analysis modified the source executable",
      );
      reports.push({
        ...fixture,
        independent_reader: independent,
        effective_language: image.observations.language_id,
        effective_compiler_spec: image.observations.compiler_spec_id,
        checks: [
          "independent ELF/ABI and symbols",
          "loaded Ghidra identity",
          "fixed instruction bytes and immediate",
          psp
            ? "Allegrex BITREV decoding and A-B-A target identity"
            : "conditional branch destination",
          "global word and marker bytes",
          "CLI/MCP and snapshot identity",
        ],
        procedures: procedures.length,
        status: "passed",
      });
    } catch (cause) {
      throw new Error(
        `MIPS ${byteOrder} verification failed; MCP stderr: ${stderr}`,
        { cause },
      );
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
const completed = await completeVerifierRun(run);
if (
  completed.process_lineage.status !== "verified" ||
  completed.process_lineage.descendants.length !== 0
)
  throw new Error(
    `Cleanup unverified; retained diagnostic workspace: ${workspace}`,
    { cause: primaryFailure },
  );
if (primaryFailure !== undefined)
  throw new Error(
    `MIPS verification failed; retained workspace: ${workspace}`,
    {
      cause: primaryFailure,
    },
  );
await rm(workspace, { recursive: true, force: true });
console.log(JSON.stringify({ ...completed, fixtures: reports }, null, 2));
