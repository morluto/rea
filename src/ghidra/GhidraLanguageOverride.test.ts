import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { silentLogger } from "../logger.js";
import {
  ghidraProfileLanguageOverride,
  sameGhidraLanguageOverride,
} from "./GhidraAnalysisProfile.js";
import type { GhidraInstallationHost } from "./GhidraInstallation.js";
import {
  admitGhidraLanguageOverride,
  parseGhidraLanguageDefinitions,
  readGhidraLanguageCatalog,
} from "./GhidraLanguageCatalog.js";
import { GhidraProvider } from "./GhidraProvider.js";

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

// Fake installation inspection; the language catalog is a real directory.
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

const pe: BinaryTarget = {
  path: "/fixture.exe",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "pe",
  architecture: "x86",
  availableArchitectures: ["x86"],
  executableRole: "application",
  managed: false,
};

let installDir = "";
beforeAll(async () => {
  installDir = await mkdtemp(join(tmpdir(), "rea-ghidra-languages-"));
  const languages = join(installDir, "Ghidra/Processors/x86/data/languages");
  await mkdir(languages, { recursive: true });
  await writeFile(join(languages, "x86.ldefs"), X86_LDEFS);
});
afterAll(async () => {
  await rm(installDir, { recursive: true, force: true });
});

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
  it("reads quoted and escaped XML attributes without admitting comments or CDATA", () => {
    const catalog = parseGhidraLanguageDefinitions(`<language_definitions>
      <!-- <language id="removed"><compiler id="removed"/></language> -->
      <language id='x86:LE:32:default'>
        <description><![CDATA[<compiler id="not-a-compiler"/>]]></description>
        <!-- <compiler id="removed"/> -->
        <compiler id='borland&#99;pp' name='Borland &amp; C++'/>
      </language>
    </language_definitions>`);
    expect(catalog).toEqual([
      { id: "x86:LE:32:default", compilerSpecIds: ["borlandcpp"] },
    ]);
    expect(
      admitGhidraLanguageOverride(
        { languageId: "x86:LE:32:default", compilerSpecId: "removed" },
        catalog,
        "12.1.4",
      )?.settings,
    ).toEqual([
      {
        setting: "REA_GHIDRA_COMPILER_SPEC_ID",
        constraint:
          "must be one of the selected language's compiler specs: borlandcpp",
      },
    ]);
  });

  it.each([
    '<language_definitions><language id="x86:LE:32:default"></language_definitions>',
    "<language_definitions><language id=x86:LE:32:default/></language_definitions>",
    '<other><language id="x86:LE:32:default"/></other>',
  ])("rejects malformed language-definition documents", (text) => {
    expect(() => parseGhidraLanguageDefinitions(text)).toThrow();
  });

  it("parses language IDs and their compiler specs", async () => {
    expect(parseGhidraLanguageDefinitions(X86_LDEFS)).toEqual([
      {
        id: "x86:LE:32:default",
        compilerSpecIds: ["windows", "gcc", "borlandcpp"],
      },
      { id: "x86:LE:16:Real Mode", compilerSpecIds: ["default"] },
    ]);
    expect(await readGhidraLanguageCatalog(installDir)).toHaveLength(2);
    expect(await readGhidraLanguageCatalog(join(installDir, "absent"))).toEqual(
      [],
    );
  });

  it("admits only languages and compiler specs the installation defines", () => {
    const catalog = parseGhidraLanguageDefinitions(X86_LDEFS);
    expect(
      admitGhidraLanguageOverride(
        { languageId: "x86:LE:32:default", compilerSpecId: "borlandcpp" },
        catalog,
        "12.1.4",
      ),
    ).toBeNull();
    const language = admitGhidraLanguageOverride(
      { languageId: "x86:LE:31:default" },
      catalog,
      "12.1.4",
    );
    expect(language?.settings).toEqual([
      {
        setting: "REA_GHIDRA_LANGUAGE_ID",
        constraint: "is not a language defined by Ghidra 12.1.4",
      },
    ]);
    const spec = admitGhidraLanguageOverride(
      { languageId: "x86:LE:32:default", compilerSpecId: "golang" },
      catalog,
      "12.1.4",
    );
    expect(spec?.settings).toEqual([
      {
        setting: "REA_GHIDRA_COMPILER_SPEC_ID",
        constraint:
          "must be one of the selected language's compiler specs: windows, gcc, borlandcpp",
      },
    ]);
  });
});

describe("Ghidra language override profile", () => {
  it("returns a provider failure for a malformed installed language definition", async () => {
    const path = join(
      installDir,
      "Ghidra/Processors/x86/data/languages/broken.ldefs",
    );
    await writeFile(
      path,
      "<language_definitions><language></language_definitions>",
    );
    try {
      const resolved = await provider({
        REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
      }).resolveAnalysisProfile(pe);
      if (resolved.ok) throw new Error("Expected a language catalog failure");
      expect(resolved.error).toMatchObject({
        providerId: "ghidra",
        operation: "resolve_analysis_profile",
      });
    } finally {
      await rm(path);
    }
  });

  it("commits the configured language and compiler spec", async () => {
    const resolved = await provider({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
      REA_GHIDRA_COMPILER_SPEC_ID: "borlandcpp",
    }).resolveAnalysisProfile(pe);
    if (!resolved.ok) throw resolved.error;
    const parameters = resolved.value.profile?.parameters ?? {};
    expect(parameters).toMatchObject({
      loader: "auto-from-header",
      language_id: "x86:LE:32:default",
      compiler_spec_id: "borlandcpp",
      language_selection: "configured-v1",
    });
    expect(ghidraProfileLanguageOverride(parameters)).toEqual({
      languageId: "x86:LE:32:default",
      compilerSpecId: "borlandcpp",
    });
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
    expect(automatic.value.profile?.digest).not.toBe(
      configured.value.profile?.digest,
    );
  });

  it("refuses an undefined compiler spec before launching Ghidra", async () => {
    const resolved = await provider({
      REA_GHIDRA_LANGUAGE_ID: "x86:LE:32:default",
      REA_GHIDRA_COMPILER_SPEC_ID: "golang",
    }).resolveAnalysisProfile(pe);
    if (resolved.ok) throw new Error("Expected a configuration error");
    expect(projectAnalysisError(resolved.error)).toMatchObject({
      code: "configuration_invalid",
      details: {
        settings: [{ setting: "REA_GHIDRA_COMPILER_SPEC_ID" }],
      },
    });
  });

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
