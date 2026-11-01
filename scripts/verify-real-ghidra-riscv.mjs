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
import {
  buildRiscvFixture,
  stripRiscvFixture,
} from "../tests/conformance/ghidra/riscv-fixture.mjs";
import {
  RISCV_ILP32_ABI,
  assertRiscvIlp32CallSites,
  assertRiscvIlp32Caller,
  assertRiscvIlp32Storage,
  inspectRiscvCallSites,
} from "../tests/conformance/ghidra/riscv-checks.mjs";
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

/** The profile a fixture's lane must commit, from independent declarations. */
const expectedLane = (fixture) => {
  const soft = fixture.riscv.flags === 1;
  return {
    lane: `elf${fixture.riscv.elfClass}-exec-le-${soft ? "soft" : "double"}-float-generic-v1`,
    callingConvention: soft ? "ilp32-prototype-v1" : undefined,
    riscvElf: {
      elf_class: fixture.riscv.elfClass,
      byte_order: "little",
      type: 2,
      flags: fixture.riscv.flags,
      float_abi_double: !soft,
      ...(soft ? { float_abi: "soft", arch: fixture.riscv.isa.arch } : {}),
      rvc_declared: true,
      rve_declared: false,
      tso_declared: false,
    },
  };
};

const OUTCOME =
  /RISC-V calling-convention outcome: [1-9]\d* functions and (\d+) function definitions use __rea_ilp32\./u;

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

  const typedSoft = await buildRiscvFixture(workspace, 32, "soft");
  const callSites = await inspectRiscvCallSites(typedSoft.path);
  assertRiscvIlp32CallSites(callSites.calls);
  const fixtures = [
    await buildRiscvFixture(workspace, 32),
    await buildRiscvFixture(workspace, 64),
    typedSoft,
    await stripRiscvFixture(workspace, typedSoft),
  ];
  for (const fixture of fixtures) {
    const bits = fixture.riscv.elfClass;
    const soft = fixture.riscv.flags === 1;
    const stripped = fixture.stripped === true;
    const expected = expectedLane(fixture);
    const resolved = await parseBinaryTarget(fixture.path);
    if (!resolved.ok) throw resolved.error;
    assert.equal(resolved.value.architecture, "riscv");
    assert.equal(resolved.value.sha256, fixture.sha256);
    assert.deepEqual(resolved.value.riscv, fixture.riscv);
    const expectedLanguage = `RISCV:LE:${bits}:default`;
    const assertProfile = (profile, want = expected) => {
      assert.equal(profile.provider.id, "ghidra");
      assert.equal(profile.provider.version, installation.providerVersion);
      const parameters = profile.parameters;
      assert.equal(parameters.language_id, expectedLanguage);
      assert.equal(parameters.compiler_spec_id, "gcc");
      assert.equal(parameters.language_selection, "provider-pinned-v1");
      assert.equal(parameters.riscv_support_lane, want.lane);
      assert.equal(parameters.riscv_calling_convention, want.callingConvention);
      assert.deepEqual(parameters.riscv_elf, want.riscvElf);
    };
    const assertEvidence = (evidence) => {
      assert.equal(evidence.subject.architecture, "riscv");
      assert.equal(evidence.subject.digest.sha256, fixture.sha256);
      // Composed workflows such as inspect_native_api commit the Ghidra
      // profile as their upstream profile. The residual-unknown registry
      // records what they could not establish, such as the types of a
      // stripped function's parameters, without a profile of its own.
      if (evidence.provider.id === "rea-workflow")
        assertProfile(
          evidence.analysis_profile.parameters.upstream_analysis_profile,
        );
      else if (evidence.provider.id === "rea-unknown-registry")
        assert.equal(evidence.analysis_profile, null);
      else {
        assert.equal(evidence.provider.id, "ghidra");
        assertProfile(evidence.analysis_profile);
      }
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
    const procedures = await call("list_procedures");
    const names = soft
      ? [
          "rea_riscv_entry",
          "rea_riscv_probe",
          "rea_riscv_isa_probe",
          "rea_riscv_abi_caller",
          ...Object.keys(RISCV_ILP32_ABI),
        ]
      : [
          "rea_riscv_entry",
          "rea_riscv_leaf",
          "rea_riscv_float",
          "rea_riscv_probe",
        ];
    for (const name of [...names, "rea_riscv_global"])
      assert.ok(
        fixture.symbols[name],
        `${name} missing from the readelf symbols`,
      );
    for (const name of names) {
      // A stripped image has no names; the typed twin's addresses locate it.
      const procedure = procedures.find((value) =>
        stripped
          ? BigInt(value.address) === BigInt(fixture.symbols[name])
          : value.value === name,
      );
      assert.ok(procedure, `${name} missing from Ghidra inventory`);
      assert.equal(BigInt(procedure.address), BigInt(fixture.symbols[name]));
    }
    const probe = await call("inspect_native_instruction", {
      address: fixture.symbols.rea_riscv_probe,
    });
    assert.equal(probe.status, "decoded");
    assert.equal(probe.architecture, expectedLanguage);
    assert.equal(probe.length, 4);
    assert.equal(probe.bytes, "13051501"); // addi a0, a0, 17
    const mapping = await call("address_to_file_offset", {
      address: fixture.symbols.rea_riscv_probe,
    });
    const sourceBytes = await readFile(fixture.path);
    assert.equal(
      sourceBytes
        .subarray(mapping.file_offset, mapping.file_offset + 4)
        .toString("hex"),
      probe.bytes,
    );
    const isaProbe = [];
    if (soft) {
      // ESP32-C3's -march declares Zifencei and Zicsr; both must decode.
      for (const [offset, bytes, mnemonic] of [
        [0n, "0f100000", /^fence\.i$/iu],
        [4n, "f32200b0", /^csrr/iu],
      ]) {
        const instruction = await call("inspect_native_instruction", {
          address: `0x${(BigInt(fixture.symbols.rea_riscv_isa_probe) + offset).toString(16)}`,
        });
        assert.equal(instruction.status, "decoded");
        assert.equal(instruction.bytes, bytes);
        assert.match(instruction.mnemonic, mnemonic);
        isaProbe.push(instruction.mnemonic);
      }
    }
    const global = await call("read_bytes", {
      address: fixture.symbols.rea_riscv_global,
      length: 4,
    });
    assert.equal(global.bytes_hex, "07000000");
    const callees = await call("procedure_callees", {
      procedure: fixture.symbols.rea_riscv_entry,
    });
    for (const name of soft
      ? ["rea_riscv_abi_caller", "rea_riscv_isa_probe", "rea_riscv_probe"]
      : ["rea_riscv_leaf", "rea_riscv_probe"])
      assert.ok(
        callees.some(
          (address) => BigInt(address) === BigInt(fixture.symbols[name]),
        ),
        `${name} missing from the entry's callees`,
      );
    const dossier = functionDossierSchema.parse(
      await call("analyze_function", {
        procedure: fixture.symbols.rea_riscv_entry,
        detail: "complete",
      }),
    );
    assert.ok(dossier.pseudocode.trim().length > 0);
    if (!stripped) {
      const floatCode = await call("procedure_pseudo_code", {
        procedure:
          fixture.symbols[soft ? "rea_riscv_abi_wide" : "rea_riscv_float"],
      });
      assert.ok(typeof floatCode === "string" && floatCode.trim().length > 0);
      assert.match(floatCode, /\bdouble\b/u);
    }
    let abi;
    if (soft) {
      const boundaries = {};
      for (const name of Object.keys(RISCV_ILP32_ABI))
        boundaries[name] = (
          await call("inspect_native_api", { procedure: fixture.symbols[name] })
        ).boundary;
      assertRiscvIlp32Storage(boundaries, { stripped });
      const caller = functionDossierSchema.parse(
        await call("analyze_function", {
          procedure: fixture.symbols.rea_riscv_abi_caller,
          detail: "complete",
        }),
      );
      assertRiscvIlp32Caller(caller.pseudocode, fixture.symbols, {
        stripped,
      });
      abi = {
        storage: Object.fromEntries(
          Object.entries(boundaries).map(([name, boundary]) => [
            name,
            {
              return: boundary.return_type.storage,
              parameters: boundary.parameters.map(
                (parameter) => parameter.storage,
              ),
            },
          ]),
        ),
      };
    }

    const snapshotPath = join(
      workspace,
      `${fixture.path.split("/").at(-1)}.snapshot.json`,
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
    const outcomes = snapshot.evidence_bundle.records
      .flatMap((record) => parseEvidence(record).limitations)
      .map((limitation) => OUTCOME.exec(limitation))
      .filter((match) => match !== null);
    assert.equal(
      outcomes.length > 0,
      soft,
      "ilp32 prototype outcome missing from, or unexpected in, retained Evidence",
    );
    // DWARF supplies the typed build's function definitions; stripping removes them.
    if (soft)
      for (const match of outcomes)
        assert.equal(Number(match[1]) > 0, !stripped, match[0]);
    await call("open_binary", {
      path: fixture.path,
      provider_id: "ghidra",
      snapshot_path: snapshotPath,
    });
    assert.deepEqual(await call("list_procedures"), procedures);
    await call("close_binary");

    for (const [command, arguments_] of [
      ...(stripped ? [] : [["search", ["rea_riscv_", "--kind", "procedures"]]]),
      [
        "function",
        [stripped ? fixture.symbols.rea_riscv_entry : "rea_riscv_entry"],
      ],
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
        for (const name of names)
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
    const headers = [];
    // Header-mutated copies test admission; they are not new compiler claims.
    for (const [flags, outcome] of stripped
      ? []
      : soft
        ? [
            [0x3, "single-float ABI (ilp32f)"],
            [0x80000001, "(0x80000000)"],
          ]
        : bits === 32
          ? [
              [0x1, "admitted"],
              [0x80000005, "(0x80000000)"],
            ]
          : [
              [0x1, "soft-float ABI (lp64)"],
              [0x80000005, "(0x80000000)"],
            ]) {
      const mutatedPath = join(
        workspace,
        `rv${bits}${soft ? "-soft" : ""}-flags-${flags.toString(16)}.elf`,
      );
      const mutatedBytes = Buffer.from(sourceBytes);
      mutatedBytes.writeUInt32LE(flags, bits === 32 ? 36 : 48);
      await writeFile(mutatedPath, mutatedBytes);
      const reply = await client.callTool(
        {
          name: "open_binary",
          arguments: { path: mutatedPath, provider_id: "ghidra" },
        },
        { timeout: 240000 },
      );
      const cliArguments = [
        entrypoint,
        "function",
        mutatedPath,
        "rea_riscv_entry",
        "--provider",
        "ghidra",
        "--json",
      ];
      const cliOptions = { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 };
      if (outcome === "admitted") {
        // The double-float image now declares ilp32: refused before, admitted
        // now through the soft-float lane with the image's own ISA string.
        assert.equal(
          requireMcpLifecycleResult(reply, "open_binary").sha256,
          createHash("sha256").update(mutatedBytes).digest("hex"),
        );
        requireMcpLifecycleResult(
          await client.callTool(
            { name: "close_binary", arguments: {} },
            { timeout: 240000 },
          ),
          "close_binary",
        );
        const want = {
          lane: "elf32-exec-le-soft-float-generic-v1",
          callingConvention: "ilp32-prototype-v1",
          riscvElf: {
            ...expected.riscvElf,
            flags,
            float_abi_double: false,
            float_abi: "soft",
            arch: fixture.riscv.isa.arch,
          },
        };
        const cli = await execute(process.execPath, cliArguments, cliOptions);
        assertProfile(
          parseEvidence(JSON.parse(cli.stdout)).analysis_profile,
          want,
        );
        headers.push({ flags, outcome, lane: want.lane });
        continue;
      }
      const error = requireMcpToolError(reply);
      assert.ok(JSON.stringify(error).includes(outcome), JSON.stringify(error));
      await assert.rejects(
        execute(process.execPath, cliArguments, cliOptions),
        (cause) =>
          Number.isInteger(cause.code) &&
          cause.code !== 0 &&
          `${cause.stdout}\n${cause.stderr}`.includes(outcome),
      );
      headers.push({ flags, outcome: "refused", reason: outcome });
    }
    assert.equal(
      createHash("sha256")
        .update(await readFile(fixture.path))
        .digest("hex"),
      fixture.sha256,
    );
    reports.push({
      path: fixture.path,
      sha256: fixture.sha256,
      riscv: fixture.riscv,
      stripped,
      toolchain: fixture.toolchain,
      sources: fixture.sources,
      language: expectedLanguage,
      lane: expected.lane,
      calling_convention: expected.callingConvention ?? null,
      procedures: procedures.length,
      headers,
      ...(isaProbe.length === 0 ? {} : { isa_probe: isaProbe }),
      ...(abi === undefined
        ? {}
        : {
            abi,
            prototype_outcome: outcomes.map((match) => match[0]),
          }),
      cli: true,
      stdio_mcp: true,
      snapshot_replay: true,
      original_unchanged: true,
    });
  }
  // ESP-IDF's flash layout: the NOBITS .flash_rodata_dummy reserves
  // .flash.text's addresses. Ghidra 12.1.4's loader puts such code in an overlay
  // that DWARF import and default-space references never reach, unless REA
  // prepares the memory map before analysis.
  const esp = await buildRiscvFixture(workspace, 32, "esp");
  assert.equal(esp.riscv.sectionOverlap.status, "code-reservation");
  const resolvedEsp = await parseBinaryTarget(esp.path);
  if (!resolvedEsp.ok) throw resolvedEsp.error;
  assert.deepEqual(resolvedEsp.value.riscv, esp.riscv);
  const { code, reservation } = esp.riscv.sectionOverlap;
  const plan = { policy: "nobits-reservation-overlay-v1", code, reservation };
  const espLimitations = new Set();
  const espCall = async (name, args = {}) => {
    const reply = await client.callTool(
      { name, arguments: args },
      { timeout: 240000 },
    );
    const lifecycle = ["open_binary", "close_binary"].includes(name);
    const admitted = lifecycle
      ? requireMcpLifecycleResult(reply, name)
      : parseEvidence(requireMcpOutput(reply, name));
    const validate = validators.get(name);
    assert.ok(
      validate(JSON.parse(mcpTextValue(reply))),
      `${name}: ${JSON.stringify(validate.errors)}`,
    );
    if (lifecycle) return admitted;
    assert.equal(admitted.subject.digest.sha256, esp.sha256);
    if (admitted.provider.id === "ghidra") {
      assert.deepEqual(
        admitted.analysis_profile.parameters.elf_load_preparation,
        plan,
      );
      for (const limitation of admitted.limitations)
        espLimitations.add(limitation);
    }
    return admitted.normalized_result;
  };
  await espCall("open_binary", { path: esp.path, provider_id: "ghidra" });
  const espImage = await espCall("inspect_native_load_image");
  const blocks = (name) =>
    espImage.observations.mappings.filter((value) => value.block === name);
  const [text] = blocks(code.name);
  assert.ok(text, `${code.name} missing from the load image`);
  assert.equal(text.address_space, espImage.observations.default_address_space);
  assert.equal(text.overlay, false);
  assert.equal(text.executable, true);
  assert.equal(text.start, code.address);
  assert.equal(text.file_offset, Number(BigInt(code.offset)));
  const [held] = blocks(reservation.name);
  assert.ok(held, `${reservation.name} missing from the load image`);
  assert.equal(held.overlay, true);
  assert.equal(held.initialized, false);
  assert.ok(
    !espImage.observations.mappings.some(
      (value) => value.overlay && value.executable && value.initialized,
    ),
    "Initialized executable code remains in an overlay",
  );
  const espProcedures = await espCall("list_procedures");
  // Every procedure, flash code included, keeps its ELF address in the default space.
  assert.ok(
    espProcedures.every((value) => /^0x[\da-f]+$/u.test(value.address)),
    JSON.stringify(espProcedures.map((value) => value.address)),
  );
  for (const name of [
    "rea_riscv_esp_entry",
    "rea_riscv_esp_main",
    "rea_riscv_esp_restart",
    "rea_riscv_esp_sum",
    "rea_riscv_esp_next",
  ])
    assert.equal(
      espProcedures.find((value) => value.value === name)?.address,
      esp.symbols[name],
      `${name} missing from the Ghidra inventory at its ELF address`,
    );
  // The ELF address of flash code selects the procedure itself.
  const espMain = await espCall("procedure_pseudo_code", {
    procedure: esp.symbols.rea_riscv_esp_main,
  });
  assert.match(espMain, /\brea_riscv_esp_main\s*\(void\)/u);
  assert.match(espMain, /\brea_riscv_esp_restart\(\)/u);
  // The no-return call ends the pseudocode before rea_riscv_esp_next's store.
  assert.doesNotMatch(espMain, /0x5a5a|23130/u);
  // DWARF reaches flash code: the parameter names come from the image.
  assert.match(
    await espCall("procedure_pseudo_code", {
      procedure: esp.symbols.rea_riscv_esp_sum,
    }),
    /\brea_riscv_esp_sum\s*\(int left,\s*int right\)/u,
  );
  const entryCallees = await espCall("procedure_callees", {
    procedure: esp.symbols.rea_riscv_esp_entry,
  });
  assert.ok(
    entryCallees.includes(esp.symbols.rea_riscv_esp_main),
    `IRAM entry does not call the flash procedure: ${JSON.stringify(entryCallees)}`,
  );
  const espMapping = await espCall("address_to_file_offset", {
    address: esp.symbols.rea_riscv_esp_main,
  });
  assert.equal(
    BigInt(espMapping.file_offset),
    BigInt(code.offset) +
      BigInt(esp.symbols.rea_riscv_esp_main) -
      BigInt(code.address),
  );
  await espCall("close_binary");
  const outcome = [...espLimitations].find((value) =>
    value.startsWith("RISC-V load preparation outcome:"),
  );
  assert.match(
    outcome ?? "",
    // The fixture's four flash functions move; its IRAM entry stays.
    /`\.flash\.text` moved into the default address space \(functions: 4, entry points: \d+\); reservation labels moved into its overlay: \d+\./u,
  );
  assert.ok(
    [...espLimitations].some((value) =>
      value.startsWith(
        "RISC-V ELF load layout: NOBITS section `.flash_rodata_dummy` reserves the addresses of executable section `.flash.text`",
      ),
    ),
  );
  const espCli = parseEvidence(
    JSON.parse(
      (
        await execute(
          process.execPath,
          [
            entrypoint,
            "function",
            esp.path,
            "rea_riscv_esp_main",
            "--provider",
            "ghidra",
            "--json",
          ],
          { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
        )
      ).stdout,
    ),
  );
  assert.equal(
    espCli.normalized_result.procedure.address,
    esp.symbols.rea_riscv_esp_main,
  );
  assert.doesNotMatch(espCli.normalized_result.pseudocode, /0x5a5a|23130/u);
  assert.deepEqual(
    espCli.analysis_profile.parameters.elf_load_preparation,
    plan,
  );
  // A reservation smaller than the code is not the verified shape.
  const shrunkPath = join(workspace, "rv32-esp-short-reservation.elf");
  const shrunk = Buffer.from(await readFile(esp.path));
  shrunk.writeUInt32LE(
    Number(BigInt(code.size)) - 2,
    shrunk.readUInt32LE(32) + reservation.index * 40 + 20,
  );
  await writeFile(shrunkPath, shrunk);
  const refusal = "REA prepares only a NOBITS section";
  const refused = requireMcpToolError(
    await client.callTool(
      {
        name: "open_binary",
        arguments: { path: shrunkPath, provider_id: "ghidra" },
      },
      { timeout: 240000 },
    ),
  );
  assert.ok(JSON.stringify(refused).includes(refusal), JSON.stringify(refused));
  await assert.rejects(
    execute(
      process.execPath,
      [
        entrypoint,
        "function",
        shrunkPath,
        "rea_riscv_esp_main",
        "--provider",
        "ghidra",
        "--json",
      ],
      { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
    ),
    (cause) =>
      Number.isInteger(cause.code) &&
      cause.code !== 0 &&
      `${cause.stdout}\n${cause.stderr}`.includes(refusal),
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(esp.path))
      .digest("hex"),
    esp.sha256,
  );
  reports.push({
    esp_layout: {
      path: esp.path,
      sha256: esp.sha256,
      riscv: esp.riscv,
      toolchain: esp.toolchain,
      sources: esp.sources,
      preparation: outcome,
      procedures: espProcedures.length,
      refused_short_reservation: true,
      cli: true,
      stdio_mcp: true,
      original_unchanged: true,
    },
  });
  reports.push({
    call_sites: {
      fixture: typedSoft.path,
      command: callSites.command,
      version: callSites.version,
      calls: callSites.calls.map((value) => value.target),
    },
  });
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
