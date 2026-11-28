import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "../config/parseConfig.js";
import type {
  ArmElfMetadata,
  BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import { GhidraProvider } from "./GhidraProvider.js";
import {
  ghidraArmProfileParameters,
  ghidraArmLanguageOverride,
  ghidraPinnedArmLanguage,
} from "./GhidraArmProfile.js";
import { ghidraMipsLanguageOverride } from "./GhidraMipsProfile.js";
import { ghidraProfilePinnedLanguage } from "./GhidraAnalysisProfile.js";
import {
  createSimulatedInstallDirectory,
  ghidraProfileInstallationHost as host,
} from "./GhidraInstallation.fixture.js";
import type { GhidraClientOptions } from "./GhidraClientTypes.js";
import type { GhidraHeadlessLauncher } from "./GhidraLauncher.js";
import { GHIDRA_SESSION_CAPABILITIES } from "./GhidraSessionValues.js";
import { ok } from "../domain/result.js";

// Fake installation inspection tests admission/profile contracts, not Ghidra.
// The installation directory must exist on the host, so the admission tests
// point at a real temporary directory.
let installDir = "";
let disposeInstallDir: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const directory = await createSimulatedInstallDirectory(
    "rea-ghidra-arm-admission-",
  );
  installDir = directory.path;
  disposeInstallDir = directory.dispose;
  const languages = join(installDir, "Ghidra/Processors/ARM/data/languages");
  await mkdir(languages, { recursive: true });
  await writeFile(
    join(languages, "ARM.ldefs"),
    `<language_definitions><language processor="ARM" endian="little" size="32" variant="Cortex" version="1.0" slafile="ARM.sla" processorspec="ARM.pspec" id="ARM:LE:32:Cortex"><description>ARM Cortex override fixture</description><compiler name="default" spec="default.cspec" id="default"/></language></language_definitions>`,
  );
});
afterAll(async () => {
  await disposeInstallDir?.();
});
const config = () => {
  const parsed = parseConfig({ GHIDRA_INSTALL_DIR: installDir });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const target = (change: Partial<ArmElfMetadata> = {}): BinaryTarget => ({
  path: "/fixture.elf",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "arm",
  availableArchitectures: ["arm"],
  arm: {
    elfClass: 32,
    byteOrder: "little",
    headerSize: 52,
    type: 2,
    flags: 0x05000400,
    cpuArch: 10,
    cpuArchProfile: "A",
    ...change,
  },
});

describe("bounded Ghidra ARM admission", () => {
  it("admits a verified armhf header with a pinned 32-bit v7 language", async () => {
    const ghidra = new GhidraProvider(config(), silentLogger, {}, host);
    expect(ghidra.inspectTargetSupport(target()).status).toBe("supported");
    const resolved = await ghidra.resolveAnalysisProfile(target());
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.profile?.parameters).toMatchObject({
      arm_elf: {
        elf_class: 32,
        byte_order: "little",
        type: 2,
        flags: 0x05000400,
        cpu_arch: 10,
        cpu_arch_name: "v7",
        cpu_arch_profile: "A",
        float_abi: "hard",
      },
      arm_support_lane: "elf32-exec-le-eabi5-v7-pinned",
      language_id: "ARM:LE:32:v7",
      compiler_spec_id: "default",
      language_selection: "provider-pinned",
    });
  });

  it("admits declarations that leave the divide and virtualization extensions off", () => {
    const ghidra = new GhidraProvider(config(), silentLogger, {}, host);
    const value = target({
      extensions: [
        { tag: 44, value: 1 },
        { tag: 68, value: 0 },
      ],
    });
    expect(ghidra.inspectTargetSupport(value).status).toBe("supported");
  });

  it("records an unspecified float convention as such", () => {
    const parameters = ghidraArmProfileParameters(
      target({ flags: 0x05000000 }),
    );
    expect(parameters.arm_elf).toMatchObject({ float_abi: "unspecified" });
  });

  it.each([
    [{ elfClass: 64 }, "ELF32"],
    [{ byteOrder: "big" }, "little-endian"],
    [{ type: 3 }, "ET_EXEC"],
    [{ type: 0xffa0 }, "ET_EXEC"],
    [{ flags: 0x04000400 }, "EABI5"],
    [{ flags: 0x05800400 }, "BE8"],
    [{ flags: 0x05000600 }, "FLOAT_SOFT"],
    [{ flags: 0x05000000 }, "requires EF_ARM_ABI_FLOAT_HARD"],
    [{ cpuArch: null }, "Tag_CPU_arch"],
    [{ cpuArch: 14 }, "v8-A"],
    [{ cpuArch: 6 }, "v6"],
    [{ cpuArch: 13 }, "v7E-M"],
    [{ cpuArch: 21 }, "v8.1-M Mainline"],
    [{ cpuArch: 22 }, "v9-A"],
    [{ cpuArch: 99 }, "unknown architecture (99)"],
    [{ cpuArchProfile: "R" }, "Realtime profile"],
    [{ cpuArchProfile: "M" }, "Microcontroller profile"],
    [{ cpuArchProfile: null }, "no Tag_CPU_arch_profile"],
    [{ cpuArchProfile: "\u0000" }, "Not Applicable profile"],
    [
      { limitations: ["ARM section header table extends beyond the file"] },
      "ARM section header table extends beyond the file",
    ],
    [
      {
        limitations: [
          "ARM attribute section at file offset 8192 exceeds the 65536-byte inspection bound; declarations remain unknown.",
        ],
      },
      "exceeds the 65536-byte inspection bound",
    ],
    [{ extensions: [{ tag: 44, value: 2 }] }, "Tag_DIV_use=2"],
    [{ extensions: [{ tag: 68, value: 3 }] }, "Tag_Virtualization_use=3"],
  ] satisfies [Partial<ArmElfMetadata>, string][])(
    "refuses an unverified ARM interpretation %j",
    async (change, reason) => {
      const ghidra = new GhidraProvider(config(), silentLogger, {}, host);
      const value = target(change);
      expect(ghidra.inspectTargetSupport(value)).toMatchObject({
        status: "unsupported",
        reason: expect.stringContaining(reason),
      });
      const resolved = await ghidra.resolveAnalysisProfile(value);
      expect(resolved.ok).toBe(false);
    },
  );

  it("a caller-selected language wins over the provider pin", () => {
    const parameters = ghidraArmProfileParameters(target(), {
      languageId: "ARM:LE:32:Cortex",
      compilerSpecId: "default",
    });
    expect(parameters.language_selection).toBeUndefined();
    expect(parameters.language_id).toBeUndefined();
    expect(parameters).toMatchObject({
      arm_support_lane: "elf32-exec-le-eabi5-v7-pinned",
    });
  });

  it("reads the pinned import language back only from pinned profiles", () => {
    const pinned = ghidraArmProfileParameters(target());
    expect(ghidraPinnedArmLanguage(pinned)).toEqual({
      languageId: "ARM:LE:32:v7",
      compilerSpecId: "default",
    });
    const other = { language_selection: "configured" };
    expect(ghidraPinnedArmLanguage(other)).toBeUndefined();
  });
});

describe("Ghidra ARM client import wiring", () => {
  it.each(["pinned", "override", "conflicting override"] as const)(
    "binds ARM client import and readback for %s",
    async (mode) => {
      const plain = new GhidraProvider(config(), silentLogger, {}, host);
      const selected = parseConfig({
        GHIDRA_INSTALL_DIR: installDir,
        ...(mode === "pinned"
          ? {}
          : {
              REA_GHIDRA_LANGUAGE_ID: "ARM:LE:32:Cortex",
              REA_GHIDRA_COMPILER_SPEC_ID: "default",
            }),
      });
      if (!selected.ok) throw selected.error;
      const observed: GhidraClientOptions[] = [];
      const ghidra = new GhidraProvider(
        selected.value,
        silentLogger,
        {},
        host,
        (options) => {
          observed.push(options);
          return {
            start: () =>
              Promise.resolve(
                ok({
                  name: "REA Ghidra bridge" as const,
                  run_id: "11111111-1111-4111-8111-111111111111",
                  profile_digest: options.profileDigest,
                  provider: { id: "ghidra" as const, version: "12.1.4" },
                  read_only: false,
                  analysis_complete: true,
                  analysis_timed_out: false,
                  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
                  target: {
                    name: "fixture.elf",
                    language_id: options.expectedLanguageId!,
                    compiler_spec_id: "default",
                    image_base: "0x0",
                    default_address_space: "ram",
                    sha256: "a".repeat(64),
                  },
                }),
              ),
            callTool: () => Promise.resolve(ok(null)),
            close: () => Promise.resolve(ok(null)),
          };
        },
      );
      const resolved = await (
        mode === "conflicting override" ? plain : ghidra
      ).resolveAnalysisProfile(target());
      if (!resolved.ok || resolved.value.profile === null)
        throw new Error("Expected ARM profile");
      const client = ghidra.createClient(target(), resolved.value.profile);
      try {
        const health = await client.execute("health", {});
        if (mode === "conflicting override") {
          expect(health.ok).toBe(false);
          expect(observed).toHaveLength(0);
          return;
        }
        if (!health.ok) throw health.error;
        const language =
          mode === "pinned" ? "ARM:LE:32:v7" : "ARM:LE:32:Cortex";
        const [options] = observed;
        if (options === undefined) throw new Error("Expected client options");
        expect(options.expectedLanguageId).toBe(language);
        expect(options.expectedCompilerSpecId).toBe("default");
        expect(
          (options.launcher as GhidraHeadlessLauncher).options.languageOverride,
        ).toEqual({ languageId: language, compilerSpecId: "default" });
        expect(
          health.value.limitations.some((value) => value.includes("lane pins")),
        ).toBe(mode === "pinned");
        expect(health.value.limitations).toEqual(
          expect.arrayContaining([expect.stringContaining("float ABI")]),
        );
      } finally {
        await client.close();
      }
    },
  );
});

it("derives ARM pin applicability from target facts and keeps MIPS pin ownership separate", () => {
  const admitted = target();
  const armProfile = ghidraArmProfileParameters(admitted);
  expect(ghidraArmLanguageOverride(admitted)).toEqual({
    languageId: "ARM:LE:32:v7",
    compilerSpecId: "default",
  });
  expect(ghidraArmLanguageOverride(target({ cpuArch: 14 }))).toBeUndefined();
  expect(ghidraMipsLanguageOverride(admitted)).toBeUndefined();
  expect(ghidraProfilePinnedLanguage(armProfile)).toEqual({
    languageId: "ARM:LE:32:v7",
    compilerSpecId: "default",
  });
  expect(
    ghidraPinnedArmLanguage({
      language_selection: "provider-pinned",
      mips_support_lane: "elf32-exec-arch32-legacy-pinned",
      language_id: "MIPS:LE:32:default",
      compiler_spec_id: "default",
    }),
  ).toBeUndefined();
});
