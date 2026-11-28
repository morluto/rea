#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import {
  inspectArmReadelf,
  assertArmLoadedImage,
  assertArmProbe,
} from "../tests/conformance/ghidra/arm-checks.mjs";
import { parseEvidence } from "../dist/domain/evidence.js";
import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { functionDossierSchema } from "../dist/domain/native/functionDossier.js";
import { BinaryReader } from "../dist/domain/binaryContainer.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { buildArmFixture } from "../tests/conformance/ghidra/arm-fixture.mjs";
import {
  requireMcpToolError,
  requireMcpOperationResult,
} from "./lib/mcp-verifier-results.mjs";
import {
  assertVerifierCleanupComplete,
  createVerifierRun,
  completeVerifierRun,
} from "./lib/verifier-run.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { removeArmAttributes } from "./lib/arm-objcopy.mjs";
import { VerifierFixture } from "./lib/verifier-fixture.mjs";

// Optional cross-target lane. No tool acquisition and no target execution.
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "ARM verification requires a supported Linux/macOS Ghidra host",
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
// A caller-selected objcopy is exclusive; defaults are tried only without one.
const selectedObjcopy = process.env.REA_ARM_OBJCOPY;
const objcopyCandidates =
  selectedObjcopy === undefined
    ? ["llvm-objcopy", "llvm-objcopy-21", "objcopy"]
    : [selectedObjcopy];
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const run = createVerifierRun();
const workspaceFixture = await VerifierFixture.open({
  prefix: "rea-arm-proof-",
  // Ghidra children use the workspace as TMPDIR; a plain root admits them on every host.
  private: false,
});
const workspace = workspaceFixture.path;
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
// One owner for the compiler, readers, objcopy and the CLI; closed before the
// lineage check so no launched child outlives the run unobserved.
const commands = await createVerifierCommands();
const execute = (command, args, options) =>
  commands.exec(command, args, options);
const reports = [];
let primaryFailure;
try {
  const fixture = await buildArmFixture(workspace, commands);
  const independent = await inspectArmReadelf(commands, fixture.path);
  const resolved = await parseBinaryTarget(fixture.path);
  if (!resolved.ok) throw resolved.error;
  assert.equal(resolved.value.architecture, "arm");
  assert.deepEqual(
    resolved.value.arm,
    {
      elfClass: 32,
      byteOrder: "little",
      headerSize: 52,
      type: 2,
      flags: independent.flags,
      cpuArch: 10,
      cpuArchProfile: "A",
    },
    "REA ELF interpretation disagrees with GNU readelf or the declared ISA",
  );
  const readelfCommand = process.env.REA_ARM_READELF ?? "readelf";
  const readelfAttributes = await execute(
    readelfCommand,
    ["-A", fixture.path],
    { env: { ...process.env, LC_ALL: "C" }, timeout: 30000 },
  );
  assert.match(
    readelfAttributes.stdout,
    /Tag_CPU_arch:\s*v7\b/u,
    "The fixture must declare the v7 ISA the lane pins",
  );
  assert.match(
    readelfAttributes.stdout,
    /Tag_CPU_arch_profile:\s*Application\b/u,
    "The fixture must declare the Application profile the lane pins",
  );
  assert.equal(resolved.value.sha256, fixture.sha256);
  const snapshotPath = join(workspace, "arm.snapshot.json");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-real-arm-proof", version: "1" });
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
  try {
    await client.connect(transport);
    const selected = await call("open_binary", {
      path: fixture.path,
      provider_id: "ghidra",
    });
    assert.equal(selected.architecture, "arm");
    assert.equal(selected.sha256, fixture.sha256);
    const image = await call("inspect_native_load_image");
    assertArmLoadedImage(image.observations, fixture.sha256);
    const procedures = await call("list_procedures");
    const entry = procedures.find((p) => p.value === "rea_arm_entry");
    const leaf = procedures.find((p) => p.value === "rea_arm_leaf");
    const thumb = procedures.find((p) => p.value === "rea_arm_probe_thumb");
    assert.ok(entry, "Entry function missing from real Ghidra inventory");
    assert.ok(leaf, "Leaf function missing from real Ghidra inventory");
    assert.ok(
      thumb,
      "Thumb-2 interworked function missing from real Ghidra inventory",
    );
    assert.equal(
      BigInt(entry.address),
      BigInt(independent.symbols.rea_arm_entry),
    );
    const armProbe = await call("inspect_native_instruction", {
      address: independent.symbols.rea_arm_probe_arm,
    });
    const thumbBase = BigInt(independent.symbols.rea_arm_probe_thumb);
    const thumbMovw = await call("inspect_native_instruction", {
      address: `0x${thumbBase.toString(16)}`,
    });
    const thumbMovt = await call("inspect_native_instruction", {
      address: `0x${(thumbBase + 4n).toString(16)}`,
    });
    assertArmProbe(armProbe, thumbMovw, thumbMovt);
    assert.equal(armProbe.architecture, "ARM:LE:32:v7");
    assert.equal(thumbMovw.architecture, "ARM:LE:32:v7");
    assert.equal(thumbMovt.architecture, "ARM:LE:32:v7");
    const global = await call("read_bytes", {
      address: independent.symbols.rea_arm_global,
      length: 4,
    });
    assert.equal(global.returned_bytes, 4);
    assert.equal(global.bytes_hex, "07000000");
    const marker = await call("read_bytes", {
      address: independent.symbols.rea_arm_marker,
      length: Buffer.byteLength("rea-arm-source-owned-fixture\0"),
    });
    assert.equal(
      marker.bytes_hex,
      Buffer.from("rea-arm-source-owned-fixture\0").toString("hex"),
    );
    const callees = await call("procedure_callees", {
      procedure: entry.address,
    });
    assert.ok(
      callees.includes(leaf.address),
      "Expected direct call not recovered",
    );
    assert.ok(
      callees.includes(thumb.address),
      "Expected interworking call into the Thumb probe not recovered",
    );
    const dossier = functionDossierSchema.parse(
      await call("analyze_function", {
        procedure: entry.address,
        detail: "complete",
      }),
    );
    assert.ok(dossier.pseudocode.trim().length > 0);
    const saved = await call("close_binary", { snapshot_path: snapshotPath });
    assert.ok(saved.evidence_records > 0);
    const snapshot = parseAnalysisSnapshot(
      JSON.parse(await readFile(snapshotPath, "utf8")),
    );
    assert.equal(snapshot.target.identity.architecture, "arm");
    const parameters = snapshot.binding.analysis_profile.parameters;
    assert.equal(parameters.language_id, "ARM:LE:32:v7");
    assert.equal(parameters.language_selection, "provider-pinned");
    assert.equal(parameters.arm_support_lane, "elf32-exec-le-eabi5-v7-pinned");
    assert.deepEqual(parameters.arm_elf, {
      elf_class: 32,
      byte_order: "little",
      type: 2,
      flags: independent.flags,
      cpu_arch: 10,
      cpu_arch_name: "v7",
      cpu_arch_profile: "A",
      float_abi: "hard",
    });
    for (const evidence of snapshot.evidence_bundle.records)
      assert.equal(
        parseEvidence(evidence).subject?.identity.architecture,
        "arm",
      );
    await call("open_binary", {
      path: fixture.path,
      provider_id: "ghidra",
      snapshot_path: snapshotPath,
    });
    assert.deepEqual(await call("list_procedures"), procedures);
    await call("close_binary");
  } catch (cause) {
    throw new Error(`ARM verification failed; MCP stderr: ${stderr}`, {
      cause,
    });
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
  }

  // Typed refusals for shapes the verified lane does not cover: a legacy EABI
  // version (field zeroed to 0x04000000) and a BE8 mixed-endian declaration.
  const refusals = [];
  for (const [label, mask, set] of [
    ["legacy-eabi", 0xff000000, 0x04000000],
    ["be8", 0x00800000, 0x00800000],
  ]) {
    const original = await readFile(fixture.path);
    const patched = Buffer.from(original);
    const flags = new BinaryReader(patched, true, "elf").u32(36);
    patched.writeUInt32LE((flags & ~mask) | set, 36);
    const variantPath = join(workspace, `arm-${label}.elf`);
    await writeFile(variantPath, patched);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "mcp"],
      env,
      stderr: "pipe",
    });
    const client = new Client({ name: "rea-real-arm-refusal", version: "1" });
    try {
      await client.connect(transport);
      const rejected = await client.callTool(
        {
          name: "open_binary",
          arguments: { path: variantPath, provider_id: "ghidra" },
        },
        { timeout: 60000 },
      );
      const error = requireMcpToolError(rejected);
      const text = JSON.stringify(error);
      assert.match(text, label === "legacy-eabi" ? /EABI5/u : /BE8/u);
      refusals.push({ variant: label, error });
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
  }

  // Typed refusals for ISA declarations the verified lane does not cover: a
  // real armv8-a build (attributes declare v8) and the same v7 fixture with
  // its .ARM.attributes removed, so neither a newer ISA nor an absent
  // declaration can slip into the v7-pinned lane.
  const compiler = process.env.REA_ARM_CLANG ?? "clang";
  const v8Path = join(workspace, "arm-v8a.elf");
  // Built from the same conformance sources as the fixture: pure assembly
  // records no float convention, and the lane's other gates must stay green
  // so the refusal can only come from the declared ISA.
  await execute(
    compiler,
    [
      "--target=arm-linux-gnueabihf",
      "-march=armv8-a+crc+fp",
      "-mfloat-abi=hard",
      "-fno-pic",
      "-fuse-ld=lld",
      "-nostdlib",
      "-static",
      "-O0",
      "-Wl,-e,rea_arm_entry",
      "-Wl,--build-id=none",
      fileURLToPath(new URL("../tests/conformance/c/arm.c", import.meta.url)),
      fileURLToPath(
        new URL("../tests/conformance/ghidra/arm-probe.S", import.meta.url),
      ),
      "-o",
      v8Path,
    ],
    { timeout: 60000 },
  );
  const r5Path = join(workspace, "arm-r5.elf");
  // cortex-r5 declares Tag_CPU_arch v7 with the Realtime profile, so the
  // arch enum alone matches the lane while the variant does not.
  await execute(
    compiler,
    [
      "--target=arm-linux-gnueabihf",
      "-mcpu=cortex-r5",
      "-mfloat-abi=hard",
      "-fno-pic",
      "-fuse-ld=lld",
      "-nostdlib",
      "-static",
      "-O0",
      "-Wl,-e,rea_arm_entry",
      "-Wl,--build-id=none",
      fileURLToPath(new URL("../tests/conformance/c/arm.c", import.meta.url)),
      fileURLToPath(
        new URL("../tests/conformance/ghidra/arm-probe.S", import.meta.url),
      ),
      "-o",
      r5Path,
    ],
    { timeout: 60000 },
  );
  const r5Attributes = await execute(readelfCommand, ["-A", r5Path], {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 30000,
  });
  assert.match(
    r5Attributes.stdout,
    /Tag_CPU_arch:\s*v7\b/u,
    "The cortex-r5 variant must declare the v7 arch enum",
  );
  assert.match(
    r5Attributes.stdout,
    /Tag_CPU_arch_profile:\s*Realtime\b/u,
    "The cortex-r5 variant must declare the Realtime profile",
  );
  const noAttributesPath = join(workspace, "arm-v7-noattributes.elf");
  await writeFile(noAttributesPath, await readFile(fixture.path));
  // Candidate selection is proven by this operation, not by --version: GNU
  // objcopy on Fedora answers --version and then cannot parse ARM input.
  const stripped = await removeArmAttributes(
    objcopyCandidates,
    execute,
    noAttributesPath,
    { fallback: selectedObjcopy === undefined },
  );
  const stripReceipt = {
    attribute_strip_tool: stripped.tool,
    attribute_strip_fallbacks: stripped.failures,
  };
  const variantMetadata = [
    { label: "v8a", path: v8Path, cpuArch: 14, profile: "A", pattern: /v8-A/u },
    {
      label: "r5-profile",
      path: r5Path,
      cpuArch: 10,
      profile: "R",
      pattern: /Realtime profile/u,
    },
    {
      label: "no-attributes",
      path: noAttributesPath,
      cpuArch: null,
      profile: null,
      pattern: /Tag_CPU_arch/u,
    },
  ];
  for (const variant of variantMetadata) {
    const variantResolved = await parseBinaryTarget(variant.path);
    if (!variantResolved.ok) throw variantResolved.error;
    assert.equal(
      variantResolved.value.arm.cpuArch,
      variant.cpuArch,
      `ISA declaration for the ${variant.label} variant`,
    );
    assert.equal(
      variantResolved.value.arm.cpuArchProfile,
      variant.profile,
      `Profile declaration for the ${variant.label} variant`,
    );
    const variantTransport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "mcp"],
      env,
      stderr: "pipe",
    });
    const variantClient = new Client({
      name: "rea-real-arm-refusal",
      version: "1",
    });
    try {
      await variantClient.connect(variantTransport);
      const rejected = await variantClient.callTool(
        {
          name: "open_binary",
          arguments: { path: variant.path, provider_id: "ghidra" },
        },
        { timeout: 60000 },
      );
      const error = requireMcpToolError(rejected);
      const text = JSON.stringify(error);
      assert.match(
        text,
        variant.pattern,
        `The ${variant.label} variant must refuse with its typed ISA reason`,
      );
      refusals.push({ variant: variant.label, error });
    } finally {
      try {
        await variantClient.close();
      } finally {
        await variantTransport.close();
      }
    }
  }

  // Same public operation through CLI, not a private injected provider.
  const cli = await execute(
    process.execPath,
    [
      entrypoint,
      "function",
      fixture.path,
      "rea_arm_entry",
      "--provider",
      "ghidra",
      "--json",
    ],
    { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
  );
  const evidence = parseEvidence(JSON.parse(cli.stdout));
  assert.equal(evidence.subject?.identity.architecture, "arm");
  assert.equal(evidence.subject?.identity.sha256, fixture.sha256);
  const cliDossier = functionDossierSchema.parse(evidence.normalized_result);
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
    effective_language: "ARM:LE:32:v7",
    checks: [
      "independent ELF and symbols",
      "attributes-declared Tag_CPU_arch v7 admission",
      "pinned ARM:LE:32:v7 language checked after import",
      "ARM and Thumb-2 probe encodings",
      "typed refusals for legacy EABI, BE8, v8-A, Realtime profile, and absent attributes",
      stripReceipt,
      "snapshot round-trip and CLI parity",
    ],
    refusals,
    status: "passed",
  });
} catch (cause) {
  primaryFailure = cause;
}
let completed;
try {
  await withVerifierCleanup(async () => {
    if (primaryFailure !== undefined) throw primaryFailure;
  }, [
    async () => {
      await workspaceFixture.closeEarly([() => commands.close()]);
      completed = await completeVerifierRun(run);
      assertVerifierCleanupComplete(completed.process_lineage);
    },
  ]);
} catch (cause) {
  throw workspaceFixture.retainedError(
    `ARM verification failed; retained workspace: ${workspace}`,
    { cause },
  );
}
await workspaceFixture.release();
console.log(JSON.stringify({ ...completed, fixtures: reports }, null, 2));
