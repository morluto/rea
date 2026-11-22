import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { silentLogger } from "../logger.js";
import {
  ghidraProfileLanguageOverride,
  sameGhidraLanguageOverride,
} from "./GhidraAnalysisProfile.js";
import {
  createSimulatedInstallDirectory,
  ghidraProfileInstallationHost as host,
} from "./GhidraInstallation.fixture.js";
import { SUPPORTED_GHIDRA_VERSION } from "./GhidraReleasePolicy.js";
import { readGhidraLanguageCatalog } from "./GhidraLanguageCatalog.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";

// Abbreviated from Ghidra 12.1.4 Processors/x86/data/languages/x86.ldefs.
const X86_LDEFS = `<?xml version="1.0" encoding="UTF-8"?>
<language_definitions>
  <language processor="x86"
            endian="little"
            size="32"
            variant="default"
            id="x86:LE:32:default">
    <description>Intel/AMD 32-bit x86</description>
    <compiler name="Visual Studio" spec="x86win.cspec" id="windows"/>
    <compiler name="gcc" spec="x86gcc.cspec" id="gcc"/>
    <compiler name="Borland C++" spec="x86borland.cspec" id="borlandcpp"/>
  </language>
  <language processor="x86" endian="little" size="16" variant="Real Mode"
            id="x86:LE:16:Real Mode">
    <compiler name="default" spec="x86-16.cspec" id="default"/>
  </language>
</language_definitions>
`;

const MIPS_LDEFS = `<?xml version="1.0" encoding="UTF-8"?>
<language_definitions>
  <language processor="MIPS" endian="little" size="32" variant="default"
            id="MIPS:LE:32:default">
    <description>MIPS 32-bit little endian</description>
    <compiler name="default" spec="mips32.cspec" id="default"/>
  </language>
</language_definitions>
`;

const pe: BinaryTarget = {
  path: process.platform === "win32" ? "C:\\fixture.exe" : "/fixture.exe",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "pe",
  architecture: "x86",
  availableArchitectures: ["x86"],
  executableRole: "application",
  managed: false,
};

const fixedImportTarget = (
  format: "raw-binary" | "dos-mz" | "dos-com",
): BinaryTarget => {
  const executable = {
    path: pe.path,
    sha256: pe.sha256,
    kind: "executable",
    architecture: "x86",
    availableArchitectures: ["x86"],
  } as const;
  return format === "raw-binary"
    ? {
        ...executable,
        format,
        entryPoint: "0x0",
        entryPointSource: "0x0",
      }
    : { ...executable, format };
};

const legacyMips: BinaryTarget = {
  path: "/fixture-mips.elf",
  sha256: "b".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "mips",
  availableArchitectures: ["mips"],
  mips: {
    elfClass: 32,
    byteOrder: "little",
    type: 2,
    flags: 0x50000001,
    abiFlags: null,
    gnuAttributes: null,
  },
};

let installDir = "";
let disposeInstallDir: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const directory = await createSimulatedInstallDirectory(
    "rea-ghidra-languages-",
  );
  installDir = directory.path;
  disposeInstallDir = directory.dispose;
  const languages = join(installDir, "Ghidra/Processors/x86/data/languages");
  await mkdir(languages, { recursive: true });
  await writeFile(join(languages, "x86.ldefs"), X86_LDEFS);
});
afterAll(async () => {
  await disposeInstallDir?.();
});

const lowScoreDosCom = async (target: BinaryTarget): Promise<BinaryTarget> => {
  const directory = await createTestTempDirectory("rea-com-profile-");
  const path = join(directory, "fixture.com");
  const bytes = Buffer.from("b83412c3", "hex");
  await writeFile(path, bytes);
  return {
    ...target,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

const provider = (environment: Record<string, string>) => {
  const parsed = parseConfig({
    GHIDRA_INSTALL_DIR: installDir,
    ...environment,
  });
  if (!parsed.ok) throw parsed.error;
  return new GhidraProvider(parsed.value, silentLogger, {}, host);
};

describe("Ghidra language override configuration", () => {
  it("accepts a language with an optional compiler spec", () => {
    const parsed = parseConfig({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
      REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp",
    });
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.ghidraLanguageOverride).toEqual({
      languageId: "x86:LE:32:default",
      compilerSpecId: "borlandcpp",
    });
    const languageOnly = parseConfig({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:16:Real Mode",
    });
    if (!languageOnly.ok) throw languageOnly.error;
    expect(languageOnly.value.ghidraLanguageOverride).toEqual({
      languageId: "x86:LE:16:Real Mode",
    });
  });

  it.each([
    "ARM:LEBE:32:v8LEInstruction",
    "ARM:LEBE:32:v7LEInstruction",
    "M16C/60:LE:16:default",
    "M16C/80:LE:16:default",
  ])("accepts the stock Ghidra language ID %s", (languageId) => {
    const parsed = parseConfig({ REA_GHIDRA_LANGUAGE_ID: languageId });
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.ghidraLanguageOverride).toEqual({ languageId });
  });

  it.each(["ARM:BELE:32:v8", "/x86:LE:32:default", "x86:LE:32:default "])(
    "still refuses the malformed language ID %j",
    (languageId) => {
      const parsed = parseConfig({ REA_GHIDRA_LANGUAGE_ID: languageId });
      expect(parsed.ok).toBe(false);
    },
  );

  it("requires a language for a compiler spec, as analyzeHeadless does", () => {
    const parsed = parseConfig({ REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp" });
    if (parsed.ok) throw new Error("Expected a configuration error");
    expect(projectAnalysisError(parsed.error)).toMatchObject({
      code: "configuration_invalid",
      details: {
        settings: [
          {
            setting: "REA_GHIDRA_COMPILER_SPEC_ID",
            constraint: "requires REA_GHIDRA_LANGUAGE_ID",
          },
        ],
      },
    });
  });

  it.each([
    ["REA_GHIDRA_LANGUAGE_ID", "x86 LE 32"],
    ["REA_GHIDRA_LANGUAGE_ID", "x86:LE:32: default"],
    ["REA_GHIDRA_LANGUAGE_ID", "x86:XE:32:default"],
    ["REA_GHIDRA_COMPILER_SPEC_ID", "borland cpp"],
  ])("rejects malformed %s %j without echoing it", (setting, value) => {
    const parsed = parseConfig({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
      [setting]: value,
    });
    if (parsed.ok) throw new Error("Expected a configuration error");
    const projected = projectAnalysisError(parsed.error);
    expect(projected).toMatchObject({
      code: "configuration_invalid",
      details: { settings: [{ setting, constraint: expect.any(String) }] },
    });
    expect(JSON.stringify(projected)).not.toContain(value);
  });
});

describe("Ghidra language catalog", () => {
  it("parses language IDs and their compiler specs", async () => {
    expect(
      await readGhidraLanguageCatalog(installDir, new ArtifactResourceScope()),
    ).toEqual([
      {
        id: "x86:LE:32:default",
        compilerSpecIds: ["windows", "gcc", "borlandcpp"],
      },
      { id: "x86:LE:16:Real Mode", compilerSpecIds: ["default"] },
    ]);
    expect(
      await readGhidraLanguageCatalog(
        join(installDir, "absent"),
        new ArtifactResourceScope(),
      ),
    ).toEqual([]);
  });

  it("identifies the malformed installed definition beside a valid selected language", async () => {
    const path = join(
      installDir,
      "Ghidra/Processors/x86/data/languages/broken.ldefs",
    );
    const configured = provider({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
    });
    await writeFile(
      path,
      "<language_definitions><language></language_definitions>",
    );
    try {
      const resolved = await configured.resolveAnalysisProfile(pe);
      if (resolved.ok) throw new Error("Expected a language catalog failure");
      expect(projectAnalysisError(resolved.error)).toMatchObject({
        details: {
          provider_id: "ghidra",
          operation: "resolve_analysis_profile",
          diagnostics: {
            setting: "REA_GHIDRA_LANGUAGE_ID",
            code: "language_definition_invalid",
            path,
            parse_kind: "malformed",
            parse_message: expect.stringContaining("XML is not well-formed"),
          },
        },
      });
      await writeFile(path, "<language_definitions/>");
      const repaired = await configured.resolveAnalysisProfile(pe);
      if (!repaired.ok) throw repaired.error;
      expect(repaired.value.profile?.parameters.language_id).toBe(
        "x86:LE:32:default",
      );
    } finally {
      await rm(path);
    }
  });
});

describe("Ghidra language override profile", () => {
  it("accepts the caller-selected language on the legacy MIPS lane", async () => {
    const mipsLanguages = join(
      installDir,
      "Ghidra/Processors/MIPS/data/languages",
    );
    await mkdir(mipsLanguages, { recursive: true });
    const definition = join(mipsLanguages, "mips.ldefs");
    await writeFile(definition, MIPS_LDEFS);
    try {
      const resolved = await provider({
        REA_GHIDRA_LANGUAGE_ID: "MIPS:LE:32:default",
        REA_GHIDRA_COMPILER_SPEC_ID: "default",
      }).resolveAnalysisProfile(legacyMips);
      if (!resolved.ok) throw resolved.error;
      expect(resolved.value.profile?.parameters).toMatchObject({
        language_id: "MIPS:LE:32:default",
        compiler_spec_id: "default",
        language_selection: "configured",
      });
    } finally {
      await rm(mipsLanguages, { recursive: true, force: true });
    }
  });

  it("records the language default when no compiler spec is configured", async () => {
    const resolved = await provider({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
    }).resolveAnalysisProfile(pe);
    if (!resolved.ok) throw resolved.error;
    const parameters = resolved.value.profile?.parameters ?? {};
    expect(parameters.compiler_spec_id).toBe("language-default");
    expect(ghidraProfileLanguageOverride(parameters)).toEqual({
      languageId: "x86:LE:32:default",
    });
  });

  it("keeps header auto-detection and a distinct digest without an override", async () => {
    const automatic = await provider({}).resolveAnalysisProfile(pe);
    const configured = await provider({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
      REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp",
    }).resolveAnalysisProfile(pe);
    if (!automatic.ok) throw automatic.error;
    if (!configured.ok) throw configured.error;
    const parameters = automatic.value.profile?.parameters ?? {};
    expect(parameters).toMatchObject({
      language_id: "auto-from-header",
      compiler_spec_id: "auto-default",
    });
    expect(parameters).not.toHaveProperty("language_selection");
    expect(ghidraProfileLanguageOverride(parameters)).toBeUndefined();
    const selectedParameters = configured.value.profile?.parameters;
    expect(selectedParameters).toMatchObject({
      loader: "auto-from-header",
      language_id: "x86:LE:32:default",
      compiler_spec_id: "borlandcpp",
      language_selection: "configured",
    });
    expect(ghidraProfileLanguageOverride(selectedParameters ?? {})).toEqual({
      languageId: "x86:LE:32:default",
      compilerSpecId: "borlandcpp",
    });
    expect(automatic.value.profile?.digest).toEqual(expect.any(String));
    expect(configured.value.profile?.digest).toEqual(expect.any(String));
    expect(automatic.value.profile?.digest).not.toBe(
      configured.value.profile?.digest,
    );
  });

  it.each([
    {
      overrides: { REA_GHIDRA_LANGUAGE_ID: "x86:LE:31:default" },
      setting: "REA_GHIDRA_LANGUAGE_ID",
      constraint: `is not a language defined by Ghidra ${SUPPORTED_GHIDRA_VERSION}`,
    },
    {
      overrides: {
        REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
        REA_GHIDRA_COMPILER_SPEC_ID: "golang",
      },
      setting: "REA_GHIDRA_COMPILER_SPEC_ID",
      constraint:
        "must be one of the selected language's compiler specs: windows, gcc, borlandcpp",
    },
  ])(
    "refuses an undefined $setting before launching Ghidra",
    async ({ overrides, setting, constraint }) => {
      const resolved = await provider(overrides).resolveAnalysisProfile(pe);
      if (resolved.ok) throw new Error("Expected a configuration error");
      expect(projectAnalysisError(resolved.error)).toMatchObject({
        code: "configuration_invalid",
        details: { settings: [{ setting, constraint }] },
      });
    },
  );

  it.each(["raw-binary", "dos-mz", "dos-com"] as const)(
    "attributes a fixed %s import override conflict to the named settings",
    async (format) => {
      const target = fixedImportTarget(format);
      const resolved = await provider({
        REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
        REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp",
      }).resolveAnalysisProfile(target);
      if (resolved.ok) throw new Error("Expected an override policy conflict");
      expect(projectAnalysisError(resolved.error)).toMatchObject({
        code: "configuration_invalid",
        details: {
          settings: [
            { setting: "REA_GHIDRA_LANGUAGE_ID" },
            { setting: "REA_GHIDRA_COMPILER_SPEC_ID" },
          ],
        },
      });
      const admitted =
        format === "dos-com" ? await lowScoreDosCom(target) : target;
      const automatic = await provider({}).resolveAnalysisProfile(admitted);
      expect(automatic.ok).toBe(true);
    },
  );

  it("compares committed and configured selections exactly", () => {
    expect(sameGhidraLanguageOverride(undefined, undefined)).toBe(true);
    expect(
      sameGhidraLanguageOverride(
        { languageId: "x86:LE:32:default" },
        { languageId: "x86:LE:32:default", compilerSpecId: "borlandcpp" },
      ),
    ).toBe(false);
  });
});

it
  .skipIf(process.platform === "win32" || process.getuid?.() === 0)
  .each(["Ghidra/Processors", "Ghidra/Processors/x86/data/languages"])(
  "preserves a physical refusal reading the language catalog directory %s",
  async (relativePath) => {
    const root = await createTestTempDirectory(
      "rea-ghidra-catalog-permission-",
    );
    const languages = join(root, "Ghidra/Processors/x86/data/languages");
    await mkdir(languages, { recursive: true });
    await writeFile(join(languages, "x86.ldefs"), X86_LDEFS);
    const resources = new ArtifactResourceScope();
    const blocked = join(root, relativePath);
    try {
      const original = await readGhidraLanguageCatalog(root, resources);
      expect(original.length).toBeGreaterThan(0);
      await chmod(blocked, 0);
      await expect(readdir(blocked)).rejects.toMatchObject({ code: "EACCES" });
      await expect(
        readGhidraLanguageCatalog(root, resources),
      ).rejects.toMatchObject({ code: "EACCES", path: blocked });
      await chmod(blocked, 0o755);
      expect(await readGhidraLanguageCatalog(root, resources)).toEqual(
        original,
      );
    } finally {
      await chmod(blocked, 0o755);
      await resources.close();
    }
  },
);

describe("Ghidra concurrent language catalog", () => {
  it("preserves sorted module and entry order across >8 modules with missing language dirs", async () => {
    const root = await createTestTempDirectory("rea-ghidra-catalog-many-");
    const expectedIds: string[] = [];
    for (let index = 24; index >= 0; index -= 1) {
      const module = `M_${String(index).padStart(2, "0")}`;
      const modDir = join(root, "Ghidra/Processors", module);
      if (index % 5 === 0) {
        await mkdir(modDir, { recursive: true });
        continue;
      }
      const languages = join(modDir, "data/languages");
      await mkdir(languages, { recursive: true });
      for (const part of ["b", "a"]) {
        const id = `${module}_${part}:LE:32:default`;
        await writeFile(
          join(languages, `${part}.ldefs`),
          `<language_definitions><language id="${id}"><compiler id="default"/></language></language_definitions>`,
        );
      }
    }
    for (let index = 0; index < 25; index += 1) {
      if (index % 5 === 0) continue;
      const module = `M_${String(index).padStart(2, "0")}`;
      expectedIds.push(
        `${module}_a:LE:32:default`,
        `${module}_b:LE:32:default`,
      );
    }
    const resources = new ArtifactResourceScope();
    try {
      const catalog = await readGhidraLanguageCatalog(root, resources);
      expect(catalog.map(({ id }) => id)).toEqual(expectedIds);
    } finally {
      await resources.close();
    }
  });
});
