import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../config/parseConfig.js";
import type {
  BinaryTarget,
  RiscvElfMetadata,
} from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { hopperLoaderArgsForTarget } from "../hopper/HopperAnalysisProfile.js";
import { IdaProvider } from "../ida/IdaProvider.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { ghidraRiscvLimitations } from "./GhidraRiscvProfile.js";
import type { GhidraInstallationHost } from "./GhidraInstallation.js";
import {
  ghidraPinnedLanguage,
  ghidraProfileLanguageOverride,
  sameGhidraLanguageOverride,
} from "./GhidraAnalysisProfile.js";

// Abbreviated from Ghidra 12.1.4 Processors/RISCV/data/languages/riscv.ldefs.
// The release tree ships no big-endian or ELF-class-mismatched RISC-V language.
const RISCV_LDEFS = `<?xml version="1.0" encoding="UTF-8"?>
<language_definitions>
  <language processor="RISCV"
            endian="little"
            size="64"
            variant="default"
            version="1.4"
            slafile="riscv.lp64d.sla"
            processorspec="RV64.pspec"
            id="RISCV:LE:64:default">
    <description>RISC-V 64 little default</description>
    <compiler name="gcc" spec="riscv64-fp.cspec" id="gcc"/>
  </language>
  <language processor="RISCV"
            endian="little"
            size="32"
            variant="default"
            version="1.4"
            slafile="riscv.ilp32d.sla"
            processorspec="RV32.pspec"
            id="RISCV:LE:32:default">
    <description>RISC-V 32 little default</description>
    <compiler name="gcc" spec="riscv32-fp.cspec" id="gcc"/>
  </language>
</language_definitions>
`;

// Fake installation inspection tests admission/profile contracts, not Ghidra.
const host: GhidraInstallationHost = {
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.4\napplication.java.min=21\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.11",
    major: 21,
    home: "/jdk-21",
    bits: 64,
    runtime: "jdk",
  }),
};
const configOf = (
  installDir: string,
  environment: Record<string, string> = {},
) => {
  const parsed = parseConfig({
    GHIDRA_INSTALL_DIR: installDir,
    ...environment,
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const target = (change: Partial<RiscvElfMetadata> = {}): BinaryTarget => ({
  path: "/fixture.elf",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "riscv",
  availableArchitectures: ["riscv"],
  riscv: {
    elfClass: 64,
    byteOrder: "little",
    type: 2,
    flags: 0x5,
    ...change,
  },
});

let installDir = "";
beforeAll(async () => {
  const root =
    process.platform === "win32" ? join(process.cwd(), "build") : tmpdir();
  await mkdir(root, { recursive: true });
  installDir = await mkdtemp(join(root, "rea-ghidra-riscv-languages-"));
  // The simulated Linux host needs a POSIX absolute path. A current-drive root
  // path also reaches this real fixture on Windows without changing admission.
  if (process.platform === "win32")
    installDir = `/${relative(parse(installDir).root, installDir).replaceAll("\\", "/")}`;
  const languages = join(installDir, "Ghidra/Processors/RISCV/data/languages");
  await mkdir(languages, { recursive: true });
  await writeFile(join(languages, "riscv.ldefs"), RISCV_LDEFS);
});
afterAll(async () => {
  await rm(installDir, { recursive: true, force: true });
});

const ghidra = (environment: Record<string, string> = {}) =>
  new GhidraProvider(configOf(installDir, environment), silentLogger, {}, host);

describe("bounded Ghidra RISC-V admission", () => {
  it("pins the generic language per width instead of accepting the header guess", async () => {
    const provider = ghidra();
    const rv64 = target();
    const rv32 = target({ elfClass: 32, flags: 0x4 });
    expect(provider.inspectTargetSupport(rv64).status).toBe("supported");
    expect(provider.inspectTargetSupport(rv32).status).toBe("supported");
    expect(ghidraPinnedLanguage(rv64)).toEqual({
      languageId: "RISCV:LE:64:default",
      compilerSpecId: "gcc",
    });
    expect(ghidraPinnedLanguage(rv32)).toEqual({
      languageId: "RISCV:LE:32:default",
      compilerSpecId: "gcc",
    });
    const wide = await provider.resolveAnalysisProfile(rv64);
    const narrow = await provider.resolveAnalysisProfile(rv32);
    if (!wide.ok || !narrow.ok)
      throw new Error("expected admitted RISC-V profiles");
    expect(wide.value.profile?.parameters.riscv_elf).toEqual({
      elf_class: 64,
      byte_order: "little",
      type: 2,
      flags: 5,
      float_abi_double: true,
      rvc_declared: true,
      rve_declared: false,
      tso_declared: false,
    });
    expect(wide.value.profile?.parameters.riscv_support_lane).toBe(
      "elf64-exec-le-double-float-generic-v1",
    );
    expect(narrow.value.profile?.parameters.riscv_support_lane).toBe(
      "elf32-exec-le-double-float-generic-v1",
    );
    expect(narrow.value.profile?.parameters.riscv_elf).toMatchObject({
      elf_class: 32,
      rvc_declared: false,
    });
    expect(wide.value.profile?.digest).not.toBe(narrow.value.profile?.digest);
  });

  it("commits the pinned language the session readback expects", async () => {
    // A pinned lane has one owner: the committed profile and the open_binary
    // readback must agree without either re-deriving a different family's pin.
    const provider = ghidra();
    for (const value of [target(), target({ elfClass: 32 })]) {
      const resolved = await provider.resolveAnalysisProfile(value);
      if (!resolved.ok || resolved.value.profile === null)
        throw new Error("expected a RISC-V profile");
      expect(
        sameGhidraLanguageOverride(
          ghidraProfileLanguageOverride(resolved.value.profile.parameters),
          ghidraPinnedLanguage(value),
        ),
      ).toBe(true);
    }
  });

  it.each([
    [{ byteOrder: "big" }, "little-endian"],
    [{ type: 3 }, "fixed-address ET_EXEC only"],
    [{ type: 1 }, "fixed-address ET_EXEC only"],
    [{ type: 0xffa0 }, "e_type 65440"],
    [{ flags: 0xc }, "EF_RISCV_RVE"],
    [{ flags: 0x14 }, "EF_RISCV_TSO"],
    [{ flags: 0x1 }, "soft-float convention"],
    [{ flags: 0x3 }, "single-float"],
    [{ flags: 0x7 }, "quad-float"],
    [{ flags: 0x8000_0005 }, "(0x80000000)"],
    [{ flags: 0x24 }, "bits outside the verified lane"],
  ] satisfies [Partial<RiscvElfMetadata>, string][])(
    "refuses an unverified RISC-V interpretation %j",
    async (change, reason) => {
      const provider = ghidra();
      const value = target(change);
      expect(provider.inspectTargetSupport(value)).toMatchObject({
        status: "unsupported",
        code: "architecture_unsupported",
        reason: expect.stringContaining(reason),
      });
      expect(await provider.resolveAnalysisProfile(value)).toEqual(
        expect.objectContaining({ ok: false }),
      );
      expect(ghidraPinnedLanguage(value)).toBeUndefined();
    },
  );

  it("refuses a caller-selected processor outside the verified generic lane", async () => {
    const resolved = await ghidra({
      REA_GHIDRA_LANGUAGE_ID: "RISCV:LE:32:AndeStar_v5",
    }).resolveAnalysisProfile(target({ elfClass: 32 }));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("expected a refusal");
    expect(resolved.error.message).toContain("generic little-endian RISC-V");
  });

  it("keeps a caller-selected language that matches the pin as configured", async () => {
    const resolved = await ghidra({
      REA_GHIDRA_LANGUAGE_ID: "RISCV:LE:64:default",
      REA_GHIDRA_COMPILER_SPEC_ID: "gcc",
    }).resolveAnalysisProfile(target());
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected a configured profile");
    expect(resolved.value.profile.parameters.language_selection).toBe(
      "configured-v1",
    );
    expect(resolved.value.profile.parameters.language_id).toBe(
      "RISCV:LE:64:default",
    );
  });

  it("states the linkage claim boundary in the lane limitations", () => {
    const notes = ghidraRiscvLimitations(target());
    expect(notes).toHaveLength(3);
    expect(notes.join(" ")).toContain("does not establish static linkage");
    expect(notes[0]).toContain("RISCV:LE:64:default");
    expect(
      ghidraRiscvLimitations({
        path: "/other.elf",
        sha256: "b".repeat(64),
        kind: "executable",
        format: "elf",
        architecture: "x86_64",
        availableArchitectures: ["x86_64"],
      }),
    ).toEqual([]);
  });

  it("keeps RISC-V out of unverified Hopper and IDA adapter lanes", () => {
    const hopper = new HopperProvider(
      configOf("/hopper"),
      silentLogger,
      {},
      "linux",
    );
    expect(hopper.inspectTargetSupport(target()).status).toBe("unsupported");
    expect(hopperLoaderArgsForTarget(target()).ok).toBe(false);
    expect(hopperLoaderArgsForTarget(target())).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("RISC-V"),
        }),
      }),
    );
    const ida = new IdaProvider(configOf("/ida"), {});
    expect(ida.inspectTargetSupport(target()).status).toBe("unsupported");
  });
});
