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
import { parseEvidence } from "../dist/domain/evidence.js";
import { buildGameBoyRom } from "../tests/conformance/ghidra/gameboy-fixture.mjs";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import {
  createVerifierRun,
  completeVerifierRun,
  assertVerifierCleanupComplete,
} from "./lib/verifier-run.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";

if (
  process.argv.length !== 2 ||
  !process.env.GHIDRA_INSTALL_DIR ||
  !["linux", "darwin"].includes(process.platform)
)
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to a Linux/macOS Ghidra installation with SM83:LE:16:default, then run this verifier without arguments",
  );
const execute = promisify(execFile);
const run = createVerifierRun();
const workspace = await mkdtemp(join(tmpdir(), "rea-gameboy-proof-"));
const runtime = join(workspace, "runtime");
await mkdir(runtime);
const seeds = join(workspace, "seeds.tsv");
await writeFile(
  seeds,
  "0x4000\tfunction\tbank_one\nROM_002:0x4000\tfunction\tbank_two\nROM_003:0x4000\tfunction\tbank_three\n",
);
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const baseEnv = {
  ...process.env,
  TMPDIR: runtime,
  TMP: runtime,
  TEMP: runtime,
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "ghidra",
  REA_PROCESS_RUN_ID: run.run_id,
};
delete baseEnv.REA_GHIDRA_SEED_FILE;
delete baseEnv.REA_GHIDRA_LANGUAGE_ID;
delete baseEnv.REA_GHIDRA_COMPILER_SPEC_ID;
const cases = [];
let completed;
try {
  await withVerifierCleanup(async () => {
    // CLI covers the unbanked DMG route; MCP covers banking, CGB, instructions and decompilation.
    const dmgPath = join(workspace, "dmg.gb");
    const dmg = buildGameBoyRom({ banks: 2 });
    await writeFile(dmgPath, dmg);
    const { stdout } = await execute(
      process.execPath,
      [
        entrypoint,
        "inspect-native-load-image",
        dmgPath,
        "--target-format",
        "gameboy-rom",
        "--provider",
        "ghidra",
        "--json",
      ],
      {
        env: { ...baseEnv, REA_GHIDRA_LANGUAGE_ID: "SM83:LE:16:default" },
        timeout: 360000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    const cli = parseEvidence(JSON.parse(stdout));
    assertImage(cli.normalized_result, dmg, 2);
    assert.equal(cli.subject.format, "gameboy-rom");
    cases.push({
      route: "cli",
      kind: "DMG",
      banks: 2,
      attestation: cli.normalized_result.status,
      sha256: digest(dmg),
    });
    assert.deepEqual(await readFile(dmgPath), dmg);
    assert.deepEqual(await readdir(runtime), []);

    const path = join(workspace, "cgb.gbc");
    const rom = buildGameBoyRom({ banks: 4, cgb: true });
    await writeFile(path, rom);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "mcp"],
      env: { ...baseEnv, REA_GHIDRA_SEED_FILE: seeds },
      stderr: "pipe",
    });
    const client = new Client({ name: "rea-real-gameboy-proof", version: "1" });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    const call = async (name, args = {}) =>
      requireMcpOperationResult(
        await client.callTool({ name, arguments: args }, undefined, {
          timeout: 360000,
        }),
        name,
      );
    try {
      await client.connect(transport);
      const opened = await call("open_binary", {
        path,
        format: "gameboy-rom",
        provider_id: "ghidra",
      });
      assert.equal(opened.architecture, "sm83");
      assert.equal(opened.entry_point, "0x100");
      const image = await call("inspect_native_load_image");
      assertImage(image, rom, 4);
      // Check actual SM83-specific decoding, not a matching processor label alone.
      const ldh = await call("inspect_native_instruction", {
        address: "0x152",
      });
      assert.match(ldh.mnemonic, /LDH/iu);
      const swap = await call("inspect_native_instruction", {
        address: "0x158",
      });
      assert.match(swap.mnemonic, /SWAP/iu);
      const procedures = await call("list_procedures");
      for (const address of [
        "0x100",
        "0x180",
        "0x4000",
        "ROM_002:0x4000",
        "ROM_003:0x4000",
      ])
        assert.ok(
          procedures.some((procedure) => procedure.address === address),
          `Missing function ${address}`,
        );
      for (const [bank, address] of [
        [1, "0x4000"],
        [2, "ROM_002:0x4000"],
        [3, "ROM_003:0x4000"],
      ]) {
        const bytes = await call("read_bytes", { address, length: 3 });
        assert.equal(
          bytes.bytes_hex,
          Buffer.from([0x3e, bank, 0xc9]).toString("hex"),
        );
        const pseudo = await call("procedure_pseudo_code", {
          procedure: address,
        });
        assert.ok(pseudo.length > 0, `No pseudocode for bank ${bank}`);
        const filePseudo = await call("procedure_pseudo_code", {
          procedure: `file-offset:0x${(bank * 0x4000).toString(16)}`,
        });
        assert.equal(filePseudo, pseudo);
      }
      const invalid = join(workspace, "truncated.gb");
      await writeFile(invalid, rom.subarray(0, rom.length - 1));
      const rejected = await client.callTool({
        name: "open_binary",
        arguments: {
          path: invalid,
          format: "gameboy-rom",
          provider_id: "ghidra",
        },
      });
      assert.equal(rejected.isError, true);
      const preserved = await call("binary_session");
      assert.equal(preserved.sha256, digest(rom));
      await call("close_binary");
      await client.ping();
      cases.push({
        route: "mcp",
        kind: "CGB",
        banks: 4,
        attestation: image.status,
        language: image.observations.language_id,
        instructions: [ldh.mnemonic, swap.mnemonic],
        seeded_bank_functions: 3,
        sha256: digest(rom),
      });
    } catch (error) {
      error.message += `\nMCP stderr:\n${stderr}`;
      throw error;
    } finally {
      await client.close();
      await transport.close();
    }
    assert.deepEqual(await readFile(path), rom);
    assert.deepEqual(await readdir(runtime), []);
  }, [
    async () => {
      completed = await completeVerifierRun(run);
      assertVerifierCleanupComplete(completed.process_lineage);
    },
  ]);
} catch (cause) {
  throw new Error(
    `Game Boy Ghidra verification failed; retained workspace: ${workspace}`,
    { cause },
  );
}
await rm(workspace, { recursive: true, force: true });
console.log(
  JSON.stringify(
    {
      ...completed,
      cases,
      original_bytes_preserved: true,
      runtime_cleanup: "verified",
      limitations: [
        "Synthetic cartridge analysis only; no commercial ROM corpus, emulator execution, runtime bank-switch resolution or Windows coverage.",
      ],
    },
    null,
    2,
  ),
);
function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function assertImage(image, rom, banks) {
  assert.equal(
    image.status,
    "verified",
    JSON.stringify(image.checks?.filter((check) => !check.matched)),
  );
  assert.equal(image.format, "gameboy-rom");
  assert.equal(image.target_sha256, digest(rom));
  assert.equal(image.rom_banks, banks);
  assert.equal(image.observations.language_id, "SM83:LE:16:default");
  assert.equal(image.observations.source_files[0].size, rom.length);
}
