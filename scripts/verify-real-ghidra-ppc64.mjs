#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import {
  inspectPowerPc64Readelf,
  assertPowerPc64EntryPair,
  assertPowerPc64Global,
  assertPowerPc64LoadedImage,
  assertPowerPc64Probe,
} from "../tests/conformance/ghidra/ppc-checks.mjs";
import { parseEvidence } from "../dist/domain/evidence.js";
import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { buildPowerPc64Fixture } from "../tests/conformance/ghidra/ppc-fixture.mjs";
import {
  requireMcpOperationResult,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";
import {
  FIXTURE_TOOLS,
  fixtureCommand,
  requireLaneToolchain,
} from "../tests/conformance/ghidra/fixture-toolchain.mjs";

// Optional cross-target lane. No tool acquisition and no target execution.
if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-ppc64.mjs");
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "PPC64 verification requires a supported Linux/macOS Ghidra host",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error("Missing prerequisite: caller-supplied GHIDRA_INSTALL_DIR");
const installation = await inspectVerifierGhidraInstallation({
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
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const run = createVerifierRun();
// Refuse a host without the fixture toolchain before allocating anything.
await requireLaneToolchain("ppc64");
const workspaceFixture = await VerifierFixture.open({
  prefix: "rea-ppc64-proof-",
  // Ghidra children use the workspace as TMPDIR; a plain root admits them on every host.
  private: false,
});
const workspace = workspaceFixture.path;
// A failed run keeps its workspace for diagnosis; the fixture records why.
const retainWorkspace = (message, options) => {
  workspaceFixture.retain(message);
  return new Error(message, options);
};
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
for (const setting of ["GHIDRA_HEADLESS_MAXMEM", "GHIDRA_MAXMEM"]) {
  if (process.env[setting] !== undefined) env[setting] = process.env[setting];
}
const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
// Compiler, reader and CLI launches share one command owner. Its process group is what
// a timeout stops, including a linker that would otherwise outlive Clang.
const commands = await createVerifierCommands();

/** A position-independent shared object the bounded lane must refuse by name. */
const buildSharedObject = async (directory) => {
  const path = join(directory, "powerpc64le-unknown-linux-gnu.so");
  await commands.exec(
    fixtureCommand(FIXTURE_TOOLS.ppcClang),
    [
      "--target=powerpc64le-unknown-linux-gnu",
      "-mabi=elfv2",
      "-fPIC",
      "-shared",
      "-fuse-ld=lld",
      "-nostdlib",
      "-Wl,--build-id=none",
      fileURLToPath(new URL("../tests/conformance/c/ppc64.c", import.meta.url)),
      "-o",
      path,
    ],
    { timeout: 60000 },
  );
  return path;
};

const reports = [];
let primaryFailure;
try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-real-ppc64-proof", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-65536);
  });
  const call = async (name, args = {}) => {
    const reply = await client.callTool(
      { name, arguments: args },
      { timeout: 180000 },
    );
    return requireMcpOperationResult(reply, name);
  };
  const dossier = async (procedure) =>
    functionDossierSchema.parse(
      await call("analyze_function", { procedure, detail: "complete" }),
    );
  try {
    await client.connect(transport);

    // Shared images stay outside the lane, refused before Ghidra starts.
    const shared = await buildSharedObject(workspace);
    const rejected = await client.callTool({
      name: "open_binary",
      arguments: { path: shared, provider_id: "ghidra" },
    });
    // powerPc64UnsupportedReason refuses ET_DYN before Ghidra starts.
    const rejectedError = requireMcpToolError(rejected);
    assert.partialDeepStrictEqual(rejectedError, {
      code: "unsupported_target",
      details: {
        operation: "resolve_analysis_profile",
        path: shared,
        reason:
          "This Ghidra PPC64 lane supports ET_EXEC only; relocatable objects, shared objects and position-independent executables need separate load verification.",
      },
    });

    for (const byteOrder of ["little", "big"]) {
      const fixture = await buildPowerPc64Fixture(
        workspace,
        byteOrder,
        commands,
      );
      const independent = await inspectPowerPc64Readelf(
        commands,
        fixture.path,
        byteOrder,
      );
      const resolved = await parseBinaryTarget(fixture.path);
      if (!resolved.ok) throw resolved.error;
      assert.deepEqual(
        resolved.value.powerpc,
        independent.powerpc,
        "REA ELF interpretation disagrees with GNU readelf",
      );
      assert.equal(resolved.value.sha256, fixture.sha256);
      const { symbols, localEntries } = independent;
      const snapshotPath = join(workspace, `ppc64-${byteOrder}.snapshot.json`);

      const target = await call("open_binary", {
        path: fixture.path,
        provider_id: "ghidra",
      });
      assert.equal(target.architecture, "powerpc");
      assert.equal(target.sha256, fixture.sha256);
      // The loaded image reports the language Ghidra actually used.
      const image = await call("inspect_native_load_image");
      assertPowerPc64LoadedImage(image.observations, fixture.sha256, byteOrder);

      const procedures = await call("list_procedures");
      const at = (address) =>
        procedures.find((p) => BigInt(p.address) === BigInt(address));
      for (const name of ["rea_ppc64_entry", "rea_ppc64_leaf"]) {
        assert.equal(at(symbols[name])?.value, name, `${name} global entry`);
        assert.ok(at(localEntries[name]), `${name} local entry missing`);
      }
      assert.equal(at(symbols.rea_ppc64_probe)?.value, "rea_ppc64_probe");

      const probe = BigInt(symbols.rea_ppc64_probe);
      const instruction = (offset) =>
        call("inspect_native_instruction", {
          address: `0x${(probe + offset).toString(16)}`,
        });
      assertPowerPc64Probe(
        {
          move: await instruction(0n),
          branch: await instruction(8n),
          vector: await instruction(12n),
        },
        symbols.rea_ppc64_probe,
        byteOrder,
      );
      const global = await call("read_bytes", {
        address: symbols.rea_ppc64_global,
        length: 8,
      });
      assert.equal(global.returned_bytes, 8);
      assertPowerPc64Global(global.bytes_hex, byteOrder);
      const marker = await call("read_bytes", {
        address: symbols.rea_ppc64_marker,
        length: 31,
      });
      assert.equal(
        marker.bytes_hex,
        Buffer.from("rea-ppc64-source-owned-fixture\0").toString("hex"),
      );

      // ELFv2: the symbol is a thunk to the body at the local entry, and the
      // body's direct call reaches the leaf's local entry.
      const entry = {
        global: symbols.rea_ppc64_entry,
        local: localEntries.rea_ppc64_entry,
      };
      const local = await dossier(entry.local);
      assertPowerPc64EntryPair(await dossier(entry.global), local, entry);
      const callees = await call("procedure_callees", {
        procedure: entry.local,
      });
      assert.ok(
        callees.some(
          (callee) => BigInt(callee) === BigInt(localEntries.rea_ppc64_leaf),
        ),
        "Expected direct call to the leaf's local entry not recovered",
      );
      const assembly = await call("procedure_assembly", {
        procedure: entry.local,
      });
      assert.ok(assembly.trim().length > 0);
      const mapping = await call("address_to_file_offset", {
        address: entry.local,
      });
      const memory = await call("read_bytes", {
        address: entry.local,
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
      assert.equal(snapshot.target.identity.architecture, "powerpc");
      assert.equal(
        snapshot.binding.analysis_profile.parameters.language_id,
        image.observations.language_id,
      );
      assert.equal(
        snapshot.binding.analysis_profile.parameters.powerpc_support_lane,
        "elf64-elfv2-exec-isa3",
      );
      assert.ok(snapshot.evidence_bundle.records.length > 0);
      for (const evidence of snapshot.evidence_bundle.records)
        assert.equal(
          parseEvidence(evidence).subject?.identity.architecture,
          "powerpc",
        );
      await call("open_binary", {
        path: fixture.path,
        provider_id: "ghidra",
        snapshot_path: snapshotPath,
      });
      assert.deepEqual(await call("list_procedures"), procedures);
      await call("close_binary");

      // Same public operation through CLI, not a private injected provider.
      const cli = await commands.exec(
        process.execPath,
        [
          entrypoint,
          "function",
          fixture.path,
          "rea_ppc64_entry",
          "--provider",
          "ghidra",
          "--json",
        ],
        { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
      );
      const evidence = parseEvidence(JSON.parse(cli.stdout));
      assert.equal(evidence.subject?.identity.architecture, "powerpc");
      assert.equal(evidence.subject?.identity.sha256, fixture.sha256);
      const cliDossier = functionDossierSchema.parse(
        evidence.normalized_result,
      );
      assert.equal(BigInt(cliDossier.procedure.address), BigInt(entry.global));
      assert.equal(
        BigInt(cliDossier.procedure.classification.thunk_target),
        BigInt(entry.local),
      );
      assert.ok(cliDossier.pseudocode.trim().length > 0);
      assert.equal(
        await sha256(fixture.path),
        fixture.sha256,
        "Analysis modified the source executable",
      );
      reports.push({
        ...fixture,
        independent_reader: independent,
        effective_language: image.observations.language_id,
        effective_compiler_spec: image.observations.compiler_spec_id,
        checks: [
          "independent ELF header, symbols and ELFv2 local entries",
          "loaded Ghidra identity and bound Power ISA language",
          "fixed instruction bytes, immediate and VSX decoding",
          "conditional branch destination",
          "global doubleword and marker bytes in file byte order",
          "global-entry thunk and local-entry body with direct call",
          "CLI/MCP and snapshot identity",
        ],
        procedures: procedures.length,
        status: "passed",
      });
    }
    reports.push({
      path: shared,
      sha256: await sha256(shared),
      checks: ["ET_DYN refused before provider startup"],
      status: "passed",
    });
  } catch (cause) {
    throw new Error(`PPC64 verification failed; MCP stderr: ${stderr}`, {
      cause,
    });
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }
} catch (cause) {
  primaryFailure = cause;
}
// Close the command owner before the parent-tree check. A failed close stays
// registered for retry and the diagnostic workspace is retained.
let cleanupFailure;
try {
  await workspaceFixture.closeEarly([() => commands.close()]);
} catch (cause) {
  cleanupFailure = cause;
}
if (cleanupFailure !== undefined)
  throw retainWorkspace(
    `PPC64 command cleanup failed; retained diagnostic workspace: ${workspace}`,
    {
      cause:
        primaryFailure === undefined
          ? cleanupFailure
          : new AggregateError(
              [primaryFailure, cleanupFailure],
              "PPC64 verification and command cleanup both failed",
            ),
    },
  );
const completed = await completeVerifierRun(run);
if (
  completed.process_lineage.status !== "verified" ||
  completed.process_lineage.descendants.length !== 0
)
  throw retainWorkspace(
    `Cleanup unverified; retained diagnostic workspace: ${workspace}`,
    { cause: primaryFailure },
  );
if (primaryFailure !== undefined)
  throw retainWorkspace(
    `PPC64 verification failed; retained workspace: ${workspace}`,
    {
      cause: primaryFailure,
    },
  );
await workspaceFixture.release();
console.log(JSON.stringify({ ...completed, fixtures: reports }, null, 2));
