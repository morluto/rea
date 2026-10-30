import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { parseConfig } from "../config/parseConfig.js";
import type {
  BinaryTarget,
  XtensaElfMetadata,
} from "../domain/binaryTargetTypes.js";
import { ok } from "../domain/result.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { hopperLoaderArgsForTarget } from "../hopper/HopperAnalysisProfile.js";
import { IdaProvider } from "../ida/IdaProvider.js";
import { KunaProvider } from "../kuna/KunaProvider.js";
import { silentLogger } from "../logger.js";
import {
  ghidraEffectiveLanguageOverride,
  ghidraPinnedLanguage,
  ghidraProfileLanguageOverride,
} from "./GhidraAnalysisProfile.js";
import type { GhidraClientOptions } from "./GhidraClientTypes.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import { GhidraProvider } from "./GhidraProvider.js";
import type { GhidraProviderClientFactory } from "./GhidraProviderClient.js";
import {
  GHIDRA_SESSION_CAPABILITIES,
  parseGhidraSessionInfo,
} from "./GhidraSessionValues.js";
import {
  ghidraXtensaLimitations,
  ghidraXtensaProfileMismatchReason,
} from "./GhidraXtensaProfile.js";

// Abbreviated from Ghidra 12.1.4 Processors/Xtensa/data/languages/xtensa.ldefs:
// one compiler specification per language, with id `default` and no `gcc`.
const XTENSA_LDEFS = `<?xml version="1.0" encoding="UTF-8"?>
<language_definitions>
  <language processor="Xtensa" endian="little" size="32" variant="default"
            version="4.1" slafile="xtensa_le.sla" processorspec="xtensa.pspec"
            id="Xtensa:LE:32:default">
    <compiler name="default" spec="xtensa.cspec" id="default"/>
  </language>
  <language processor="Xtensa" endian="big" size="32" variant="default"
            version="4.1" slafile="xtensa_be.sla" processorspec="xtensa.pspec"
            id="Xtensa:BE:32:default">
    <compiler name="default" spec="xtensa.cspec" id="default"/>
  </language>
</language_definitions>
`;

const PINNED = {
  languageId: "Xtensa:LE:32:default",
  compilerSpecId: "default",
};

const configFor = (environment: NodeJS.ProcessEnv = {}) => {
  const parsed = parseConfig({ GHIDRA_INSTALL_DIR: "/ghidra", ...environment });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const ghidra = (
  environment: NodeJS.ProcessEnv = {},
  clientFactory?: GhidraProviderClientFactory,
) =>
  new GhidraProvider(
    configFor(environment),
    silentLogger,
    {},
    host,
    clientFactory,
  );

/** ESP-IDF ESP32/S2/S3 application headers: ELF32 LE ET_EXEC, e_flags 0x300. */
const HEADER = {
  elfClass: 32,
  byteOrder: "little",
  type: 2,
  flags: 0x300,
} as const satisfies XtensaElfMetadata;
const target = (
  change: Partial<XtensaElfMetadata> = {},
  xtensa: XtensaElfMetadata = {
    ...HEADER,
    abi: { status: "declared", abi: "windowed" },
    ...change,
  },
): BinaryTarget => ({
  path: "/firmware.elf",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "xtensa",
  availableArchitectures: ["xtensa"],
  xtensa,
});

/** Ghidra installation holding only the Xtensa language definitions. */
const xtensaInstallation = async (): Promise<string> => {
  const installDir = await createTestTempDirectory("rea-ghidra-xtensa-");
  const languages = join(installDir, "Ghidra/Processors/Xtensa/data/languages");
  await mkdir(languages, { recursive: true });
  await writeFile(join(languages, "xtensa.ldefs"), XTENSA_LDEFS);
  return installDir;
};

const session = (languageId: string, compilerSpecId: string) => ({
  name: "REA Ghidra bridge" as const,
  run_id: "11111111-1111-4111-8111-111111111111",
  profile_digest: "b".repeat(64),
  provider: { id: "ghidra" as const, version: "12.1.4" },
  read_only: false as const,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
  target: {
    name: "firmware.elf",
    language_id: languageId,
    compiler_spec_id: compilerSpecId,
    image_base: "0x0",
    default_address_space: "ram",
    sha256: "a".repeat(64),
  },
});

/** Capture each launch without starting Ghidra; the stub reports the pinned import. */
const capturingFactory =
  (launches: GhidraClientOptions[]): GhidraProviderClientFactory =>
  (options) => {
    launches.push(options);
    return {
      start: () => Promise.resolve(ok(session(PINNED.languageId, "default"))),
      callTool: () => Promise.resolve(ok(null)),
      close: () => Promise.resolve(ok(null)),
    };
  };

/** A launch that imports with, and then asserts, the complete pinned language. */
const pinnedLaunch = expect.objectContaining({
  expectedLanguageId: "Xtensa:LE:32:default",
  expectedCompilerSpecId: "default",
  launcher: expect.objectContaining({
    options: expect.objectContaining({ languageOverride: PINNED }),
  }),
});

const registerPinCases = () => {
  it("pins the generic little-endian language with the `default` compiler spec", async () => {
    const provider = ghidra();
    expect(provider.inspectTargetSupport(target())).toMatchObject({
      status: "supported",
    });
    expect(ghidraPinnedLanguage(target())).toEqual(PINNED);
    const resolved = await provider.resolveAnalysisProfile(target());
    if (!resolved.ok) throw resolved.error;
    const parameters = resolved.value.profile?.parameters ?? {};
    expect(parameters).toMatchObject({
      target_format: "elf",
      architecture: "xtensa",
      loader: "auto-from-header",
      language_id: "Xtensa:LE:32:default",
      compiler_spec_id: "default",
      language_selection: "provider-pinned-v1",
      xtensa_elf: {
        elf_class: 32,
        byte_order: "little",
        type: 2,
        flags: 0x300,
        abi: "windowed",
      },
      xtensa_support_lane: "elf32-le-exec-windowed-generic-v1",
    });
    expect(ghidraProfileLanguageOverride(parameters)).toEqual(PINNED);
  });

  it("commits header flags so a changed declaration changes the profile", async () => {
    const provider = ghidra();
    const left = await provider.resolveAnalysisProfile(target());
    const right = await provider.resolveAnalysisProfile(target({ flags: 0 }));
    if (!left.ok) throw left.error;
    if (!right.ok) throw right.error;
    expect(left.value.profile?.digest).not.toBe(right.value.profile?.digest);
  });

  it("refuses a committed profile resolved for another Xtensa image", async () => {
    const launches: GhidraClientOptions[] = [];
    const provider = ghidra({}, capturingFactory(launches));
    const resolved = await provider.resolveAnalysisProfile(target());
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected an Xtensa profile");
    const { parameters } = resolved.value.profile;
    // Both images pin the same language; only the committed ELF facts differ.
    const other = target({ flags: 0 });
    expect(ghidraXtensaProfileMismatchReason(target(), parameters)).toBeNull();
    const reason = ghidraXtensaProfileMismatchReason(other, parameters);
    expect(reason).not.toBeNull();
    const client = provider.createClient(other, resolved.value.profile);
    try {
      expect(await client.execute("health", {})).toMatchObject({
        ok: false,
        error: { diagnostics: { reason } },
      });
    } finally {
      await client.close();
    }
    // The refusal comes before any Ghidra launch.
    expect(launches).toEqual([]);
  });

  it("imports with the pin and asserts it against the session handshake", async () => {
    const launches: GhidraClientOptions[] = [];
    const provider = ghidra({}, capturingFactory(launches));
    const resolved = await provider.resolveAnalysisProfile(target());
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected an Xtensa profile");
    const client = provider.createClient(target(), resolved.value.profile);
    try {
      const health = await client.execute("health", {});
      if (!health.ok) throw health.error;
    } finally {
      await client.close();
    }
    expect(launches).toEqual([pinnedLaunch]);
    // The bridge handshake enforces the expectation above after import.
    const expected = {
      runId: "11111111-1111-4111-8111-111111111111",
      providerVersion: "12.1.4",
      profileDigest: "b".repeat(64),
      targetSha256: "a".repeat(64),
      expectedLanguageId: PINNED.languageId,
      expectedCompilerSpecId: PINNED.compilerSpecId,
    };
    expect(
      parseGhidraSessionInfo(session(PINNED.languageId, "default"), expected)
        .ok,
    ).toBe(true);
    for (const [language, compiler] of [
      ["Xtensa:BE:32:default", "default"],
      ["Xtensa:LE:32:default", "gcc"],
    ] as const)
      expect(
        parseGhidraSessionInfo(session(language, compiler), expected).ok,
      ).toBe(false);
  });
};

const registerRefusalCases = () => {
  it.each([
    [{ elfClass: 64 }, "ELF32 only"],
    [{ byteOrder: "big" }, "little-endian images only"],
    [{ type: 1 }, "relocatable images"],
    [{ type: 3 }, "shared and position-independent images"],
    [{ type: 0xfe00 }, "e_type 65024"],
    [{ flags: 0x700 }, "(0x400)"],
    [{ flags: 0x8000_0300 }, "(0x80000000)"],
    [{ flags: 0x301 }, "declares machine 1"],
    [{ abi: { status: "declared", abi: "call0" } }, "call0 ABI"],
    [{ abi: { status: "unrecognized", value: "2" } }, "ABI=2"],
    [{ abi: { status: "absent" } }, "declares no ABI"],
    [
      { abi: { status: "unavailable", reason: "A note is truncated." } },
      "A note is truncated.",
    ],
  ] satisfies [Partial<XtensaElfMetadata>, string][])(
    "refuses an unverified Xtensa interpretation %j",
    async (change, reason) => {
      const provider = ghidra();
      const value = target(change);
      expect(provider.inspectTargetSupport(value)).toMatchObject({
        status: "unsupported",
        code: "architecture_unsupported",
        reason: expect.stringContaining(reason),
      });
      expect(await provider.resolveAnalysisProfile(value)).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisUnsupportedTargetError",
          reason: expect.stringContaining(reason),
        },
      });
      expect(ghidraPinnedLanguage(value)).toBeUndefined();
    },
  );

  it("refuses a target whose ABI declaration was never inspected", () => {
    const uninspected = target({}, HEADER);
    expect(ghidraPinnedLanguage(uninspected)).toBeUndefined();
    expect(ghidra().inspectTargetSupport(uninspected)).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("was not inspected"),
    });
  });

  it("does not widen Windows P0", () => {
    const windows = new GhidraProvider(
      configFor(),
      silentLogger,
      {},
      { ...host, platform: "win32" },
    );
    expect(windows.inspectTargetSupport(target()).status).toBe("unsupported");
  });
};

const registerOverrideCases = () => {
  it.each([
    [
      { REA_GHIDRA_LANGUAGE_ID: "Xtensa:BE:32:default" },
      "REA_GHIDRA_LANGUAGE_ID",
    ],
    [
      {
        REA_GHIDRA_LANGUAGE_ID: "Xtensa:LE:32:default",
        REA_GHIDRA_COMPILER_SPEC_ID: "gcc",
      },
      "REA_GHIDRA_COMPILER_SPEC_ID",
    ],
  ])(
    "refuses a caller selection outside the pin %j",
    async (environment, setting) => {
      const resolved =
        await ghidra(environment).resolveAnalysisProfile(target());
      if (resolved.ok) throw new Error("expected a configuration conflict");
      expect(resolved.error.message).toContain("little-endian Xtensa");
      expect(resolved.error).toMatchObject({
        _tag: "ConfigurationError",
        settings: [{ setting }],
      });
    },
  );

  it("keeps a caller selection that matches the pin as configured", async () => {
    const resolved = await ghidra({
      GHIDRA_INSTALL_DIR: await xtensaInstallation(),
      REA_GHIDRA_LANGUAGE_ID: "Xtensa:LE:32:default",
      REA_GHIDRA_COMPILER_SPEC_ID: "default",
    }).resolveAnalysisProfile(target());
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.profile?.parameters).toMatchObject({
      language_id: "Xtensa:LE:32:default",
      compiler_spec_id: "default",
      language_selection: "configured-v1",
    });
  });

  it("keeps the pinned compiler spec when the caller names only the language", async () => {
    const launches: GhidraClientOptions[] = [];
    const provider = ghidra(
      {
        GHIDRA_INSTALL_DIR: await xtensaInstallation(),
        REA_GHIDRA_LANGUAGE_ID: "Xtensa:LE:32:default",
      },
      capturingFactory(launches),
    );
    const resolved = await provider.resolveAnalysisProfile(target());
    if (!resolved.ok) throw resolved.error;
    if (resolved.value.profile === null)
      throw new Error("expected an Xtensa profile");
    const { parameters } = resolved.value.profile;
    expect(parameters).toMatchObject({
      language_id: "Xtensa:LE:32:default",
      compiler_spec_id: "default",
      language_selection: "configured-v1",
    });
    expect(ghidraProfileLanguageOverride(parameters)).toEqual(PINNED);
    const client = provider.createClient(target(), resolved.value.profile);
    try {
      expect((await client.execute("health", {})).ok).toBe(true);
    } finally {
      await client.close();
    }
    expect(launches).toEqual([pinnedLaunch]);
  });

  it("completes only partial Xtensa overrides of the pinned language", () => {
    const languageOnly = { languageId: "RISCV:LE:64:default" };
    const riscv: BinaryTarget = {
      path: "/riscv.elf",
      sha256: "c".repeat(64),
      kind: "executable",
      format: "elf",
      architecture: "riscv",
      availableArchitectures: ["riscv"],
      riscv: { elfClass: 64, byteOrder: "little", type: 2, flags: 0x5 },
    };
    // Older pinned lanes keep their committed language-default profiles.
    expect(ghidraEffectiveLanguageOverride(riscv, languageOnly)).toBe(
      languageOnly,
    );
    const otherLanguage = { languageId: "Xtensa:BE:32:default" };
    expect(ghidraEffectiveLanguageOverride(target(), otherLanguage)).toBe(
      otherLanguage,
    );
    expect(
      ghidraEffectiveLanguageOverride(target(), undefined),
    ).toBeUndefined();
  });
};

const registerProviderCases = () => {
  it("delivers the pinned language and the measured SALT/SALTU gap with results", async () => {
    const provider = ghidra({}, capturingFactory([]));
    const resolved = await provider.resolveAnalysisProfile(target());
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected an Xtensa profile");
    const client = provider.createClient(target(), resolved.value.profile);
    let delivered: readonly string[] = [];
    try {
      const health = await client.execute("health", {});
      if (!health.ok) throw health.error;
      delivered = health.value.limitations;
    } finally {
      await client.close();
    }
    expect(delivered).toEqual(
      expect.arrayContaining([...ghidraXtensaLimitations(target())]),
    );
    // Facts, independent of the owner's wording: the pin, and the provenance
    // of the one Ghidra gap REA reproduced rather than took from upstream.
    expect(delivered).toContainEqual(
      expect.stringContaining(PINNED.languageId),
    );
    expect(delivered).toContainEqual(
      expect.stringMatching(/^Measured by REA: .*\bSALT\b.*\bSALTU\b/su),
    );
    expect(
      ghidraXtensaLimitations({
        path: "/other.elf",
        sha256: "b".repeat(64),
        kind: "executable",
        format: "elf",
        architecture: "x86_64",
        availableArchitectures: ["x86_64"],
      }),
    ).toEqual([]);
  });

  it("names Xtensa when Hopper, IDA and Kuna decline it", () => {
    const hopper = new HopperProvider(configFor(), silentLogger, {}, "linux");
    const hopperSupport = hopper.inspectTargetSupport(target());
    expect(hopperSupport).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
      reason: expect.stringMatching(/xtensa/iu),
    });
    expect(hopperSupport.reason).toContain("Ghidra");
    expect(hopperLoaderArgsForTarget(target())).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/xtensa/iu) },
    });
    const ida = new IdaProvider(configFor(), {}).inspectTargetSupport(target());
    expect(ida).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
      reason: expect.stringMatching(/no verified xtensa lane/iu),
    });
    expect(new KunaProvider({}).inspectTargetSupport(target())).toMatchObject({
      status: "unsupported",
      code: "architecture_unsupported",
    });
  });
};

describe("bounded Ghidra Xtensa admission", () => {
  registerPinCases();
  registerRefusalCases();
  registerOverrideCases();
  registerProviderCases();
});
