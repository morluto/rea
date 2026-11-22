#!/usr/bin/env node
import { canonicalOutputSchema } from "./lib/canonical-output-schema.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { SUPPORTED_GHIDRA_VERSION } from "../dist/ghidra/GhidraReleasePolicy.js";
import {
  buildRiscvFixture,
  relabelRiscvFixtureLanguage,
  stripRiscvFixture,
} from "../tests/conformance/ghidra/riscv-fixture.mjs";
import {
  RISCV_ABIS,
  assertRiscvCallSites,
  assertRiscvCaller,
  assertRiscvStorage,
  inspectRiscvCallSites,
} from "../tests/conformance/ghidra/riscv-checks.mjs";
import {
  mcpTextValue,
  requireMcpLifecycleResult,
  requireMcpOutput,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { bindVerifierCommandInterruption } from "./lib/verifier-command-interruption.mjs";
import {
  assertVerifierCleanupComplete,
  createVerifierRun,
  completeVerifierRun,
} from "./lib/verifier-run.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";
import { requireLaneToolchain } from "../tests/conformance/ghidra/fixture-toolchain.mjs";

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
assert.equal(installation.providerVersion, SUPPORTED_GHIDRA_VERSION);

const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const run = createVerifierRun();
// Refuse a host without the fixture toolchain before allocating anything.
await requireLaneToolchain("riscv");
const workspaceFixture = await VerifierFixture.open({
  prefix: "rea-riscv-proof-",
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
};
for (const key of ["GHIDRA_HEADLESS_MAXMEM", "GHIDRA_MAXMEM"])
  if (process.env[key] !== undefined) env[key] = process.env[key];
// Public CLI launches share one command owner. A timeout stops that process group.
const commands = await createVerifierCommands();
const commandInterruption = bindVerifierCommandInterruption(commands);
const execOwned = commandInterruption.exec;
const { untilInterrupted, throwIfInterrupted } = commandInterruption;
const finishCommandInterruption = () => commandInterruption.finish();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: env,
  stderr: "pipe",
});
const client = new Client({ name: "rea-real-riscv-proof", version: "1" });
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});

// e_flags float-ABI bits, with RVC declared, and the policy each lane applies.
const FLOAT_ABIS = {
  5: { floatAbi: "double" },
  1: { floatAbi: "soft", abi: "ilp32", policy: "ilp32-prototype-v1" },
  3: { floatAbi: "single", abi: "ilp32f", policy: "ilp32f-prototype-v1" },
};

/** The profile a lane must commit for these flags, from independent declarations. */
const expectedLane = (fixture, flags = fixture.riscv.flags) => {
  const { floatAbi, policy } = FLOAT_ABIS[flags];
  const pie = fixture.riscv.type === 3;
  return {
    lane: `elf${fixture.riscv.elfClass}-${pie ? "pie" : "exec"}-le-${floatAbi}-float-generic-v1`,
    callingConvention: policy,
    riscvElf: {
      elf_class: fixture.riscv.elfClass,
      byte_order: "little",
      type: pie ? 3 : 2,
      flags,
      float_abi_double: floatAbi === "double",
      ...(policy === undefined
        ? {}
        : { float_abi: floatAbi, arch: fixture.riscv.isa.arch }),
      rvc_declared: true,
      rve_declared: false,
      tso_declared: false,
      ...(pie
        ? {
            has_interpreter: true,
            load_model: "pie",
            expected_default_image_base:
              fixture.riscv.elfClass === 32 ? "0x10000" : "0x100000",
          }
        : {}),
    },
  };
};

const OUTCOME =
  /RISC-V calling-convention outcome: [1-9]\d* functions and (\d+) function definitions use (__rea_ilp32f?)\./u;

/**
 * A single-float build whose signatures __rea_ilp32f cannot express: its
 * headers are admitted and it opens, then the bridge refuses the policy after
 * analysis, and the first analysis call over MCP and the CLI fail with the
 * bridge's reason. The source bytes stay unchanged.
 */
/**
 * The same C build with its C compile units labelled Rust: both policies model
 * the C psABI, so each refuses the image and names the language. The unlabelled
 * builds above are the controls.
 */
const verifyForeignLanguageRefusal = async (variant) => {
  const built = await buildRiscvFixture(workspace, 32, {
    variant,
    execute: execOwned,
  });
  const fixture = await relabelRiscvFixtureLanguage(workspace, built, 0x1c);
  const resolved = await parseBinaryTarget(fixture.path);
  if (!resolved.ok) throw resolved.error;
  assert.deepEqual(resolved.value.riscv, fixture.riscv);
  const policy =
    variant === "soft" ? "ilp32-prototype-v1" : "ilp32f-prototype-v1";
  const reasons = [
    `policy ${policy} refused this image`,
    "in Rust (DW_AT_language 0x1c), such as ",
  ];
  const callTool = async (name, args = {}) => {
    throwIfInterrupted();
    return client.callTool(
      { name, arguments: args },
      { timeout: 240000, signal: commandInterruption.signal },
    );
  };
  const opened = requireMcpLifecycleResult(
    await callTool("open_binary", {
      path: fixture.path,
      provider_id: "ghidra",
    }),
    "open_binary",
  );
  assert.equal(opened.sha256, fixture.sha256);
  const error = JSON.stringify(
    requireMcpToolError(await callTool("list_procedures")),
  );
  for (const reason of reasons) assert.ok(error.includes(reason), error);
  requireMcpLifecycleResult(await callTool("close_binary"), "close_binary");
  return {
    foreign_language: {
      variant,
      policy,
      sha256: fixture.sha256,
      relabelled: fixture.relabelled,
    },
  };
};

const verifyUnmodelledRefusal = async () => {
  const fixture = await buildRiscvFixture(workspace, 32, {
    variant: "unmodelled",
    execute: execOwned,
  });
  const resolved = await parseBinaryTarget(fixture.path);
  if (!resolved.ok) throw resolved.error;
  assert.deepEqual(resolved.value.riscv, fixture.riscv);
  const reasons = [
    "policy ilp32f-prototype-v1 refused this image",
    "7 functions and 1 function-pointer type pass by-value types whose psABI storage __rea_ilp32f cannot express",
    "rea_riscv_abi_spread (returns rea_riscv_abi_spread, rea_riscv_abi_spread)",
    "rea_riscv_abi_half (returns _Float16, _Float16)",
    "rea_riscv_abi_empties (returns rea_riscv_abi_empties, rea_riscv_abi_empties)",
    "rea_riscv_abi_flexible (rea_riscv_abi_flexible, rea_riscv_abi_erased)",
    "rea_riscv_abi_padded (rea_riscv_abi_padded, rea_riscv_abi_unnamed, float)",
    "rea_riscv_abi_vector (rea_riscv_abi_lanes)",
    "rea_riscv_abi_complex (complex, rea_riscv_abi_wrapped, rea_riscv_abi_aligned)",
    "function-pointer type _func_void_rea_riscv_abi_spread_int (rea_riscv_abi_spread)",
  ];
  const callTool = async (name, args = {}) => {
    throwIfInterrupted();
    return client.callTool(
      { name, arguments: args },
      { timeout: 240000, signal: commandInterruption.signal },
    );
  };
  const opened = requireMcpLifecycleResult(
    await callTool("open_binary", {
      path: fixture.path,
      provider_id: "ghidra",
    }),
    "open_binary",
  );
  assert.equal(opened.sha256, fixture.sha256);
  const error = JSON.stringify(
    requireMcpToolError(await callTool("list_procedures")),
  );
  for (const reason of reasons) assert.ok(error.includes(reason), error);
  // An array in a structure flattens, a bit-field counts by its width, and two
  // complex fields pass by reference, so these shapes fit.
  assert.ok(!error.includes("rea_riscv_abi_elements"), error);
  assert.ok(!error.includes("rea_riscv_abi_bits"), error);
  assert.ok(!error.includes("rea_riscv_abi_complexes"), error);
  // A direct C++ empty-class member is ignored when flattening, so its byte
  // is storage, not an omitted field.
  assert.ok(!error.includes("rea_riscv_abi_member"), error);
  // Clang ignores transparent_union for a float first member and for members
  // of another size, and an integer first member keeps a0: ordinary unions.
  assert.ok(!error.includes("rea_riscv_abi_float_first"), error);
  assert.ok(!error.includes("rea_riscv_abi_wider"), error);
  assert.ok(!error.includes("rea_riscv_abi_integer_first"), error);
  requireMcpLifecycleResult(await callTool("close_binary"), "close_binary");
  await assert.rejects(
    execOwned(
      process.execPath,
      [
        entrypoint,
        "function",
        fixture.path,
        "rea_riscv_entry",
        "--provider",
        "ghidra",
        "--json",
      ],
      { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
    ),
    (cause) => {
      const output = `${cause?.snapshot?.stdout?.text ?? ""}\n${cause?.snapshot?.stderr?.text ?? ""}`;
      return (
        Number.isInteger(cause?.code) &&
        cause.code !== 0 &&
        reasons.every((reason) => output.includes(reason))
      );
    },
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(fixture.path))
      .digest("hex"),
    fixture.sha256,
  );
  return {
    path: fixture.path,
    sha256: fixture.sha256,
    riscv: fixture.riscv,
    toolchain: fixture.toolchain,
    sources: fixture.sources,
    lane: expectedLane(fixture).lane,
    refused: reasons,
    cli: true,
    stdio_mcp: true,
    original_unchanged: true,
  };
};

const reports = [];
let failure;
try {
  await untilInterrupted(
    client.connect(transport, { signal: commandInterruption.signal }),
  );
  const catalog = await untilInterrupted(
    client.listTools(undefined, { signal: commandInterruption.signal }),
  );
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  const validators = new Map();
  for (const tool of catalog.tools) {
    assert.ok(
      ajv.validateSchema(canonicalOutputSchema(tool.name)),
      `${tool.name}: invalid output schema`,
    );
    const existing =
      typeof canonicalOutputSchema(tool.name).$id === "string"
        ? ajv.getSchema(canonicalOutputSchema(tool.name).$id)
        : undefined;
    validators.set(
      tool.name,
      existing ?? ajv.compile(canonicalOutputSchema(tool.name)),
    );
  }

  const callSites = [];
  const typed = [];
  for (const variant of ["soft", "single"]) {
    const fixture = await buildRiscvFixture(workspace, 32, {
      variant,
      execute: execOwned,
    });
    const abi = FLOAT_ABIS[fixture.riscv.flags].abi;
    const sites = await inspectRiscvCallSites(
      fixture.path,
      RISCV_ABIS[abi].callers,
      execOwned,
    );
    assertRiscvCallSites(abi, sites.calls);
    callSites.push({ abi, fixture: fixture.path, ...sites });
    typed.push(fixture);
  }
  const fixtures = [
    await buildRiscvFixture(workspace, 32, { execute: execOwned }),
    await buildRiscvFixture(workspace, 64, { execute: execOwned }),
    await buildRiscvFixture(workspace, 32, { pie: true, execute: execOwned }),
    await buildRiscvFixture(workspace, 64, { pie: true, execute: execOwned }),
  ];
  for (const fixture of typed)
    fixtures.push(
      fixture,
      await stripRiscvFixture(workspace, fixture, execOwned),
    );
  for (const fixture of fixtures) {
    const bits = fixture.riscv.elfClass;
    const { abi: abiName } = FLOAT_ABIS[fixture.riscv.flags];
    const abi = abiName === undefined ? undefined : RISCV_ABIS[abiName];
    const pie = fixture.riscv.type === 3;
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
      assert.equal(parameters.language_selection, "provider-pinned");
      assert.equal(parameters.riscv_support_lane, want.lane);
      assert.equal(parameters.riscv_calling_convention, want.callingConvention);
      assert.deepEqual(parameters.riscv_elf, want.riscvElf);
    };
    const assertEvidence = (evidence) => {
      assert.equal(evidence.subject.identity.architecture, "riscv");
      assert.equal(evidence.subject.identity.sha256, fixture.sha256);
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
      throwIfInterrupted();
      const reply = await client.callTool(
        { name, arguments: args },
        { timeout: 240000, signal: commandInterruption.signal },
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
    const names = abi
      ? [
          "rea_riscv_entry",
          "rea_riscv_probe",
          "rea_riscv_isa_probe",
          ...abi.callers,
          ...Object.keys(abi.functions),
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
          ? BigInt(value.address) === BigInt(addressFor(name))
          : value.value === name,
      );
      assert.ok(procedure, `${name} missing from Ghidra inventory`);
      assert.equal(BigInt(procedure.address), BigInt(addressFor(name)));
    }
    const probe = await call("inspect_native_instruction", {
      address: addressFor("rea_riscv_probe"),
    });
    assert.equal(probe.status, "decoded");
    assert.equal(probe.architecture, expectedLanguage);
    assert.equal(probe.length, 4);
    assert.equal(probe.bytes, "13051501"); // addi a0, a0, 17
    const mapping = await call("address_to_file_offset", {
      address: addressFor("rea_riscv_probe"),
    });
    const sourceBytes = await readFile(fixture.path);
    assert.equal(
      sourceBytes
        .subarray(mapping.file_offset, mapping.file_offset + 4)
        .toString("hex"),
      probe.bytes,
    );
    const isaProbe = [];
    if (abi) {
      // ESP32-C3's and H4's -march declare Zifencei and Zicsr, and H4's F;
      // each must decode.
      for (const [offset, bytes, mnemonic] of [
        [0n, "0f100000", /^fence\.i$/iu],
        [4n, "f32200b0", /^csrr/iu],
        ...(abiName === "ilp32f"
          ? [
              [8n, "530005f0", /^fmv\.w\.x$/iu],
              [12n, "530500e0", /^fmv\.x\.w$/iu],
            ]
          : []),
      ]) {
        const instruction = await call("inspect_native_instruction", {
          address: `0x${(BigInt(addressFor("rea_riscv_isa_probe")) + offset).toString(16)}`,
        });
        assert.equal(instruction.status, "decoded");
        assert.equal(instruction.bytes, bytes);
        assert.match(instruction.mnemonic, mnemonic);
        isaProbe.push(instruction.mnemonic);
      }
    }
    const global = await call("read_bytes", {
      address: addressFor("rea_riscv_global"),
      length: 4,
    });
    assert.equal(global.bytes_hex, "07000000");
    const callees = await call("procedure_callees", {
      procedure: addressFor("rea_riscv_entry"),
    });
    for (const name of abi
      ? [...abi.callers, "rea_riscv_isa_probe", "rea_riscv_probe"]
      : ["rea_riscv_leaf", "rea_riscv_probe"])
      assert.ok(
        callees.some((address) => BigInt(address) === BigInt(addressFor(name))),
        `${name} missing from the entry's callees`,
      );
    const dossier = functionDossierSchema.parse(
      await call("analyze_function", {
        procedure: addressFor("rea_riscv_entry"),
        detail: "complete",
      }),
    );
    assert.ok(dossier.pseudocode.trim().length > 0);
    if (!stripped) {
      const floatCode = await call("procedure_pseudo_code", {
        procedure: addressFor(abi ? "rea_riscv_abi_wide" : "rea_riscv_float"),
      });
      assert.ok(typeof floatCode === "string" && floatCode.trim().length > 0);
      assert.match(floatCode, /\bdouble\b/u);
    }
    let storage;
    if (abi) {
      const boundaries = {};
      for (const name of Object.keys(abi.functions))
        boundaries[name] = (
          await call("inspect_native_api", { procedure: addressFor(name) })
        ).boundary;
      assertRiscvStorage(abiName, boundaries, { stripped });
      for (const name of abi.callers) {
        const caller = functionDossierSchema.parse(
          await call("analyze_function", {
            procedure: addressFor(name),
            detail: "complete",
          }),
        );
        assertRiscvCaller(abiName, name, caller.pseudocode, fixture.symbols, {
          stripped,
        });
      }
      storage = {
        abi: abiName,
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
      `${fixture.path.split(/[/\\]/).at(-1)}.snapshot.json`,
    );
    const saved = await call("close_binary", { snapshot_path: snapshotPath });
    assert.ok(saved.evidence_records > 0);
    const snapshot = parseAnalysisSnapshot(
      JSON.parse(await readFile(snapshotPath, "utf8")),
    );
    assert.equal(snapshot.target.identity.architecture, "riscv");
    assert.equal(snapshot.target.identity.sha256, fixture.sha256);
    assertProfile(snapshot.binding.analysis_profile);
    for (const record of snapshot.evidence_bundle.records)
      assertEvidence(parseEvidence(record));
    const outcomes = snapshot.evidence_bundle.records
      .flatMap((record) => parseEvidence(record).limitations)
      .map((limitation) => OUTCOME.exec(limitation))
      .filter((match) => match !== null);
    assert.equal(
      outcomes.length > 0,
      abi !== undefined,
      "Prototype outcome missing from, or unexpected in, retained Evidence",
    );
    // DWARF supplies the typed build's function definitions; stripping removes them.
    if (abi)
      for (const match of outcomes) {
        assert.equal(Number(match[1]) > 0, !stripped, match[0]);
        assert.equal(match[2], abi.prototype, match[0]);
      }
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
        [stripped ? addressFor("rea_riscv_entry") : "rea_riscv_entry"],
      ],
    ]) {
      const cli = await execOwned(
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
    if (pie) {
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
        { timeout: 60000, signal: commandInterruption.signal },
      );
      const error = requireMcpToolError(reply);
      assert.equal(error.details?.selection_reason, "target_unsupported");
      assert.equal(error.details?.requested_provider_id, "ghidra");
      const rejections = error.details?.rejections;
      assert.ok(Array.isArray(rejections));
      const rejection = rejections.find(
        ({ provider_id }) => provider_id === "ghidra",
      );
      assert.ok(rejection);
      assert.equal(rejection.code, "architecture_unsupported");
      headers.push({
        flags: "shared",
        outcome: "refused",
        reason: rejection.reason,
      });
    } else {
      // Header-mutated copies test admission; they are not new compiler claims.
      for (const [flags, outcome] of stripped
        ? []
        : abiName === "ilp32"
          ? [
              [0x3, "without f, which the single-float ABI (ilp32f)"],
              [0x80000001, "(0x80000000)"],
            ]
          : abiName === "ilp32f"
            ? [[0x80000003, "(0x80000000)"]]
            : bits === 32
              ? [
                  [0x1, "admitted"],
                  [0x3, "with d: ilp32f then preserves only the low 32 bits"],
                  [0x80000005, "(0x80000000)"],
                ]
              : [
                  [0x1, "soft-float ABI (lp64)"],
                  [0x3, "single-float ABI (lp64f)"],
                  [0x80000005, "(0x80000000)"],
                ]) {
        const mutatedPath = join(
          workspace,
          `rv${bits}${abi ? `-${fixture.variant}` : ""}-flags-${flags.toString(16)}.elf`,
        );
        const mutatedBytes = Buffer.from(sourceBytes);
        mutatedBytes.writeUInt32LE(flags, bits === 32 ? 36 : 48);
        await writeFile(mutatedPath, mutatedBytes);
        const reply = await client.callTool(
          {
            name: "open_binary",
            arguments: { path: mutatedPath, provider_id: "ghidra" },
          },
          { timeout: 240000, signal: commandInterruption.signal },
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
        const cliOptions = {
          env,
          timeout: 240000,
          maxBuffer: 16 * 1024 * 1024,
        };
        if (outcome === "admitted") {
          // The double-float image now declares ilp32: refused before, admitted
          // now through that lane with the image's own ISA string.
          assert.equal(
            requireMcpLifecycleResult(reply, "open_binary").sha256,
            createHash("sha256").update(mutatedBytes).digest("hex"),
          );
          requireMcpLifecycleResult(
            await client.callTool(
              { name: "close_binary", arguments: {} },
              { timeout: 240000, signal: commandInterruption.signal },
            ),
            "close_binary",
          );
          const want = expectedLane(fixture, flags);
          const cli = await execOwned(
            process.execPath,
            cliArguments,
            cliOptions,
          );
          assertProfile(
            parseEvidence(JSON.parse(cli.stdout)).analysis_profile,
            want,
          );
          headers.push({ flags, outcome, lane: want.lane });
          continue;
        }
        const error = requireMcpToolError(reply);
        assert.ok(
          JSON.stringify(error).includes(outcome),
          JSON.stringify(error),
        );
        await assert.rejects(
          execOwned(process.execPath, cliArguments, cliOptions),
          (cause) => {
            const output = `${cause?.snapshot?.stdout?.text ?? ""}\n${cause?.snapshot?.stderr?.text ?? ""}`;
            return (
              Number.isInteger(cause?.code) &&
              cause.code !== 0 &&
              output.includes(outcome)
            );
          },
        );
        headers.push({ flags, outcome: "refused", reason: outcome });
      }
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
      ...(storage === undefined
        ? {}
        : {
            abi: storage,
            prototype_outcome: outcomes.map((match) => match[0]),
          }),
      cli: true,
      stdio_mcp: true,
      snapshot_replay: true,
      original_unchanged: true,
    });
  }
  reports.push(await verifyUnmodelledRefusal());
  for (const variant of ["soft", "single"])
    reports.push(await verifyForeignLanguageRefusal(variant));
  for (const sites of callSites)
    reports.push({
      call_sites: {
        abi: sites.abi,
        fixture: sites.fixture,
        command: sites.command,
        version: sites.version,
        calls: sites.calls.map((value) => `${value.caller}:${value.target}`),
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
    `RISC-V command cleanup failed; retained diagnostic workspace: ${workspace}`,
    {
      cause:
        failure === undefined
          ? cleanupFailure
          : new AggregateError(
              [failure, cleanupFailure],
              "RISC-V verification and command cleanup both failed",
            ),
    },
  );
const completed = await completeVerifierRun(run);
let lineageFailure;
try {
  assertVerifierCleanupComplete(completed.process_lineage);
} catch (cause) {
  lineageFailure = cause;
}
if (lineageFailure !== undefined)
  throw retainWorkspace(
    `Cleanup unverified; retained workspace: ${workspace}`,
    {
      cause:
        failure === undefined
          ? lineageFailure
          : new AggregateError(
              [failure, lineageFailure],
              "RISC-V verification failed and cleanup was unverified",
            ),
    },
  );
if (failure !== undefined)
  throw retainWorkspace(
    `RISC-V verification failed; retained workspace: ${workspace}; MCP stderr: ${stderr}`,
    { cause: failure },
  );
const survivors = await readdir(runtime);
if (survivors.length > 0)
  throw retainWorkspace(
    `Runtime resources survived server shutdown (${survivors.join(", ")}); retained workspace: ${workspace}`,
  );
const interrupted = commandInterruption.reason();
if (interrupted !== undefined)
  throw retainWorkspace(
    `RISC-V verification interrupted; retained diagnostic workspace: ${workspace}`,
    { cause: interrupted },
  );
commandInterruption.retainWorkspaceIfInterrupted(workspaceFixture);
await workspaceFixture.release();
const releaseInterrupted = finishCommandInterruption();
if (releaseInterrupted !== undefined) throw releaseInterrupted;
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
