import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { buildGameBoyRom } from "../../tests/conformance/ghidra/gameboy-fixture.mjs";
import { parseGameBoyHeader, gameBoyRomBanks } from "../domain/gameBoyRom.js";
import { parseBinaryTarget } from "../application/BinaryTargetResolver.js";
import { binaryTargetSummary } from "../application/binary/BinaryTargetSummary.js";
import { snapshotTarget } from "../domain/analysisSnapshot.js";
import { openBinaryInputSchema } from "../contracts/sessionLifecycleInputs.js";
import { parseConfig } from "../config/parseConfig.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import { silentLogger } from "../logger.js";
import { parseGhidraSeeds } from "./GhidraAnalysisSeeds.js";
import { attestGhidraGameBoyLoadImage } from "./GhidraGameBoyLoadImage.js";
import { ghidraHeadlessArguments } from "./GhidraLauncher.js";
import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const targetFor = async (banks = 4) => {
  const directory = await createTestTempDirectory("rea-gameboy-");
  const rom = buildGameBoyRom({ banks });
  const path = join(directory, "test.gb");
  await writeFile(path, rom);
  const parsed = await parseBinaryTarget(path, { formatHint: "gameboy-rom" });
  if (!parsed.ok) throw parsed.error;
  if (parsed.value.format !== "gameboy-rom") throw new Error("wrong target");
  return { target: parsed.value, rom, directory };
};

describe("Game Boy cartridge boundary", () => {
  it.each([2, 4, 72, 80, 96, 512])(
    "retains header declarations and every bank for %i banks",
    (banks) => {
      const rom = buildGameBoyRom({ banks, cgb: true });
      const result = parseGameBoyHeader(rom, rom.length);
      if (!result.ok) throw new Error(result.error);
      expect(result.value).toMatchObject({
        title: "REA TEST",
        romBanks: banks,
        cgbFlag: 0xc0,
        logoMatches: true,
        headerChecksumMatches: true,
      });
      expect(gameBoyRomBanks(result.value)).toHaveLength(banks);
    },
  );
  it.each([
    [0x52, 72],
    [0x53, 80],
    [0x54, 96],
  ])("validates special ROM size code %#", (sizeCode, banks) => {
    const rom = buildGameBoyRom({ banks });
    expect(rom[0x148]).toBe(sizeCode);
    const parsed = parseGameBoyHeader(rom, rom.length);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.romBanks).toBe(banks);
    const lastBank = gameBoyRomBanks(parsed.value).at(-1);
    expect(lastBank).toMatchObject({
      bank: banks - 1,
      fileOffset: (banks - 1) * 0x4000,
      size: 0x4000,
    });
    expect(lastBank!.fileOffset + lastBank!.size).toBe(rom.length);
    expect(
      parseGameBoyHeader(rom.subarray(0, rom.length - 1), rom.length - 1).ok,
    ).toBe(false);
    const padded = Buffer.concat([rom, Buffer.from([0])]);
    expect(parseGameBoyHeader(padded, padded.length).ok).toBe(false);
  });
  it("rejects truncated, padded, unknown-size and unsupported-mapper inputs", () => {
    const rom = buildGameBoyRom();
    expect(parseGameBoyHeader(rom.subarray(0, 0x100), rom.length).ok).toBe(
      false,
    );
    expect(parseGameBoyHeader(rom, rom.length - 1).ok).toBe(false);
    expect(parseGameBoyHeader(rom, rom.length + 1).ok).toBe(false);
    rom[0x148] = 0xff;
    expect(parseGameBoyHeader(rom, rom.length).ok).toBe(false);
    rom[0x148] = 1;
    rom[0x147] = 0x0b;
    expect(parseGameBoyHeader(rom, rom.length).ok).toBe(false);
  });
  it("retains bad checksum and logo as warnings for explicit static inspection", () => {
    const rom = buildGameBoyRom();
    rom[0x104] = 0;
    rom[0x14d] = 0;
    const result = parseGameBoyHeader(rom, rom.length);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.logoMatches).toBe(false);
    expect(result.value.headerChecksumMatches).toBe(false);
    expect(result.value.limitations).toHaveLength(3);
  });
  it("shares explicit selection, target identity, and snapshots", async () => {
    const { target, rom } = await targetFor();
    expect(target.sha256).toBe(hash(rom));
    expect(binaryTargetSummary(target)).toMatchObject({
      format: "gameboy-rom",
      architecture: "sm83",
      entry_point: "0x100",
    });
    expect(snapshotTarget(target)).toMatchObject({
      format: "gameboy-rom",
      architecture: "sm83",
      entry_point: "0x100",
    });
    expect(
      openBinaryInputSchema.safeParse({
        path: target.path,
        format: "gameboy-rom",
      }).success,
    ).toBe(true);
    for (const extra of [{ architecture: "x86" }, { entry_point: "0x100" }])
      expect(
        openBinaryInputSchema.safeParse({
          path: target.path,
          format: "gameboy-rom",
          ...extra,
        }).success,
      ).toBe(false);
    expect((await parseBinaryTarget(target.path)).ok).toBe(false);
  });
  it("fails with an actionable prerequisite and commits an installed SM83 language", async () => {
    const { target, directory } = await targetFor();
    const config = parseConfig({ GHIDRA_INSTALL_DIR: directory });
    if (!config.ok) throw config.error;
    const provider = new GhidraProvider(config.value, silentLogger, {}, host);
    const missing = await provider.resolveAnalysisProfile(target);
    expect(missing.ok).toBe(false);
    const languages = join(directory, "Ghidra/Processors/SM83/data/languages");
    await mkdir(languages, { recursive: true });
    await writeFile(
      join(languages, "sm83.ldefs"),
      '<language_definitions><language id="SM83:LE:16:default"><compiler id="default"/></language></language_definitions>',
    );
    await writeFile(join(directory, "Ghidra/Processors/.DS_Store"), "metadata");
    const resolved = await provider.resolveAnalysisProfile(target);
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.profile?.parameters).toMatchObject({
      target_format: "gameboy-rom",
      language_id: "SM83:LE:16:default",
      entry_point: "0x100",
      gameboy_import: "physical-banks-overlays-v1",
    });
    const originalDigest = resolved.value.profile?.digest;
    await writeFile(join(languages, "sm83.sla"), Buffer.from([1, 2, 3]));
    const updated = await provider.resolveAnalysisProfile(target);
    if (!updated.ok) throw updated.error;
    expect(updated.value.profile?.digest).not.toBe(originalDigest);
    await provider.closeOwnedResources();
  });
});

describe("Game Boy bank analysis", () => {
  it("accepts distinct overlay seeds and preserves duplicate detection", () => {
    expect(
      parseGhidraSeeds(
        "0x4000\tfunction\tbank1\nROM_002:0x4000\tfunction\tbank2\n",
      ).ok,
    ).toBe(true);
    expect(
      parseGhidraSeeds("ROM_002:0x4000\tfunction\nROM_002:0x04000\tfunction\n")
        .ok,
    ).toBe(false);
    expect(
      parseGhidraSeeds(
        "ROM_002:0x4000\tfunction\tfirst\n%52OM_002:0x4000\tfunction\tsecond\n",
      ).ok,
    ).toBe(false);
    expect(parseGhidraSeeds("ROM_002:0x10000000000000000\tcode\n").ok).toBe(
      false,
    );
  });
  it("detects a changed ROM bank digest and a flattened overlay", async () => {
    const { target, rom } = await targetFor();
    const bankHashes = gameBoyRomBanks(target.gameBoy).map((bank) =>
      hash(rom.subarray(bank.fileOffset, bank.fileOffset + bank.size)),
    );
    const measured: NativeLoadImageObservation = {
      executable_format: "Raw Binary",
      language_id: "SM83:LE:16:default",
      compiler_spec_id: "default",
      image_base: "0x0",
      default_address_space: "mem",
      source_files: [
        {
          name: "test.gb",
          size: rom.length,
          original_sha256: target.sha256,
          modified_sha256: target.sha256,
        },
      ],
      mappings: gameBoyRomBanks(target.gameBoy).map((bank) => ({
        block: bank.block,
        start: `${bank.overlay ? bank.block + ":" : ""}0x${bank.address.toString(16)}`,
        end: `${bank.overlay ? bank.block + ":" : ""}0x${(bank.address + bank.size - 1).toString(16)}`,
        address_space: bank.overlay ? bank.block : "mem",
        length: bank.size,
        initialized: true,
        loaded: true,
        overlay: bank.overlay,
        readable: true,
        writable: false,
        executable: true,
        source_file_index: 0,
        file_offset: bank.fileOffset,
        sha256: bankHashes[bank.bank] ?? null,
      })),
      relocations: [],
      entry_points: ["0x100"],
      entry_context: [],
    };
    const snapshot = {
      sha256: target.sha256,
      bytes: rom.length,
      rangeSha256: bankHashes,
    };
    const correct = attestGhidraGameBoyLoadImage(snapshot, target, measured);
    expect(correct.ok && correct.value.status).toBe("verified");
    measured.mappings[2]!.sha256 = "0".repeat(64);
    const changed = attestGhidraGameBoyLoadImage(snapshot, target, measured);
    expect(changed.ok && changed.value.status).toBe("mismatch");
    measured.mappings[2]!.sha256 = bankHashes[2]!;
    measured.mappings[2]!.overlay = false;
    const flattened = attestGhidraGameBoyLoadImage(snapshot, target, measured);
    expect(flattened.ok && flattened.value.status).toBe("mismatch");
  });
  it("imports only the initial window before the cartridge preparation script", () => {
    const args = ghidraHeadlessArguments({
      projectRoot: "/tmp/project",
      targetPath: "/tmp/test.gb",
      bridgeScriptPath: "/bridge/ReaGhidraBridge.java",
      descriptorPath: "/tmp/d",
      ghidraLogPath: "/tmp/g",
      scriptLogPath: "/tmp/s",
      gameBoy: { romBanks: 4 },
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "-loader-length",
        "0x4000",
        "SM83:LE:16:default",
        "/bridge/ReaGhidraPrepareGameBoy.java",
        "4",
        "-readOnly",
        "-deleteProject",
      ]),
    );
  });
});
