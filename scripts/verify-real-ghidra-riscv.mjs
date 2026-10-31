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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { buildRiscvFixture } from "../tests/conformance/ghidra/riscv-fixture.mjs";
import {
  mcpTextValue,
  requireMcpLifecycleResult,
  requireMcpOutput,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-riscv.mjs");
if (!["linux", "darwin"].includes(process.platform))
  throw new Error("This optional lane requires a Linux/macOS Ghidra host.");
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error("Missing prerequisite: caller-supplied GHIDRA_INSTALL_DIR");
for (const key of ["REA_GHIDRA_LANGUAGE_ID", "REA_GHIDRA_COMPILER_SPEC_ID"])
  if (process.env[key] !== undefined)
    throw new Error(
      `Unset ${key}: this lane verifies provider-pinned selection.`,
    );
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
assert.equal(installation.status, "available", JSON.stringify(installation));
assert.equal(installation.providerVersion, "12.1.4");

const execute = promisify(execFile);
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-riscv-proof-"));
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
};
for (const key of ["GHIDRA_HEADLESS_MAXMEM", "GHIDRA_MAXMEM"])
  if (process.env[key] !== undefined) env[key] = process.env[key];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "rea-real-riscv-proof", version: "1" });
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});

const reports = [];
let failure;
try {
  await client.connect(transport);
  const catalog = await client.listTools();
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validators = new Map();
  for (const tool of catalog.tools) {
    assert.ok(
      ajv.validateSchema(tool.outputSchema),
      `${tool.name}: invalid output schema`,
    );
    const existing =
      typeof tool.outputSchema.$id === "string"
        ? ajv.getSchema(tool.outputSchema.$id)
        : undefined;
    validators.set(tool.name, existing ?? ajv.compile(tool.outputSchema));
  }
  for (const bits of [32, 64]) {
    for (const pie of [false, true]) {
      const fixture = await buildRiscvFixture(workspace, bits, { pie });
      const resolved = await parseBinaryTarget(fixture.path);
      if (!resolved.ok) throw resolved.error;
      assert.equal(resolved.value.architecture, "riscv");
      assert.equal(resolved.value.sha256, fixture.sha256);
      assert.deepEqual(resolved.value.riscv, fixture.riscv);
      const expectedLanguage = `RISCV:LE:${bits}:default`;
      const assertProfile = (profile) => {
        assert.equal(profile.provider.id, "ghidra");
        assert.equal(profile.provider.version, installation.providerVersion);
        const parameters = profile.parameters;
        assert.equal(parameters.language_id, expectedLanguage);
        assert.equal(parameters.compiler_spec_id, "gcc");
        assert.equal(parameters.language_selection, "provider-pinned-v1");
        assert.equal(
          parameters.riscv_support_lane,
          pie
            ? `elf${bits}-pie-le-double-float-generic-v1`
            : `elf${bits}-exec-le-double-float-generic-v1`,
        );
        assert.deepEqual(parameters.riscv_elf, {
          elf_class: bits,
          byte_order: "little",
          type: pie ? 3 : 2,
          flags: 5,
          float_abi_double: true,
          rvc_declared: true,
          rve_declared: false,
          tso_declared: false,
          ...(pie
            ? {
                has_interpreter: true,
                load_model: "pie",
                expected_default_image_base:
                  bits === 32 ? "0x10000" : "0x100000",
              }
            : {}),
        });
      };
      const assertEvidence = (evidence) => {
        assert.equal(evidence.provider.id, "ghidra");
        assert.equal(evidence.subject.architecture, "riscv");
        assert.equal(evidence.subject.digest.sha256, fixture.sha256);
        assertProfile(evidence.analysis_profile);
      };
      const call = async (name, args = {}) => {
        const reply = await client.callTool(
          { name, arguments: args },
          { timeout: 240000 },
        );
        const lifecycle = [
          "open_binary",
          "close_binary",
          "binary_session",
        ].includes(name);
        const admitted = lifecycle
          ? requireMcpLifecycleResult(reply, name)
          : parseEvidence(requireMcpOutput(reply, name));
        const textual = JSON.parse(mcpTextValue(reply));
        assert.ok(reply.structuredContent, `${name} omitted structured result`);
        const validate = validators.get(name);
        assert.ok(validate, `${name} missing from advertised catalog`);
        assert.ok(
          validate(textual),
          `${name}: ${JSON.stringify(validate.errors)}`,
        );
        if (!lifecycle) assertEvidence(admitted);
        return lifecycle ? admitted : admitted.normalized_result;
      };
      const opened = await call("open_binary", {
        path: fixture.path,
        provider_id: "ghidra",
      });
      assert.equal(opened.architecture, "riscv");
      assert.equal(opened.sha256, fixture.sha256);
      const image = await call("inspect_native_load_image");
      assert.equal(image.observations.language_id, expectedLanguage);
      assert.equal(image.observations.compiler_spec_id, "gcc");
      assert.ok(image.observations.source_files.length > 0);
      for (const source of image.observations.source_files) {
        assert.equal(source.original_sha256, fixture.sha256);
        assert.equal(source.modified_sha256, fixture.sha256);
      }
      const expectedBase = pie ? (bits === 32 ? 0x10000n : 0x100000n) : 0n;
      if (pie) {
        assert.equal(
          image.observations.image_base,
          `0x${expectedBase.toString(16)}`,
        );
      }
      const addressFor = (name) => {
        const symbolAddress = BigInt(fixture.symbols[name]);
        return `0x${(pie ? expectedBase + symbolAddress : symbolAddress).toString(16)}`;
      };
      const procedures = await call("list_procedures");
      for (const name of [
        "rea_riscv_entry",
        "rea_riscv_leaf",
        "rea_riscv_float",
        "rea_riscv_probe",
      ]) {
        const procedure = procedures.find((value) => value.value === name);
        assert.ok(procedure, `${name} missing from Ghidra inventory`);
        assert.equal(BigInt(procedure.address), BigInt(addressFor(name)));
      }
      const probeAddress = addressFor("rea_riscv_probe");
      const probe = await call("inspect_native_instruction", {
        address: probeAddress,
      });
      assert.equal(probe.status, "decoded");
      assert.equal(probe.architecture, expectedLanguage);
      assert.equal(probe.length, 4);
      assert.equal(probe.bytes, "13051501"); // addi a0, a0, 17
      const mapping = await call("address_to_file_offset", {
        address: probeAddress,
      });
      const sourceBytes = await readFile(fixture.path);
      assert.equal(
        sourceBytes
          .subarray(mapping.file_offset, mapping.file_offset + 4)
          .toString("hex"),
        probe.bytes,
      );
      const global = await call("read_bytes", {
        address: addressFor("rea_riscv_global"),
        length: 4,
      });
      assert.equal(global.bytes_hex, "07000000");
      const entryAddress = addressFor("rea_riscv_entry");
      const callees = await call("procedure_callees", {
        procedure: entryAddress,
      });
      for (const name of ["rea_riscv_leaf", "rea_riscv_probe"])
        assert.ok(
          callees.some(
            (address) => BigInt(address) === BigInt(addressFor(name)),
          ),
        );
      const dossier = functionDossierSchema.parse(
        await call("analyze_function", {
          procedure: entryAddress,
          detail: "complete",
        }),
      );
      assert.ok(dossier.pseudocode.trim().length > 0);
      const floatCode = await call("procedure_pseudo_code", {
        procedure: addressFor("rea_riscv_float"),
      });
      assert.ok(typeof floatCode === "string" && floatCode.trim().length > 0);
      assert.match(floatCode, /\bdouble\b/u);

      const refusals = [];
      if (!pie) {
        for (const [flags, reason] of [
          [1, "EF_RISCV_FLOAT_ABI_DOUBLE"],
          [0x80000005, "(0x80000000)"],
        ]) {
          // Header-mutated copies test admission; they are not new compiler claims.
          const rejectedPath = join(
            workspace,
            `rv${bits}-flags-${flags.toString(16)}.elf`,
          );
          const rejectedBytes = Buffer.from(sourceBytes);
          rejectedBytes.writeUInt32LE(flags, bits === 32 ? 36 : 48);
          await writeFile(rejectedPath, rejectedBytes);
          const reply = await client.callTool(
            {
              name: "open_binary",
              arguments: { path: rejectedPath, provider_id: "ghidra" },
            },
            { timeout: 60000 },
          );
          const error = requireMcpToolError(reply);
          assert.ok(
            JSON.stringify(error).includes(reason),
            JSON.stringify(error),
          );
          await assert.rejects(
            execute(
              process.execPath,
              [
                entrypoint,
                "function",
                rejectedPath,
                "rea_riscv_entry",
                "--provider",
                "ghidra",
                "--json",
              ],
              {
                env,
                timeout: 60000,
                maxBuffer: 1024 * 1024,
              },
            ),
            (cause) =>
              Number.isInteger(cause.code) &&
              cause.code !== 0 &&
              `${cause.stdout}\n${cause.stderr}`.includes(reason),
          );
          refusals.push({ flags, reason });
        }
      } else {
        // Mutate program headers to clear PT_INTERP and verify shared library refusal.
        const is64 = bits === 64;
        const phoff = is64
          ? Number(sourceBytes.readBigUInt64LE(32))
          : sourceBytes.readUInt32LE(28);
        const phentsize = sourceBytes.readUInt16LE(is64 ? 54 : 42);
        const phnum = sourceBytes.readUInt16LE(is64 ? 56 : 44);
        const sharedBytes = Buffer.from(sourceBytes);
        for (let i = 0; i < phnum; i += 1) {
          const offset = phoff + i * phentsize;
          if (sharedBytes.readUInt32LE(offset) === 3) {
            sharedBytes.writeUInt32LE(0, offset); // PT_NULL
          }
        }
        const sharedPath = join(workspace, `rv${bits}-shared.so`);
        await writeFile(sharedPath, sharedBytes);
        const reply = await client.callTool(
          {
            name: "open_binary",
            arguments: { path: sharedPath, provider_id: "ghidra" },
          },
          { timeout: 60000 },
        );
        const error = requireMcpToolError(reply);
        const reason = "shared libraries without PT_INTERP";
        assert.ok(
          JSON.stringify(error).includes(reason),
          JSON.stringify(error),
        );
        refusals.push({ shared: true, reason });
      }
      const snapshotPath = join(
        workspace,
        `rv${bits}${pie ? "-pie" : ""}.snapshot.json`,
      );
      const saved = await call("close_binary", { snapshot_path: snapshotPath });
      assert.ok(saved.evidence_records > 0);
      const snapshot = parseAnalysisSnapshot(
        JSON.parse(await readFile(snapshotPath, "utf8")),
      );
      assert.equal(snapshot.target.architecture, "riscv");
      assert.equal(snapshot.target.sha256, fixture.sha256);
      assertProfile(snapshot.binding.analysis_profile);
      for (const record of snapshot.evidence_bundle.records)
        assertEvidence(parseEvidence(record));
      await call("open_binary", {
        path: fixture.path,
        provider_id: "ghidra",
        snapshot_path: snapshotPath,
      });
      assert.deepEqual(await call("list_procedures"), procedures);
      await call("close_binary");

      for (const [command, arguments_] of [
        ["search", ["rea_riscv_", "--kind", "procedures"]],
        ["function", ["rea_riscv_entry"]],
      ]) {
        const cli = await execute(
          process.execPath,
          [
            entrypoint,
            command,
            fixture.path,
            ...arguments_,
            "--provider",
            "ghidra",
            "--json",
          ],
          { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
        );
        const evidence = parseEvidence(JSON.parse(cli.stdout));
        assertEvidence(evidence);
        if (command === "search")
          for (const name of [
            "rea_riscv_entry",
            "rea_riscv_leaf",
            "rea_riscv_float",
            "rea_riscv_probe",
          ])
            assert.ok(
              evidence.normalized_result.some((value) => value.value === name),
            );
        else {
          const cliDossier = functionDossierSchema.parse(
            evidence.normalized_result,
          );
          assert.equal(cliDossier.procedure.address, dossier.procedure.address);
          assert.ok(cliDossier.pseudocode.trim().length > 0);
        }
      }
      assert.equal(
        createHash("sha256")
          .update(await readFile(fixture.path))
          .digest("hex"),
        fixture.sha256,
      );
      reports.push({
        ...fixture,
        loadModel: pie ? "pie" : "fixed",
        language: expectedLanguage,
        procedures: procedures.length,
        refusals,
        cli: true,
        stdio_mcp: true,
        snapshot_replay: true,
        original_unchanged: true,
      });
    }
  }
} catch (cause) {
  failure = cause;
}
for (const close of [() => client.close(), () => transport.close()]) {
  try {
    await close();
  } catch (cause) {
    failure = new AggregateError(
      failure === undefined ? [cause] : [failure, cause],
      "Verification or cleanup failed",
    );
  }
}
const completed = await completeVerifierRun(run);
if (
  completed.process_lineage.status !== "verified" ||
  completed.process_lineage.descendants.length !== 0
)
  throw new Error(`Cleanup unverified; retained workspace: ${workspace}`, {
    cause: failure,
  });
if (failure !== undefined)
  throw new Error(
    `RISC-V verification failed; retained workspace: ${workspace}; MCP stderr: ${stderr}`,
    { cause: failure },
  );
assert.deepEqual(
  await readdir(runtime),
  [],
  `Runtime resources survived server shutdown; retained workspace: ${workspace}`,
);
await rm(workspace, { recursive: true, force: true });
console.log(
  JSON.stringify(
    {
      verifier_run: completed,
      lane: "ghidra-riscv",
      mocked: false,
      host: { platform: process.platform, architecture: process.arch },
      provider: { id: "ghidra", version: installation.providerVersion },
      fixtures: reports,
      cleanup: "complete",
    },
    null,
    2,
  ),
);
