// Real-Ghidra lane for ARM M-profile raw images (architecture_variant,
// base_address, vector_table_address). Adapted from #4927 by Jean Granié.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { parseAnalysisSnapshot } from "../dist/domain/analysisSnapshot.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { GHIDRA_VARIANT_LANGUAGES } from "../dist/ghidra/GhidraRawBinaryLanguage.js";
import {
  CORTEX_M0_SOURCE,
  CORTEX_M55_SOURCE,
  THUMB2_SOURCE,
  V8M_BASELINE_SOURCE,
  V8M_MSPLIM_SOURCE,
  cortexM0Fixture,
  cortexM55Fixture,
  thumb2Fixture,
  v8mBaselineFixture,
  v8mMsplimFixture,
} from "../tests/conformance/ghidra/cortexM.fixture.mjs";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { llvmThumbMnemonics } from "./lib/llvm-thumb-oracle.mjs";
import {
  requireMcpLifecycleResult,
  requireMcpOutput,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";

if (process.argv.length !== 2)
  throw new Error("Usage: node scripts/verify-real-ghidra-cortex-m.mjs");
if (!["linux", "darwin"].includes(process.platform))
  throw new Error(
    "Cortex-M verification requires a Linux or macOS Ghidra host.",
  );
if (process.env.GHIDRA_INSTALL_DIR === undefined)
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to a bring-your-own Ghidra installation.",
  );
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
assert.equal(installation.status, "available", JSON.stringify(installation));
const run = createVerifierRun();
// Every LLVM and CLI command runs as an owned process tree with a deadline.
const commands = await createVerifierCommands();
const workspace = await mkdtemp(join(tmpdir(), "rea-cortex-m-proof-"));
// LLVM is the independent decoding oracle for every fixture.
const llvm = {
  clang: process.env.REA_CLANG ?? "clang",
  objdump: process.env.REA_LLVM_OBJDUMP ?? "llvm-objdump",
  commands,
  workspace,
};
const oracle = new Map();
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
// Only named settings reach REA, so an exported REA_GHIDRA_LANGUAGE_ID or other
// session setting cannot change what this lane verifies.
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  TMPDIR: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
  GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { JAVA_HOME: process.env.JAVA_HOME }),
  ...(process.env.GHIDRA_HEADLESS_MAXMEM === undefined
    ? {}
    : { GHIDRA_HEADLESS_MAXMEM: process.env.GHIDRA_HEADLESS_MAXMEM }),
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env,
  stderr: "pipe",
});
const client = new Client({ name: "rea-real-cortex-m-proof", version: "1" });
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-65536);
});
const hex = (value) => `0x${value.toString(16)}`;
const word = (value) => `0x${value.toString(16).padStart(8, "0")}`;
let report;
try {
  for (const source of [
    CORTEX_M0_SOURCE,
    THUMB2_SOURCE,
    V8M_BASELINE_SOURCE,
    V8M_MSPLIM_SOURCE,
    CORTEX_M55_SOURCE,
  ])
    oracle.set(source, await llvmThumbMnemonics(source, llvm));
  await client.connect(transport);
  const cases = [];
  for (const base of [0, 0x08000000])
    cases.push(
      await verifyCase({
        name: `armv6-m-${hex(base)}`,
        variant: "armv6-m",
        base,
        bytes: cortexM0Fixture(base),
        source: CORTEX_M0_SOURCE,
        stackPointer: 0x20001000,
      }),
    );
  // A boot2-style header precedes the vector table, as in RP2040 images.
  cases.push(
    await verifyCase({
      name: "armv6-m-prefixed",
      variant: "armv6-m",
      base: 0x10000000,
      prefix: 0x100,
      bytes: cortexM0Fixture(0x10000000, 0x100),
      source: CORTEX_M0_SOURCE,
      stackPointer: 0x20001000,
    }),
  );
  // Thumb-2 code under both v7 profiles; base 0 puts the image where
  // ARMCortex.pspec would label the vector table.
  for (const [variant, base] of [
    ["armv7-m", 0],
    ["armv7e-m", 0x08000000],
  ])
    cases.push(
      await verifyCase({
        name: `${variant}-thumb2-${hex(base)}`,
        variant,
        base,
        bytes: thumb2Fixture(base),
        source: THUMB2_SOURCE,
        stackPointer: 0x20003000,
      }),
    );
  cases.push(
    await verifyCase({
      name: "armv8-m.base",
      variant: "armv8-m.base",
      base: 0x08000000,
      bytes: v8mBaselineFixture(0x08000000),
      source: V8M_BASELINE_SOURCE,
      stackPointer: 0x20004000,
    }),
  );
  cases.push(
    await verifyCase({
      name: "armv8-m.main-msplim",
      variant: "armv8-m.main",
      base: 0x08000000,
      bytes: v8mMsplimFixture(0x08000000),
      source: V8M_MSPLIM_SOURCE,
      stackPointer: 0x20002000,
    }),
  );
  // A Cortex-M55 loop: WLS/LE around MVE, which only ARMv8.1-M has. Base 0
  // also puts the v8-m decoder where ARMCortex.pspec would label the table.
  // Ghidra 12.1.4 decodes WLS and LE, but places their targets wrongly and
  // gives LE no fall-through, so the pop after the loop is not disassembled.
  // The results carry that limitation; the case records both branches' flow.
  cases.push(
    await verifyCase({
      name: "armv8.1-m.main-m55",
      variant: "armv8.1-m.main",
      base: 0,
      bytes: cortexM55Fixture(0),
      source: CORTEX_M55_SOURCE,
      stackPointer: 0x20005000,
      notDisassembled: [0x5c],
      loopBranches: [0x46, 0x58],
    }),
  );
  const identity = await verifyIdentityAndSnapshots();
  assert.deepEqual(
    (await readdir(runtime)).filter((name) => name.startsWith("rea-ghidra-")),
    [],
    "Owned Ghidra runtime survived close",
  );
  report = {
    ok: true,
    mocked: false,
    lane: "ghidra-cortex-m",
    host: process.platform,
    provider: { id: "ghidra", version: installation.providerVersion },
    oracle: "llvm",
    cases,
    identity,
    transport: { cli: true, stdio_mcp: true },
    original_unchanged: true,
  };
} catch (error) {
  if (stderr.trim()) process.stderr.write(stderr);
  throw error;
} finally {
  await client.close();
  await transport.close();
  // Remove the workspace only after every owned command tree has stopped; a
  // failed close keeps it for inspection.
  await commands.close();
  await rm(workspace, { recursive: true, force: true });
}
const verifierRun = await completeVerifierRun(run);
assert.equal(verifierRun.process_lineage.status, "verified");
assert.deepEqual(verifierRun.process_lineage.descendants, []);
process.stdout.write(
  JSON.stringify({
    verifier_run: verifierRun,
    ...report,
    cleanup: "complete",
  }) + "\n",
);

async function verifyCase(fixture) {
  const prefix = fixture.prefix ?? 0;
  const address = (offset) => hex(fixture.base + prefix + offset);
  const entry = address(0x40);
  const digest = createHash("sha256").update(fixture.bytes).digest("hex");
  const path = join(workspace, `${fixture.name}.bin`);
  await writeFile(path, fixture.bytes);
  const selection = {
    path,
    format: "raw-binary",
    architecture: "arm",
    architecture_variant: fixture.variant,
    base_address: hex(fixture.base),
    ...(prefix === 0 ? {} : { vector_table_address: address(0) }),
  };
  const opened = await call("open_binary", selection);
  assert.deepEqual(
    {
      entry_point: opened.entry_point,
      base_address: opened.base_address,
      architecture_variant: opened.architecture_variant,
      vector_table_address: opened.vector_table_address,
    },
    {
      entry_point: entry,
      base_address: hex(fixture.base),
      architecture_variant: fixture.variant,
      vector_table_address: address(0),
    },
  );
  const image = await call("inspect_native_load_image", {}, digest);
  const loaded = image.normalized_result;
  assert.equal(loaded.status, "verified", JSON.stringify(image));
  assert.equal(loaded.layout, "segments");
  assert.equal(loaded.version, 1);
  assert.equal(loaded.language_id, GHIDRA_VARIANT_LANGUAGES[fixture.variant]);
  assert.deepEqual(loaded.segments, [
    {
      name: "image",
      address: hex(fixture.base),
      size: fixture.bytes.length,
      backing: { kind: "source-range", source: 0, offset: 0 },
    },
  ]);
  assert.deepEqual(loaded.entries, [
    {
      address: entry,
      isa_mode: "thumb",
      role: "reset",
      basis: "vector-table",
    },
  ]);
  // Without processor-defined labels, Reset is the only entry Ghidra reports.
  assert.equal(
    image.analysis_profile.parameters.processor_labels,
    "not-applied-v1",
  );
  assert.deepEqual(
    loaded.observations.entry_points,
    [entry],
    "Processor-defined vector labels became entries",
  );
  assert.deepEqual(loaded.vector_table, {
    address: address(0),
    initial_stack_pointer: word(fixture.stackPointer),
    reset_vector: word(fixture.base + prefix + 0x41),
  });
  assert.ok(
    loaded.checks.some(
      (check) =>
        check.name === "entry_context.TMode" &&
        check.matched &&
        check.observed === "0x1",
    ),
  );
  const memory = await call(
    "read_bytes",
    { address: hex(fixture.base), length: fixture.bytes.length },
    digest,
  );
  assert.equal(
    memory.normalized_result.bytes_hex,
    fixture.bytes.toString("hex"),
  );
  const { loopBranches } = await verifyDecoding(fixture, address, digest);
  await verifyOddEntryAndCli(fixture, selection, image, path);
  const notDisassembled = (fixture.notDisassembled ?? []).map(address);
  return {
    name: fixture.name,
    variant: fixture.variant,
    base: hex(fixture.base),
    entry,
    sha256: digest,
    language_id: loaded.language_id,
    thumb_entry_context: true,
    only_entry: entry,
    llvm_mnemonics_matched:
      oracle.get(fixture.source).size - notDisassembled.length,
    ...(notDisassembled.length === 0
      ? {}
      : { not_disassembled: notDisassembled }),
    ...(loopBranches.length === 0 ? {} : { loop_branches: loopBranches }),
    odd_entry_refused: true,
    cli_mcp_parity: true,
  };
}

/**
 * One spelling for both decoders, which write an encoding width (ldr.w) and an
 * IT-block condition (Ghidra mov.eq, LLVM moveq) differently.
 */
function canonicalMnemonic(name) {
  return name
    ?.toLowerCase()
    .replace(/\.[nw]$/u, "")
    .replace(/\.(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)$/u, "$1");
}

/**
 * Whether Ghidra and LLVM name the same instruction. A data type that gives
 * only the element size (Ghidra vldrw.32) matches one that adds signedness
 * (LLVM vldrw.u32); opposite signedness does not.
 */
function sameMnemonic(ghidra, llvm) {
  const left = canonicalMnemonic(ghidra) ?? "";
  const right = canonicalMnemonic(llvm) ?? "";
  if (left === right) return true;
  const typed = /^(.+)\.([su]?)(8|16|32|64)$/u;
  const a = typed.exec(left);
  const b = typed.exec(right);
  return (
    a !== null &&
    b !== null &&
    a[1] === b[1] &&
    a[3] === b[3] &&
    (a[2] === "" || b[2] === "")
  );
}

/** Ghidra's decoding at every oracle offset, in Thumb state, and its functions. */
async function verifyDecoding(fixture, address, digest) {
  const prefix = fixture.prefix ?? 0;
  const entry = address(0x40);
  // Offsets the case expects Ghidra's analysis not to reach: in memory, with
  // no listed instruction or data, which Ghidra reports as not-in-listing.
  const unreached = new Set(fixture.notDisassembled ?? []);
  // Collect every disagreement so one run reports them all.
  const disagreements = [];
  for (const [offset, mnemonic] of oracle.get(fixture.source)) {
    const decoded = (
      await call(
        "inspect_native_instruction",
        { address: address(offset) },
        digest,
      )
    ).normalized_result;
    if (unreached.has(offset)) {
      if (decoded.status !== "not-in-listing")
        disagreements.push({
          address: address(offset),
          llvm: mnemonic,
          ghidra: decoded.raw_disassembly ?? decoded.status,
          expected: "not disassembled",
        });
      continue;
    }
    const tmode = decoded.decoder_context?.find(
      (context) => context.register === "TMode",
    )?.value;
    if (
      decoded.status !== "decoded" ||
      !sameMnemonic(decoded.mnemonic, mnemonic) ||
      tmode !== "1"
    )
      disagreements.push({
        address: address(offset),
        llvm: mnemonic,
        ghidra: decoded.raw_disassembly ?? decoded.status,
        tmode,
      });
  }
  assert.deepEqual(
    disagreements,
    [],
    `${fixture.name}: ${JSON.stringify(disagreements)}`,
  );
  const procedures = await call("list_procedures", {}, digest);
  assert.ok(
    procedures.normalized_result.some((item) => item.address === entry),
  );
  assert.ok(
    !procedures.normalized_result.some((item) => item.address === address(0)),
    "Vector table became a function",
  );
  if (fixture.source === V8M_MSPLIM_SOURCE) {
    const msplim = await call(
      "inspect_native_instruction",
      { address: address(0x48) },
      digest,
    );
    assert.match(msplim.normalized_result.raw_disassembly ?? "", /msplim/iu);
  } else if (fixture.source === CORTEX_M0_SOURCE) {
    const helper = await call(
      "procedure_pseudo_code",
      { procedure: address(0x56) },
      digest,
    );
    assert.match(helper.normalized_result, /\+\s*(?:3|0x3)\b/u);
    const caller = await call(
      "procedure_pseudo_code",
      { procedure: entry },
      digest,
    );
    assert.match(caller.normalized_result, /==\s*(?:10|0xa)\b/iu);
    const byOffset = await call(
      "procedure_pseudo_code",
      { procedure: `file-offset:${hex(prefix + 0x56)}` },
      digest,
    );
    assert.equal(byOffset.normalized_result, helper.normalized_result);
  }
  // Ghidra's flow for the low-overhead-loop branches, recorded as evidence for
  // the limitation that armv8.1-m.main results carry.
  const loopBranches = [];
  for (const offset of fixture.loopBranches ?? []) {
    const evidence = await call(
      "inspect_native_instruction",
      { address: address(offset) },
      digest,
    );
    assert.ok(
      evidence.limitations.some((text) => text.includes("low-overhead-loop")),
      `${fixture.name}: results omit the low-overhead-loop limitation`,
    );
    const { raw_disassembly: disassembly, flow } = evidence.normalized_result;
    loopBranches.push({
      address: address(offset),
      disassembly,
      conditional: flow.conditional,
      destinations: flow.direct_destinations,
    });
  }
  return { loopBranches };
}

/** Refuse an odd entry with its code address, keep the session, and match the CLI. */
async function verifyOddEntryAndCli(fixture, selection, image, path) {
  const prefix = fixture.prefix ?? 0;
  const address = (offset) => hex(fixture.base + prefix + offset);
  const entry = address(0x40);
  const before = (await call("binary_session")).analysis_run.run_id;
  // vector_table_address applies only without entry_point.
  const { vector_table_address: _table, ...explicit } = selection;
  const odd = requireMcpToolError(
    await client.callTool({
      name: "open_binary",
      arguments: { ...explicit, entry_point: address(0x41) },
    }),
  );
  assert.equal(odd.details?.diagnostics?.code_address, entry);
  assert.match(
    String(odd.details?.diagnostics?.suggestion),
    /Omit entry_point/u,
  );
  assert.equal((await call("binary_session")).analysis_run.run_id, before);
  await call("close_binary");
  const cli = parseEvidence(
    JSON.parse(
      (
        await commands.exec(
          process.execPath,
          [
            entrypoint,
            "inspect-native-load-image",
            path,
            "--target-format",
            "raw-binary",
            "--architecture",
            "arm",
            "--architecture-variant",
            fixture.variant,
            "--base-address",
            hex(fixture.base),
            ...(prefix === 0 ? [] : ["--vector-table-address", address(0)]),
            "--provider",
            "ghidra",
            "--json",
          ],
          { env, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
        )
      ).stdout,
    ),
  );
  assert.equal(cli.analysis_profile.digest, image.analysis_profile.digest);
  assert.deepEqual(cli.normalized_result, image.normalized_result);
  assert.deepEqual(await readFile(path), fixture.bytes);
}

async function verifyIdentityAndSnapshots() {
  const base = 0x08000000;
  const bytes = cortexM0Fixture(base);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const path = join(workspace, "identity.bin");
  const snapshotPath = join(workspace, "identity.snapshot.json");
  await writeFile(path, bytes);
  const mProfile = {
    path,
    format: "raw-binary",
    architecture: "arm",
    architecture_variant: "armv7-m",
    base_address: "0x08000000",
  };
  // A load without a variant keeps the raw-binary image and generic ARM.
  const legacy = {
    path,
    format: "raw-binary",
    architecture: "arm",
    entry_point: "0x8000000",
  };
  await call("open_binary", legacy);
  const legacyImage = await call("inspect_native_load_image", {}, digest);
  assert.equal(legacyImage.normalized_result.layout, undefined);
  assert.equal(legacyImage.normalized_result.base_address, "0x8000000");
  assert.equal(
    legacyImage.analysis_profile.parameters.language_id,
    "ARM:LE:32:v7",
  );
  await call("close_binary");
  // A separate base is refused without a variant.
  const baseOnly = await client.callTool({
    name: "open_binary",
    arguments: { ...legacy, base_address: "0x08000000" },
  });
  assert.equal(baseOnly.isError, true);
  await call("open_binary", mProfile);
  const image = await call("inspect_native_load_image", {}, digest);
  assert.notEqual(
    image.analysis_profile.digest,
    legacyImage.analysis_profile.digest,
  );
  const procedures = await call("list_procedures", {}, digest);
  await call("close_binary", { snapshot_path: snapshotPath });
  const snapshot = parseAnalysisSnapshot(
    JSON.parse(await readFile(snapshotPath, "utf8")),
  );
  assert.equal(snapshot.target.raw_load?.version, 1);
  // A base spelling is not identity; the snapshot replays.
  await call("open_binary", {
    ...mProfile,
    base_address: "0x8000000",
    snapshot_path: snapshotPath,
  });
  assert.deepEqual(await call("list_procedures", {}, digest), procedures);
  await call("close_binary");
  // Another variant is another load; the snapshot is refused.
  const refused = await client.callTool({
    name: "open_binary",
    arguments: {
      ...mProfile,
      architecture_variant: "armv8-m.main",
      snapshot_path: snapshotPath,
    },
  });
  assert.equal(refused.isError, true);
  assert.deepEqual(await readFile(path), bytes);
  return {
    legacy_identity_unchanged: true,
    base_without_variant_refused: true,
    base_spelling_reuses_snapshot: true,
    variant_partitions_snapshot: true,
  };
}

async function call(name, args = {}, targetSha256) {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: 240000 },
  );
  if (["open_binary", "close_binary", "binary_session"].includes(name))
    return requireMcpLifecycleResult(result, name);
  const evidence = parseEvidence(requireMcpOutput(result, name));
  if (targetSha256 !== undefined)
    assert.equal(evidence.subject.digest.sha256, targetSha256);
  assert.equal(evidence.subject.format, "raw-binary");
  return evidence;
}
