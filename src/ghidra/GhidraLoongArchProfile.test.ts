import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/parseConfig.js";
import type {
  BinaryTarget,
  LoongArchElfMetadata,
} from "../domain/binaryTargetTypes.js";
import { ok } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { hopperLoaderArgsForTarget } from "../hopper/HopperAnalysisProfile.js";
import { IdaProvider } from "../ida/IdaProvider.js";
import {
  GHIDRA_LOONGARCH_LANGUAGE,
  ghidraLoongArchLanguage,
  ghidraLoongArchLimitations,
  ghidraLoongArchProfileMismatchReason,
  ghidraLoongArchProfileParameters,
  ghidraLoongArchUnsupportedReason,
} from "./GhidraLoongArchProfile.js";
import {
  ghidraPinnedLanguage,
  ghidraProfileLanguageOverride,
} from "./GhidraAnalysisProfile.js";
import { GhidraProvider } from "./GhidraProvider.js";
import type { GhidraSessionInfo } from "./GhidraSessionValues.js";
import { GHIDRA_SESSION_CAPABILITIES } from "./GhidraSessionValues.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";

const configFor = (environment: NodeJS.ProcessEnv) => {
  const parsed = parseConfig({ GHIDRA_INSTALL_DIR: "/ghidra", ...environment });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const config = configFor({});

const metadata = (
  change: Partial<LoongArchElfMetadata> = {},
): LoongArchElfMetadata => ({
  elfClass: 64,
  byteOrder: "little",
  type: 3,
  flags: 0x43,
  floatAbi: "double",
  objectAbiVersion: 1,
  undeclaredFlags: 0,
  ...change,
});

const target = (change: Partial<LoongArchElfMetadata> = {}): BinaryTarget => ({
  path: "/fixture.so",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "loongarch",
  availableArchitectures: ["loongarch"],
  loongarch: metadata(change),
});

/** Swap the derived fields with the declaration the changed header would parse. */
const declared = (change: Partial<LoongArchElfMetadata>): BinaryTarget => {
  const value = metadata(change);
  const flags = change.flags ?? value.flags;
  return target({
    ...value,
    floatAbi:
      change.floatAbi ??
      ((flags & 0x7) === 1
        ? "soft"
        : (flags & 0x7) === 2
          ? "single"
          : (flags & 0x7) === 3
            ? "double"
            : (flags & 0x7) === 0
              ? "unspecified"
              : "reserved"),
    objectAbiVersion: change.objectAbiVersion ?? ((flags & 0x40) === 0 ? 0 : 1),
    undeclaredFlags: change.undeclaredFlags ?? (flags & ~0x47) >>> 0,
    flags,
  });
};

describe("bounded Ghidra LoongArch admission", () => {
  it("admits the new-world declaration and pins LP64D", async () => {
    const ghidra = new GhidraProvider(config, silentLogger, {}, host);
    expect(await ghidra.inspectAvailability()).toMatchObject({
      status: "available",
    });
    expect(ghidra.inspectTargetSupport(target()).status).toBe("supported");
    const resolved = await ghidra.resolveAnalysisProfile(target());
    if (!resolved.ok) throw resolved.error;
    const parameters = resolved.value.profile?.parameters ?? {};
    expect(parameters).toMatchObject({
      architecture: "loongarch",
      language_id: "Loongarch:LE:64:lp64d",
      compiler_spec_id: "default",
      language_selection: "provider-pinned-v1",
      loongarch_elf: {
        elf_class: 64,
        byte_order: "little",
        type: 3,
        flags: 0x43,
        float_abi: "double",
        object_abi_version: 1,
        object_abi_convention: "new-world",
        undeclared_flags: 0,
      },
      loongarch_support_lane: "elf64-le-dyn-lp64d-objabi-v1-generic-v1",
    });
    expect(ghidraPinnedLanguage(target())).toEqual({
      languageId: "Loongarch:LE:64:lp64d",
      compilerSpecId: "default",
    });
    expect(ghidraProfileLanguageOverride(parameters)).toEqual(
      ghidraPinnedLanguage(target()),
    );
  });

  it("admits the old-world declaration with the same pinned language", async () => {
    const value = declared({ flags: 0x3 });
    expect(ghidraLoongArchUnsupportedReason(value)).toBeNull();
    expect(ghidraLoongArchLanguage(value)).toEqual(GHIDRA_LOONGARCH_LANGUAGE);
    expect(ghidraLoongArchProfileParameters(value)).toMatchObject({
      loongarch_elf: {
        flags: 0x3,
        object_abi_version: 0,
        object_abi_convention: "old-world",
      },
      loongarch_support_lane: "elf64-le-dyn-lp64d-objabi-v0-generic-v1",
    });
    const ghidra = new GhidraProvider(config, silentLogger, {}, host);
    const resolved = await ghidra.resolveAnalysisProfile(value);
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.profile?.parameters.language_id).toBe(
      "Loongarch:LE:64:lp64d",
    );
  });

  it("distinguishes both worlds and both load models in the profile digest", async () => {
    const profiles = await Promise.all(
      [
        target({ flags: 0x43, objectAbiVersion: 1 }),
        declared({ flags: 0x3 }),
        target({ type: 2 }),
      ].map(async (value) => {
        const resolved = await new GhidraProvider(
          config,
          silentLogger,
          {},
          host,
        ).resolveAnalysisProfile(value);
        if (!resolved.ok) throw resolved.error;
        return {
          lane: resolved.value.profile?.parameters.loongarch_support_lane,
          digest: resolved.value.profile?.digest,
        };
      }),
    );
    expect(profiles.map((profile) => profile.lane)).toEqual([
      "elf64-le-dyn-lp64d-objabi-v1-generic-v1",
      "elf64-le-dyn-lp64d-objabi-v0-generic-v1",
      "elf64-le-exec-lp64d-objabi-v1-generic-v1",
    ]);
    expect(new Set(profiles.map((profile) => profile.digest)).size).toBe(3);
  });
});

describe("bounded Ghidra LoongArch profile identity", () => {
  it("states the declared world, the pin and shared-object relocation limits", () => {
    const newWorld = ghidraLoongArchLimitations(target());
    expect(newWorld).toContainEqual(expect.stringMatching(/LP64D/u));
    expect(newWorld).toContainEqual(
      expect.stringMatching(/EF_LARCH_OBJABI_V1.*new world/u),
    );
    expect(newWorld).toContainEqual(
      expect.stringMatching(/R_LARCH_RELATIVE.*R_LARCH_JUMP_SLOT/u),
    );
    expect(newWorld).toContainEqual(
      expect.stringMatching(/TLS DTPMOD\/DTPREL\/TPREL/u),
    );
    const oldWorld = ghidraLoongArchLimitations(declared({ flags: 0x3 }));
    expect(oldWorld).toContainEqual(expect.stringMatching(/old world/u));
    // A fixed-address image carries no runtime-load relocation claim.
    expect(ghidraLoongArchLimitations(target({ type: 2 }))).not.toContainEqual(
      expect.stringContaining("runtime load addresses"),
    );
  });

  it("does not widen Windows P0", () => {
    const windows = new GhidraProvider(
      config,
      silentLogger,
      {},
      { ...host, platform: "win32" },
    );
    expect(windows.inspectTargetSupport(target()).status).toBe("unsupported");
  });

  it.each([
    [{ elfClass: 32 }, "ELF64"],
    [{ byteOrder: "big" }, "little-endian"],
    [{ type: 1 }, "ET_EXEC and ET_DYN"],
    [{ type: 4 }, "e_type 4"],
    [{ flags: 0x1, floatAbi: "soft" }, "soft-float"],
    [{ flags: 0x2, floatAbi: "single" }, "single-float"],
    [{ flags: 0x0, floatAbi: "unspecified" }, "no floating-point ABI"],
    [{ flags: 0x4, floatAbi: "reserved" }, "reserved floating-point"],
    [{ flags: 0x83, undeclaredFlags: 0x80 }, "0x80"],
  ] satisfies [Partial<LoongArchElfMetadata>, string][])(
    "refuses an unverified LoongArch interpretation %j",
    async (change, reason) => {
      const value = declared(change);
      expect(ghidraLoongArchUnsupportedReason(value)).toContain(reason);
      expect(ghidraLoongArchLanguage(value)).toBeUndefined();
      const ghidra = new GhidraProvider(config, silentLogger, {}, host);
      expect(ghidra.inspectTargetSupport(value)).toMatchObject({
        status: "unsupported",
        reason: expect.stringContaining(reason),
      });
      const resolved = await ghidra.resolveAnalysisProfile(value);
      expect(resolved).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisUnsupportedTargetError",
          reason: expect.stringContaining(reason),
        },
      });
    },
  );

  it("refuses a configured language outside the pinned LP64D lane", async () => {
    const resolved = await new GhidraProvider(
      configFor({ REA_GHIDRA_LANGUAGE_ID: "Loongarch:LE:64:lp64f" }),
      silentLogger,
      {},
      host,
    ).resolveAnalysisProfile(target());
    if (resolved.ok) throw new Error("expected a configuration conflict");
    expect(resolved.error).toMatchObject({
      _tag: "ConfigurationError",
      settings: [{ setting: "REA_GHIDRA_LANGUAGE_ID" }],
    });
    expect(resolved.error.message).toContain(
      "little-endian ELF64 LP64D LoongArch",
    );
  });

  it("binds a committed profile to the target it was resolved for", () => {
    const newWorld = ghidraLoongArchProfileParameters(target());
    const oldWorld = declared({ flags: 0x3 });
    expect(
      ghidraLoongArchProfileMismatchReason(oldWorld, newWorld, false),
    ).toContain("different target");
    // An existing-project profile carries the target's ELF declarations but no
    // lane token, so the lane check is skipped while metadata still binds.
    expect(
      ghidraLoongArchProfileMismatchReason(oldWorld, newWorld, true),
    ).toContain("ELF declarations");
    const changedFlags = ghidraLoongArchProfileParameters(
      target({ flags: 0x1043, undeclaredFlags: 0x1000 }),
    );
    expect(
      ghidraLoongArchProfileMismatchReason(
        target({ flags: 0x1043, undeclaredFlags: 0x1000 }),
        changedFlags,
        false,
      ),
    ).toBeNull();
    expect(
      ghidraLoongArchProfileMismatchReason(target(), changedFlags, false),
    ).toContain("ELF declarations");
  });

  it("refuses a session whose committed lane disagrees with its target", async () => {
    let starts = 0;
    const provider = new GhidraProvider(config, silentLogger, {}, host, () => ({
      start: () => {
        starts += 1;
        return Promise.resolve(ok(sessionInfo()));
      },
      callTool: () => Promise.resolve(ok(null)),
      close: () => Promise.resolve(ok(null)),
    }));
    const resolved = await provider.resolveAnalysisProfile(target());
    if (!resolved.ok || resolved.value.profile === null)
      throw new Error("expected a LoongArch profile");
    const client = provider.createClient(
      declared({ flags: 0x3 }),
      resolved.value.profile,
    );
    const health = await client.execute("health", {});
    expect(health.ok).toBe(false);
    if (!health.ok) expect(health.error._tag).toBe("ProviderAdapterError");
    expect(starts).toBe(0);
  });

  it("keeps LoongArch out of unverified Hopper and IDA adapter lanes", () => {
    const hopper = new HopperProvider(config, silentLogger, {}, "linux");
    expect(hopper.inspectTargetSupport(target()).status).toBe("unsupported");
    expect(hopperLoaderArgsForTarget(target()).ok).toBe(false);
    const ida = new IdaProvider(config, {});
    expect(ida.inspectTargetSupport(target()).status).toBe("unsupported");
  });
});

const sessionInfo = (): GhidraSessionInfo => ({
  name: "REA Ghidra bridge",
  run_id: "11111111-1111-4111-8111-111111111111",
  profile_digest: "a".repeat(64),
  provider: { id: "ghidra", version: "12.1.4" },
  read_only: false,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
  target: {
    name: "fixture.so",
    language_id: "Loongarch:LE:64:lp64d",
    compiler_spec_id: "default",
    image_base: "0x100000",
    default_address_space: "ram",
    sha256: "a".repeat(64),
  },
});
