import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { parseConfig } from "../config/parseConfig.js";
import type {
  BinaryTarget,
  RiscvElfMetadata,
} from "../domain/binaryTargetTypes.js";
import { ok } from "../domain/result.js";
import { riscvIsaDeclaration } from "../domain/riscvIsaDeclaration.js";
import { silentLogger } from "../logger.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { hopperLoaderArgsForTarget } from "../hopper/HopperAnalysisProfile.js";
import { IdaProvider } from "../ida/IdaProvider.js";
import { parseBinaryTarget } from "../application/BinaryTargetResolver.js";
import { GhidraProvider } from "./GhidraProvider.js";
import type { GhidraProviderClientFactory } from "./GhidraProviderClient.js";
import {
  ghidraRiscvCallingConvention,
  ghidraRiscvLimitations,
  ghidraRiscvLoadPreparation,
  ghidraRiscvLoadPreparationFailure,
  ghidraRiscvLoadPreparationLimitations,
  ghidraRiscvUnsupportedReason,
  type GhidraRiscvCallingConventionReport,
  type GhidraRiscvLoadPreparationReport,
} from "./GhidraRiscvProfile.js";
import { ghidraProjectHistoryEvidence } from "./GhidraProjectHistory.js";
import { stating } from "../../tests/support/statingFacts.js";
import {
  GHIDRA_SESSION_CAPABILITIES,
  type GhidraSessionInfo,
} from "./GhidraSessionValues.js";
import {
  createSimulatedInstallDirectory,
  ghidraProfileInstallationHost as host,
} from "./GhidraInstallation.fixture.js";
import { ghidraPinnedLanguage } from "./GhidraAnalysisProfile.js";

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
    sectionOverlap: { status: "none" },
    ...change,
  },
});
// ESP-IDF's ESP32-C3 base string, as LLVM records it for the lane's fixture.
const C3_ARCH = "rv32i2p1_m2p0_c2p0_zicsr2p0_zifencei2p0_zmmul1p0";
const ilp32 = (
  arch: string = C3_ARCH,
  change: Partial<RiscvElfMetadata> = {},
): BinaryTarget =>
  target({
    elfClass: 32,
    flags: 0x1,
    isa: riscvIsaDeclaration(arch),
    ...change,
  });

let installDir = "";
let disposeInstallDir: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const directory = await createSimulatedInstallDirectory(
    "rea-ghidra-riscv-languages-",
  );
  installDir = directory.path;
  disposeInstallDir = directory.dispose;
  const languages = join(installDir, "Ghidra/Processors/RISCV/data/languages");
  await mkdir(languages, { recursive: true });
  await writeFile(join(languages, "riscv.ldefs"), RISCV_LDEFS);
});
afterAll(async () => {
  await disposeInstallDir?.();
});

const ghidra = (environment: Record<string, string> = {}) =>
  new GhidraProvider(configOf(installDir, environment), silentLogger, {}, host);

const registerRiscvLanguageCommitmentCases = () => {
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
    expect(wide.value.profile?.digest).toEqual(expect.any(String));
    expect(narrow.value.profile?.digest).toEqual(expect.any(String));
    expect(wide.value.profile?.digest).not.toBe(narrow.value.profile?.digest);
  });

  it("names the pinned RISC-V language when the session readback refuses", async () => {
    const value = target();
    const resolved = await ghidra().resolveAnalysisProfile(value);
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected a RISC-V profile");
    const profile = resolved.value.profile;
    const overridden = await ghidra({
      REA_GHIDRA_LANGUAGE_ID: "RISCV:LE:64:default",
    })
      .createClient(value, profile)
      .execute("health", {});
    const foreign = await ghidra()
      .createClient(
        {
          path: "/fixture.elf",
          sha256: "a".repeat(64),
          kind: "executable",
          format: "elf",
          architecture: "x86_64",
          availableArchitectures: ["x86_64"],
        },
        profile,
      )
      .execute("health", {});
    if (overridden.ok || foreign.ok)
      throw new Error("expected readback refusals");
    for (const failed of [overridden, foreign]) {
      expect(failed.error._tag).toBe("ProviderAdapterError");
      expect(failed.error.diagnostics?.reason).toEqual(
        expect.stringContaining("RISCV:LE:64:default"),
      );
    }
    expect(overridden.error.diagnostics?.reason).toEqual(
      expect.stringContaining("REA_GHIDRA_LANGUAGE_ID"),
    );
  });
};

const registerRiscvPieAdmissionCases = () => {
  it("admits little-endian position-independent executables (ET_DYN with PT_INTERP)", async () => {
    const provider = ghidra();
    const pie64 = target({ type: 3, hasInterpreter: true });
    const pie32 = target({
      elfClass: 32,
      flags: 0x4,
      type: 3,
      hasInterpreter: true,
    });
    expect(provider.inspectTargetSupport(pie64).status).toBe("supported");
    expect(provider.inspectTargetSupport(pie32).status).toBe("supported");
    expect(ghidraPinnedLanguage(pie64)).toEqual({
      languageId: "RISCV:LE:64:default",
      compilerSpecId: "gcc",
    });
    expect(ghidraPinnedLanguage(pie32)).toEqual({
      languageId: "RISCV:LE:32:default",
      compilerSpecId: "gcc",
    });
    const wide = await provider.resolveAnalysisProfile(pie64);
    const narrow = await provider.resolveAnalysisProfile(pie32);
    if (!wide.ok) throw wide.error;
    if (!narrow.ok) throw narrow.error;
    expect(wide.value.profile?.parameters.riscv_elf).toEqual({
      elf_class: 64,
      byte_order: "little",
      type: 3,
      flags: 5,
      float_abi_double: true,
      rvc_declared: true,
      rve_declared: false,
      tso_declared: false,
      has_interpreter: true,
      load_model: "pie",
      expected_default_image_base: "0x100000",
    });
    expect(wide.value.profile?.parameters.riscv_support_lane).toBe(
      "elf64-pie-le-double-float-generic-v1",
    );
    expect(narrow.value.profile?.parameters.riscv_support_lane).toBe(
      "elf32-pie-le-double-float-generic-v1",
    );
    expect(narrow.value.profile?.parameters.riscv_elf).toEqual({
      elf_class: 32,
      byte_order: "little",
      type: 3,
      flags: 4,
      float_abi_double: true,
      rvc_declared: false,
      rve_declared: false,
      tso_declared: false,
      has_interpreter: true,
      load_model: "pie",
      expected_default_image_base: "0x10000",
    });
  });

  it("refuses soft-float position-independent executables (PIE)", () => {
    const pieSoft = ilp32(C3_ARCH, { type: 3, hasInterpreter: true });
    const support = ghidra().inspectTargetSupport(pieSoft);
    expect(support).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
      reason:
        "This Ghidra RISC-V soft-float lane supports fixed-address ET_EXEC only; position-independent executables (PIE) need separate load verification.",
    });
    expect(ghidraRiscvCallingConvention(pieSoft)).toBeUndefined();
    expect(ghidraPinnedLanguage(pieSoft)).toBeUndefined();
  });

  it("admits a valid RISC-V PIE whose program headers start beyond 4096 and end past 65536", async () => {
    const testFile = join(installDir, "pie-high-phoff.elf");
    const fileSize = 75000;
    const phoff = 70000;
    const phentsize = 56;
    const phnum = 2;
    const buffer = Buffer.alloc(fileSize);
    buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); // ELF64, little-endian, version 1
    buffer.writeUInt16LE(3, 16); // ET_DYN
    buffer.writeUInt16LE(243, 18); // EM_RISCV
    buffer.writeUInt32LE(1, 20); // EV_CURRENT
    buffer.writeBigUInt64LE(BigInt(phoff), 32); // e_phoff
    buffer.writeUInt32LE(0x5, 48); // e_flags: double-float ABI | RVC
    buffer.writeUInt16LE(64, 52); // e_ehsize
    buffer.writeUInt16LE(phentsize, 54); // e_phentsize
    buffer.writeUInt16LE(phnum, 56); // e_phnum

    // Program headers at phoff:
    // Entry 0: PT_LOAD (1)
    buffer.writeUInt32LE(1, phoff);
    // Entry 1: PT_INTERP (3), with an in-file pathname range.
    const interpreter = Buffer.from("/lib/ld-linux-riscv64-lp64d.so.1\0");
    const interpHeader = phoff + phentsize;
    const interpOffset = phoff + phnum * phentsize;
    buffer.writeUInt32LE(3, interpHeader);
    buffer.writeBigUInt64LE(BigInt(interpOffset), interpHeader + 8);
    buffer.writeBigUInt64LE(BigInt(interpreter.length), interpHeader + 32);
    buffer.writeBigUInt64LE(BigInt(interpreter.length), interpHeader + 40);
    interpreter.copy(buffer, interpOffset);

    await writeFile(testFile, buffer);
    const resolved = await parseBinaryTarget(testFile);
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.kind).toBe("executable");
    expect(resolved.value.architecture).toBe("riscv");
    if (resolved.value.architecture === "riscv") {
      expect(resolved.value.riscv.hasInterpreter).toBe(true);
    }
    const support = ghidra().inspectTargetSupport(resolved.value);
    expect(support.status).toBe("supported");
  });
};

const registerRiscvAdmissionAndCapabilityCases = () => {
  it.each([
    [{ byteOrder: "big" }, "little-endian"],
    [{ type: 3 }, "shared libraries without PT_INTERP"],
    [{ type: 3, hasInterpreter: false }, "shared libraries without PT_INTERP"],
    [{ type: 1 }, "relocatable"],
    [{ type: 0xffa0 }, "e_type 65440"],
    [
      { elfClass: 32, flags: 0x1, type: 3, hasInterpreter: true },
      "soft-float lane supports fixed-address ET_EXEC only",
    ],
    [{ flags: 0xc }, "EF_RISCV_RVE"],
    [{ flags: 0x14 }, "EF_RISCV_TSO"],
    [{ flags: 0x1 }, "soft-float ABI (lp64) declared by e_flags"],
    [{ flags: 0x3 }, "single-float ABI (lp64f)"],
    [{ flags: 0x7 }, "quad-float ABI (lp64q)"],
    [{ elfClass: 32, flags: 0x3 }, "single-float ABI (ilp32f)"],
    [{ elfClass: 32, flags: 0x7 }, "the quad-float ABI declared by e_flags"],
    [{ elfClass: 32, flags: 0x1 }, "which was not inspected"],
    [{ elfClass: 32, flags: 0x1, isa: { status: "absent" } }, "declares none"],
    [
      {
        elfClass: 32,
        flags: 0x1,
        isa: {
          status: "unavailable",
          reason: "truncated RISC-V attribute section",
        },
      },
      "readable Tag_RISCV_arch declaration: truncated RISC-V attribute section",
    ],
    [{ flags: 0x8000_0005 }, "(0x80000000)"],
    [{ flags: 0x24 }, "bits outside the verified lane"],
  ] satisfies [Partial<RiscvElfMetadata>, string][])(
    "refuses an unverified RISC-V interpretation %j",
    async (change, reason) => {
      const provider = ghidra();
      const value = target(change);
      // The provider delivers the lane's own refusal, which names the
      // offending declaration or value.
      expect(provider.inspectTargetSupport(value)).toMatchObject({
        status: "unsupported",
        code: "architecture_unsupported",
        reason: ghidraRiscvUnsupportedReason(value),
      });
      expect(ghidraRiscvUnsupportedReason(value)).toContain(reason);
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
    if (resolved.ok) throw new Error("expected a refusal");
    expect(resolved.error.message).toContain("generic little-endian RISC-V");
    expect(resolved.error).toMatchObject({
      _tag: "ConfigurationError",
      settings: [{ setting: "REA_GHIDRA_LANGUAGE_ID" }],
    });
  });

  it("attributes a compiler-only pin conflict to its setting", async () => {
    const resolved = await ghidra({
      REA_GHIDRA_LANGUAGE_ID: "RISCV:LE:64:default",
      REA_GHIDRA_COMPILER_SPEC_ID: "windows",
    }).resolveAnalysisProfile(target());
    if (resolved.ok) throw new Error("expected a configuration conflict");
    expect(resolved.error).toMatchObject({
      _tag: "ConfigurationError",
      settings: [{ setting: "REA_GHIDRA_COMPILER_SPEC_ID" }],
    });
  });

  it("keeps a caller-selected language that matches the pin as configured", async () => {
    const resolved = await ghidra({
      REA_GHIDRA_LANGUAGE_ID: "RISCV:LE:64:default",
      REA_GHIDRA_COMPILER_SPEC_ID: "gcc",
    }).resolveAnalysisProfile(target());
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected a configured profile");
    expect(resolved.value.profile.parameters.language_selection).toBe(
      "configured",
    );
    expect(resolved.value.profile.parameters.language_id).toBe(
      "RISCV:LE:64:default",
    );
  });

  it("states the linkage claim boundary in the lane limitations", () => {
    const notes = ghidraRiscvLimitations(target());
    // Facts, independent of the owner's wording and order: the pinned
    // language and the static-linkage boundary.
    expect(notes).toContainEqual(
      expect.stringContaining("RISCV:LE:64:default"),
    );
    expect(notes).toContainEqual(
      expect.stringContaining("does not establish static linkage"),
    );

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
          message: expect.stringContaining("riscv"),
        }),
      }),
    );
    const ida = new IdaProvider(configOf("/ida"), {});
    expect(ida.inspectTargetSupport(target()).status).toBe("unsupported");
  });
};

describe("bounded Ghidra RISC-V admission", () => {
  registerRiscvLanguageCommitmentCases();
  registerRiscvPieAdmissionCases();
  registerRiscvAdmissionAndCapabilityCases();
});

describe("RISC-V ilp32 admission", () => {
  it.each([
    ["ESP32-C2/C3 base", C3_ARCH],
    [
      "ESP32-C5/C6/C61/H2/H21 base",
      "rv32i2p1_m2p0_a2p1_c2p0_zicsr2p0_zifencei2p0_zaamo1p0_zalrsc1p0_zmmul1p0_zca1p0",
    ],
    [
      "soft-float ABI on F and D hardware",
      "rv32i2p1_m2p0_a2p1_f2p2_d2p2_c2p0_zicsr2p0_zmmul1p0_zca1p0_zcf1p0_zcd1p0",
    ],
    ["the bare base", "rv32i2p1"],
  ])("admits the %s", async (_label, arch) => {
    const value = ilp32(arch);
    expect(ghidra().inspectTargetSupport(value).status).toBe("supported");
    expect(ghidraPinnedLanguage(value)).toEqual({
      languageId: "RISCV:LE:32:default",
      compilerSpecId: "gcc",
    });
    expect(ghidraRiscvCallingConvention(value)).toBe("ilp32-prototype-v1");
  });

  it.each([
    [
      "ESP-IDF's optional bit-manipulation and Zc extensions",
      `${C3_ARCH}_zba1p0_zbb1p0_zbs1p0_zcb1p0_zcmp1p0_zcmt1p0`,
      "outside the set this lane decodes: zba, zbb, zbs, zcb, zcmp, zcmt.",
    ],
    [
      "Espressif's vendor extensions",
      "rv32i2p1_m2p0_c2p0_xesploop1p0_xespv2p1_xespdsp1p0",
      "outside the set this lane decodes: xesploop, xespv, xespdsp.",
    ],
    ["an RV32E base", "rv32e2p0_m2p0_c2p0", "requires the RV32I base"],
    ["an RV64 string", "rv64i2p1_m2p0_c2p0", "requires the RV32I base"],
    [
      "a non-canonical string",
      "rv32imac",
      "readable Tag_RISCV_arch declaration: Tag_RISCV_arch does not begin",
    ],
  ])("refuses %s", async (_label, arch, reason) => {
    const value = ilp32(arch);
    expect(ghidra().inspectTargetSupport(value)).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
      reason: expect.stringContaining(reason),
    });
    expect((await ghidra().resolveAnalysisProfile(value)).ok).toBe(false);
    expect(ghidraPinnedLanguage(value)).toBeUndefined();
    expect(ghidraRiscvCallingConvention(value)).toBeUndefined();
  });

  it("commits the soft-float lane, its declarations and its policy", async () => {
    const resolved = await ghidra().resolveAnalysisProfile(ilp32());
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected an ilp32 profile");
    const parameters = resolved.value.profile.parameters;
    expect(parameters.riscv_elf).toEqual({
      elf_class: 32,
      byte_order: "little",
      type: 2,
      flags: 1,
      float_abi_double: false,
      float_abi: "soft",
      arch: C3_ARCH,
      rvc_declared: true,
      rve_declared: false,
      tso_declared: false,
    });
    expect(parameters.riscv_calling_convention).toBe("ilp32-prototype-v1");
    expect(parameters.riscv_support_lane).toBe(
      "elf32-exec-le-soft-float-generic-v1",
    );
    expect(parameters.language_id).toBe("RISCV:LE:32:default");
    expect(parameters.language_selection).toBe("provider-pinned");
    const other = await ghidra().resolveAnalysisProfile(
      ilp32(`${C3_ARCH.replace("_zmmul1p0", "")}_zaamo1p0`),
    );
    if (!other.ok || other.value.profile === null)
      throw new Error("expected an ilp32 profile");
    expect(other.value.profile.digest).not.toBe(resolved.value.profile.digest);
  });

  it("keeps double-float profiles exactly as before, whatever the ISA declaration", async () => {
    const plain = await ghidra().resolveAnalysisProfile(
      target({ elfClass: 32, flags: 0x5 }),
    );
    const declared = await ghidra().resolveAnalysisProfile(
      target({
        elfClass: 32,
        flags: 0x5,
        isa: riscvIsaDeclaration("rv32i2p1_m2p0_a2p1_f2p2_d2p2_c2p0_zcmp1p0"),
      }),
    );
    if (
      !plain.ok ||
      !declared.ok ||
      plain.value.profile === null ||
      declared.value.profile === null
    )
      throw new Error("expected double-float profiles");
    expect(plain.value.profile.parameters.riscv_elf).toEqual({
      elf_class: 32,
      byte_order: "little",
      type: 2,
      flags: 5,
      float_abi_double: true,
      rvc_declared: true,
      rve_declared: false,
      tso_declared: false,
    });
    expect(plain.value.profile.parameters).not.toHaveProperty(
      "riscv_calling_convention",
    );
    expect(declared.value.profile.digest).toBe(plain.value.profile.digest);
  });

  it("states the declared ABI, the applied prototype and the declared ISA", () => {
    const notes = ghidraRiscvLimitations(ilp32());
    // One note names the declared ABI, the ABI the pinned language models
    // and the prototype REA applies, in any wording and order.
    expect(notes).toContainEqual(
      expect.stringMatching(
        /^(?=.*\(ilp32\))(?=.*\bilp32d\b)(?=.*`__rea_ilp32`)/su,
      ),
    );
    expect(notes).toContainEqual(expect.stringContaining(C3_ARCH));
  });
});

const report: GhidraRiscvCallingConventionReport = {
  policy: "ilp32-prototype-v1",
  functions: 11,
  definitions: 11,
};
const sessionInfo = (
  value: BinaryTarget,
  reported?: GhidraRiscvCallingConventionReport,
  prepared?: GhidraRiscvLoadPreparationReport,
) => ({
  name: "REA Ghidra bridge" as const,
  run_id: "11111111-1111-4111-8111-111111111111",
  profile_digest: "a".repeat(64),
  provider: { id: "ghidra" as const, version: "12.1.4" },
  read_only: false,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
  target: {
    name: "fixture.elf",
    language_id: `RISCV:LE:${value.architecture === "riscv" ? value.riscv.elfClass : 32}:default`,
    compiler_spec_id: "gcc",
    image_base: "0x0",
    default_address_space: "ram",
    sha256: "a".repeat(64),
  },
  ...(reported === undefined ? {} : { riscv_calling_convention: reported }),
  ...(prepared === undefined ? {} : { elf_load_preparation: prepared }),
});
const session = async (
  value: BinaryTarget,
  reported: GhidraRiscvCallingConventionReport | undefined,
  profileFor: BinaryTarget = value,
  prepared?: GhidraRiscvLoadPreparationReport,
) => {
  const counts = { starts: 0, calls: 0, closes: 0 };
  const launches: Parameters<GhidraProviderClientFactory>[0][] = [];
  const provider = new GhidraProvider(
    configOf(installDir),
    silentLogger,
    {},
    host,
    (options) => {
      launches.push(options);
      return {
        start: () => {
          counts.starts++;
          return Promise.resolve(ok(sessionInfo(value, reported, prepared)));
        },
        callTool: () => {
          counts.calls++;
          return Promise.resolve(ok(null));
        },
        close: () => {
          counts.closes++;
          return Promise.resolve(ok(null));
        },
      };
    },
  );
  const resolved = await provider.resolveAnalysisProfile(profileFor);
  if (!resolved.ok || resolved.value.profile === null)
    throw new Error("expected a RISC-V profile");
  const client = provider.createClient(value, resolved.value.profile);
  onTestFinished(async () => {
    try {
      await client.close();
    } finally {
      await provider.closeOwnedResources();
    }
  });
  return { counts, launches, client };
};

describe("RISC-V calling-convention handshake", () => {
  it("launches the policy and reports its outcome as session limitations", async () => {
    const { client, launches } = await session(ilp32(), report);
    const health = await client.execute("health", {});
    if (!health.ok) throw health.error;
    expect(launches).toHaveLength(1);
    expect(launches[0]?.launcher).toMatchObject({
      options: { riscvCallingConvention: "ilp32-prototype-v1" },
    });
    expect(health.value.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "installs a program-specific `__rea_ilp32` prototype",
        ),
        expect.stringContaining(
          "11 functions and 11 function definitions use __rea_ilp32.",
        ),
        expect.stringContaining("variadic call's arguments"),
      ]),
    );
  });

  it.each([
    { value: target(), languageId: "RISCV:LE:64:default" },
    { value: target({ elfClass: 32 }), languageId: "RISCV:LE:32:default" },
  ])(
    "pins $languageId at both launch and handshake without a policy",
    async ({ value, languageId }) => {
      const { client, launches } = await session(value, undefined);
      const health = await client.execute("health", {});
      if (!health.ok) throw health.error;
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({
        expectedLanguageId: languageId,
        expectedCompilerSpecId: "gcc",
        launcher: {
          options: { languageOverride: { languageId, compilerSpecId: "gcc" } },
        },
      });
      expect(launches[0]?.launcher).not.toHaveProperty(
        "options.riscvCallingConvention",
      );
    },
  );

  it.each([
    {
      reason: "an ilp32 session without a report before any analysis call",
      value: ilp32(),
      reported: undefined,
      operation: "list_procedures",
    },
    {
      reason: "a report from a double-float session",
      value: target(),
      reported: report,
      operation: "list_procedures",
    },
  ] as const)("rejects $reason", async ({ value, reported, operation }) => {
    const { counts, client } = await session(value, reported);
    const failed = await client.execute(operation, {});
    expect(failed).toMatchObject({
      ok: false,
      error: {
        _tag: "ProviderAdapterError",
        operation,
        diagnostics: { reason: expect.any(String) },
      },
    });
    expect(counts).toEqual({ starts: 1, calls: 0, closes: 1 });
  });

  it("refuses a profile whose policy disagrees with the target", async () => {
    for (const [value, profileFor] of [
      [ilp32(), target({ elfClass: 32 })],
      [target({ elfClass: 32 }), ilp32()],
    ] as const) {
      const { counts, client } = await session(value, report, profileFor);
      expect((await client.execute("health", {})).ok).toBe(false);
      expect(counts.starts).toBe(0);
    }
  });
});

// ESP-IDF v6.1 ESP32-C6 hello_world's sections, as the ELF reader records them.
const C6_ARCH =
  "rv32i2p1_m2p0_a2p1_c2p0_zicsr2p0_zifencei2p0_zmmul1p0_zaamo1p0_zalrsc1p0_zca1p0";
const espOverlap = {
  status: "code-reservation",
  code: {
    index: 15,
    name: ".flash.text",
    address: "0x42000020",
    size: "0xfff2",
    offset: "0xc020",
  },
  reservation: {
    index: 16,
    name: ".flash_rodata_dummy",
    address: "0x42000020",
    size: "0x18000",
  },
} as const;
/** The same target before its section table is inspected. */
const uninspected = (value: BinaryTarget): BinaryTarget => {
  if (value.kind !== "executable" || value.architecture !== "riscv")
    return value;
  const { sectionOverlap: _uninspected, ...riscv } = value.riscv;
  return { ...value, riscv };
};
const esp = (change: Partial<RiscvElfMetadata> = {}): BinaryTarget =>
  ilp32(C6_ARCH, { sectionOverlap: espOverlap, ...change });
const movedCode = {
  name: ".flash.text",
  address: "0x42000020",
  size: "0xfff2",
  file_offset: "0xc020",
  space_before: ".flash.text",
  space_after: "ram",
} as const;
const moved: GhidraRiscvLoadPreparationReport = {
  policy: "nobits-reservation-overlay-v1",
  outcome: "moved",
  code: movedCode,
  reservation: {
    name: ".flash_rodata_dummy",
    address: "0x42000020",
    size: "0x18000",
    space_before: "ram",
    space_after: ".flash_rodata_dummy",
  },
  functions: 549,
  entry_points: 331,
  reservation_labels: 1,
};
const canonical: GhidraRiscvLoadPreparationReport = {
  policy: "nobits-reservation-overlay-v1",
  outcome: "canonical",
  code: { ...movedCode, space_before: "ram" },
};

describe("RISC-V load preparation admission", () => {
  it("commits no load preparation for an image without an overlap", async () => {
    for (const value of [
      ilp32(),
      target(),
      target({ type: 3, hasInterpreter: true }),
    ]) {
      const resolved = await ghidra().resolveAnalysisProfile(value);
      if (!resolved.ok || resolved.value.profile === null)
        throw new Error("expected a RISC-V profile");
      expect(resolved.value.profile.parameters).not.toHaveProperty(
        "elf_load_preparation",
      );
      expect(ghidraRiscvLoadPreparation(value)).toBeUndefined();
    }
  });

  it("refuses a PIE whose sections need the reservation preparation", () => {
    const pie = esp({ type: 3, hasInterpreter: true });
    expect(ghidraRiscvLoadPreparation(pie)).toBeUndefined();
    expect(ghidraRiscvUnsupportedReason(pie)).toContain(
      "fixed-address ET_EXEC images only",
    );
    expect(
      ghidraRiscvUnsupportedReason(
        uninspected(target({ type: 3, hasInterpreter: true })),
      ),
    ).toContain("section table, which was not inspected");
  });

  it("commits ESP-IDF's code reservation to the profile", async () => {
    const resolved = await ghidra().resolveAnalysisProfile(esp());
    const plain = await ghidra().resolveAnalysisProfile(
      esp({ sectionOverlap: { status: "none" } }),
    );
    if (
      !resolved.ok ||
      !plain.ok ||
      resolved.value.profile === null ||
      plain.value.profile === null
    )
      throw new Error("expected ilp32 profiles");
    expect(resolved.value.profile.parameters.elf_load_preparation).toEqual({
      policy: "nobits-reservation-overlay-v1",
      code: espOverlap.code,
      reservation: espOverlap.reservation,
    });
    expect(resolved.value.profile.digest).not.toBe(plain.value.profile.digest);
  });

  const unreadable = {
    status: "unavailable",
    reason: "truncated ELF section header table",
  } as const;
  const overlapping = {
    status: "unsupported",
    witnesses: [
      {
        index: 1,
        name: ".text",
        address: "0x1000",
        size: "0x100",
        nobits: false,
        executable: true,
      },
      {
        index: 2,
        name: null,
        address: "0x1080",
        size: "0x100",
        nobits: true,
        executable: false,
      },
    ],
  } as const;
  it.each([
    [
      "not inspected",
      [uninspected(target()), uninspected(ilp32())],
      ["section table", "not inspected"],
    ],
    [
      "unreadable",
      [
        target({ sectionOverlap: unreadable }),
        ilp32(C3_ARCH, { sectionOverlap: unreadable }),
      ],
      ["section table", "truncated ELF section header table"],
    ],
    [
      "an unsupported overlap",
      [
        target({ sectionOverlap: overlapping }),
        ilp32(C3_ARCH, { sectionOverlap: overlapping }),
      ],
      [
        "`.text`",
        "section [2]",
        "0x1000",
        "0x1080",
        "0x100",
        "NOBITS",
        "docs/providers/ghidra-riscv.md",
      ],
    ],
  ] as const)(
    "refuses a section table that is %s in every lane",
    (_label, values, facts) => {
      for (const value of values) {
        expect(ghidraRiscvUnsupportedReason(value)).toEqual(stating(...facts));
        expect(ghidraRiscvLoadPreparation(value)).toBeUndefined();
      }
    },
  );

  it("names the lane's ISA refusal before the section table", () => {
    expect(
      ghidraRiscvUnsupportedReason(uninspected(ilp32(`${C3_ARCH}_zcb1p0`))),
    ).toContain("outside the set this lane decodes: zcb");
  });
});

describe("RISC-V load preparation report check", () => {
  it.each([
    ["the committed outcome", true, moved, undefined],
    ["a canonical outcome", true, canonical, undefined],
    ["no preparation", false, undefined, undefined],
    [
      "a block other than the committed code",
      true,
      { ...moved, code: { ...movedCode, size: "0xfff0" } },
      ["`.flash.text`", "size", "0xfff0", "0xfff2"],
    ],
    [
      "a code block at another file offset",
      true,
      { ...canonical, code: { ...movedCode, file_offset: "0xc021" } },
      ["file offset", "0xc021", "0xc020"],
    ],
    [
      "a reservation other than the committed one",
      true,
      {
        ...moved,
        reservation: { ...moved.reservation, size: "0x10000" },
      },
      ["`.flash_rodata_dummy`", "size", "0x10000", "0x18000"],
    ],
    [
      "blocks that Ghidra names differently",
      true,
      {
        ...moved,
        code: { ...movedCode, name: "section.15" },
        reservation: { ...moved.reservation, name: "section.16" },
      },
      undefined,
    ],
    [
      "moved code left outside the default space",
      true,
      { ...moved, code: { ...movedCode, space_after: ".flash.text" } },
      ["`.flash.text`", "after", "`ram`"],
    ],
    [
      "moved code that was already in the default space",
      true,
      { ...moved, code: { ...movedCode, space_before: "ram" } },
      ["`.flash.text`", "`ram`", "before", "overlay"],
    ],
    [
      "a reservation left in the default space",
      true,
      {
        ...moved,
        reservation: { ...moved.reservation, space_after: "ram" },
      },
      ["`.flash_rodata_dummy`", "`ram`", "after", "overlay"],
    ],
    [
      "canonical code in an overlay",
      true,
      {
        ...canonical,
        code: { ...movedCode, space_after: ".flash.text" },
      },
      ["`.flash.text`", "before", "`ram`"],
    ],
    ["a missing report", true, undefined, ["nobits-reservation-overlay-v1"]],
    ["an uncommitted report", false, moved, ["RISC-V load preparation"]],
    [
      "a refusal",
      true,
      { policy: "nobits-reservation-overlay-v1", refused: "no reservation" },
      ["`.flash.text`", "no reservation"],
    ],
  ] as const)("checks %s", (_label, planned, reported, failure) => {
    const reason = ghidraRiscvLoadPreparationFailure(
      planned ? ghidraRiscvLoadPreparation(esp()) : undefined,
      reported,
      "ram",
    );
    if (failure === undefined) expect(reason).toBeUndefined();
    else expect(reason).toEqual(stating(...failure));
  });

  it("prepares unnamed sections by their coordinates", () => {
    const unnamed = esp({
      sectionOverlap: {
        ...espOverlap,
        code: { ...espOverlap.code, name: "" },
        reservation: { ...espOverlap.reservation, name: "" },
      },
    });
    const prepared = ghidraRiscvLoadPreparation(unnamed);
    expect(ghidraRiscvLoadPreparationFailure(prepared, moved, "ram")).toBe(
      undefined,
    );
    expect(ghidraRiscvLoadPreparationLimitations(prepared, moved)[0]).toEqual(
      stating("section [16]", "section [15]", "NOBITS"),
    );
  });
});

describe("RISC-V load preparation handshake", () => {
  it("launches the preparation and reports its outcome as session limitations", async () => {
    const { client, launches } = await session(esp(), report, esp(), moved);
    const health = await client.execute("health", {});
    if (!health.ok) throw health.error;
    expect(launches).toHaveLength(1);
    expect(launches[0]?.launcher).toMatchObject({
      options: { riscvLoadPreparation: ghidraRiscvLoadPreparation(esp()) },
    });
    // The session reports the owning formatter's statements; each carries
    // the sections, their coordinates and the bridge's counts.
    const [layout, outcome] = ghidraRiscvLoadPreparationLimitations(
      ghidraRiscvLoadPreparation(esp()),
      moved,
    );
    expect(health.value.limitations).toEqual(
      expect.arrayContaining([layout, outcome]),
    );
    expect(layout).toEqual(
      stating(
        "`.flash_rodata_dummy`",
        "`.flash.text`",
        "0x42000020",
        "0xfff2",
        "NOBITS",
      ),
    );
    expect(outcome).toEqual(
      stating(
        "`.flash.text`",
        "`ram`",
        "`.flash_rodata_dummy`",
        "549",
        "331",
        "1",
      ),
    );
    // The planned statement gives way to the reported outcome.
    expect(health.value.limitations).not.toContainEqual(
      ghidraRiscvLoadPreparationLimitations(
        ghidraRiscvLoadPreparation(esp()),
      )[1],
    );
  });

  it("states that Ghidra already loaded the code where it belongs", async () => {
    const { client } = await session(esp(), report, esp(), canonical);
    const health = await client.execute("health", {});
    if (!health.ok) throw health.error;
    const outcome = ghidraRiscvLoadPreparationLimitations(
      ghidraRiscvLoadPreparation(esp()),
      canonical,
    )[1];
    expect(health.value.limitations).toContainEqual(outcome);
    expect(outcome).toEqual(stating("`.flash.text`", "`ram`"));
    const prepared = ghidraRiscvLoadPreparation(esp());
    for (const other of [
      ghidraRiscvLoadPreparationLimitations(prepared)[1],
      ghidraRiscvLoadPreparationLimitations(prepared, moved)[1],
    ])
      expect(health.value.limitations).not.toContainEqual(other);
  });

  it("checks a double-float preparation before the first analysis call", async () => {
    const value = target({ elfClass: 32, sectionOverlap: espOverlap });
    const { counts, client } = await session(value, undefined, value, {
      policy: "nobits-reservation-overlay-v1",
      refused: "no reservation",
    });
    const failed = await client.execute("list_procedures", {});
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error._tag).toBe("ProviderAdapterError");
    expect(counts).toEqual({ starts: 1, calls: 0, closes: 1 });
  });

  it.each([
    [
      "a refused preparation",
      esp(),
      esp(),
      {
        policy: "nobits-reservation-overlay-v1",
        refused: "no reservation",
      } as const,
    ],
    ["a missing report", esp(), esp(), undefined],
    ["a report the profile did not commit", ilp32(), ilp32(), moved],
  ] as const)(
    "closes the session on %s",
    async (_label, value, profileFor, prepared) => {
      const { counts, client } = await session(
        value,
        report,
        profileFor,
        prepared,
      );
      const failed = await client.execute("health", {});
      expect(failed.ok).toBe(false);
      expect(counts).toEqual({ starts: 1, calls: 0, closes: 1 });
    },
  );

  it("closes a session without a preparation that reports one, before any analysis call", async () => {
    const { counts, client } = await session(
      target(),
      undefined,
      target(),
      moved,
    );
    const failed = await client.execute("list_procedures", {});
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error._tag).toBe("ProviderAdapterError");
    expect(counts).toEqual({ starts: 1, calls: 0, closes: 1 });
  });

  it("refuses a profile whose preparation disagrees with the target", async () => {
    for (const [value, profileFor] of [
      [esp(), esp({ sectionOverlap: { status: "none" } })],
      [esp({ sectionOverlap: { status: "none" } }), esp()],
    ] as const) {
      const { counts, client } = await session(
        value,
        report,
        profileFor,
        moved,
      );
      expect((await client.execute("health", {})).ok).toBe(false);
      expect(counts.starts).toBe(0);
    }
  });

  it("keeps a caller project's stored preparation report as history", async () => {
    const resolved = await ghidra().resolveAnalysisProfile(esp());
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected an ilp32 profile");
    const info: GhidraSessionInfo = sessionInfo(esp(), report, moved);
    expect(
      ghidraProjectHistoryEvidence(esp(), resolved.value.profile, info)
        ?.normalized_result,
    ).toEqual({
      origin: "caller-project",
      riscv_calling_convention: report,
      elf_load_preparation: moved,
    });
  });
});
