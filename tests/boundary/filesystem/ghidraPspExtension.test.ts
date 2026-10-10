import { mkdir, rename, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { silentLogger } from "../../../src/logger.js";
import type {
  BinaryTarget,
  MipsAbiFlags,
} from "../../../src/domain/binaryTargetTypes.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { GhidraProvider } from "../../../src/ghidra/GhidraProvider.js";
import { ghidraProcessorUnsupportedReason } from "../../../src/ghidra/GhidraPspProfile.js";
import { inspectGhidraPspExtension } from "../../../src/ghidra/GhidraPspExtension.js";
import {
  GhidraHeadlessLauncher,
  ghidraHeadlessArguments,
} from "../../../src/ghidra/GhidraLauncher.js";
import type { GhidraInstallationHost } from "../../../src/ghidra/GhidraInstallation.js";

// Synthetic installation files exercise the filesystem/profile boundary, not
// Allegrex execution. Only the optional real CLI/MCP lane proves tool behavior.
// Independently inspected with PSPDEV v20261001 / GNU readelf 2.44.
const pspAbiFlags: MipsAbiFlags = {
  version: 0,
  isaLevel: 2,
  isaRevision: 0,
  gprSize: 1,
  cpr1Size: 1,
  cpr2Size: 0,
  fpAbi: 2,
  isaExtension: 0,
  ases: 0,
  flags1: 1,
  flags2: 0,
};
const target = {
  kind: "executable",
  format: "elf",
  architecture: "mips",
  availableArchitectures: ["mips"],
  path: "/caller/psp.elf",
  sha256: "a".repeat(64),
  mips: {
    elfClass: 32,
    byteOrder: "little",
    type: 2,
    flags: 0x10a23001,
    abiFlags: pspAbiFlags,
  },
} satisfies BinaryTarget;
const host: GhidraInstallationHost = {
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.3\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.12",
    major: 21,
    home: "/jdk-21",
    bits: 64,
    runtime: "jdk",
  }),
};
async function installation() {
  const directory = await createTestTempDirectory("rea-psp-profile-");
  const root = join(directory, "Ghidra", "Extensions", "ghidra-allegrex");
  const contents = {
    "Module.manifest": "",
    "extension.properties": "name=ghidra-allegrex\nversion=12.1.3\n",
    "data/languages/allegrex.ldefs": "synthetic language definition",
    "data/languages/allegrex.sla": "synthetic compiled processor",
    "data/languages/allegrex.pspec": "synthetic processor specification",
    "data/languages/allegrex.cspec": "synthetic compiler specification",
    "lib/extension.jar": "synthetic loader artifact",
  };
  for (const [path, text] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await mkdir(join(directory, "support"));
  const parsed = parseConfig({ GHIDRA_INSTALL_DIR: directory });
  if (!parsed.ok) throw parsed.error;
  return {
    directory,
    root,
    config: parsed.value,
    provider: new GhidraProvider(parsed.value, silentLogger, {}, host),
  };
}

describe.skipIf(process.platform === "win32")(
  "PSP installed-extension and profile boundary",
  () => {
    it("binds source interpretation and installed content, not mtimes or discovery order", async () => {
      const { provider, root } = await installation();
      expect(provider.inspectTargetSupport(target).status).toBe("supported");
      const first = await provider.resolveAnalysisProfile(target);
      if (!first.ok) throw first.error;
      const again = await provider.resolveAnalysisProfile(target);
      if (!again.ok) throw again.error;
      expect(again.value.profile?.digest).toBe(first.value.profile?.digest);
      expect(first.value.profile?.parameters).toMatchObject({
        architecture: "mips",
        language_id: "Allegrex:LE:32:default",
        compiler_spec_id: "default",
        loader: "PspElfLoader",
        mips_support_lane: "psp-elf32-exec-eabi32-allegrex-v2",
        mips_elf: {
          elf_class: 32,
          byte_order: "little",
          type: 2,
          flags: 0x10a23001,
          abi_flags: {
            version: 0,
            isa_level: 2,
            isa_revision: 0,
            gpr_size: 1,
            cpr1_size: 1,
            cpr2_size: 0,
            fp_abi: 2,
            isa_extension: 0,
            ases: 0,
            flags1: 1,
            flags2: 0,
          },
        },
        psp_extension: {
          id: "ghidra-allegrex",
          root,
          ghidra_version: "12.1.3",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      await writeFile(
        join(root, "data/languages/allegrex.sla"),
        "changed processor semantics",
      );
      const changed = await provider.resolveAnalysisProfile(target);
      if (!changed.ok) throw changed.error;
      expect(changed.value.profile?.digest).not.toBe(
        first.value.profile?.digest,
      );
    });

    it("fails before starting a provider after resolved extension bytes change", async () => {
      const { directory, root } = await installation();
      const extension = await inspectGhidraPspExtension(root, "12.1.3");
      await writeFile(join(root, "lib/extension.jar"), "changed loader");
      const spawn = vi.fn();
      const launcher = new GhidraHeadlessLauncher({
        environment: {},
        analyzeHeadlessPath: join(directory, "support/analyzeHeadless"),
        javaHome: "/jdk-21",
        bridgeScriptPath: "/packaged/ReaGhidraBridge.java",
        pspExtension: extension,
        spawnProcess: spawn,
      });
      const launched = await launcher.launch({
        runtimeRoot: join(directory, "runtime"),
        transport: "unix-socket",
        endpointPath: join(directory, "socket"),
        token: "test-only-token",
        runId: "00000000-0000-4000-8000-000000000001",
        targetPath: target.path,
        targetSha256: target.sha256,
        providerVersion: "12.1.3",
        profileDigest: "b".repeat(64),
      });
      expect(launched.ok).toBe(false);
      if (launched.ok)
        throw new Error("Changed extension reached provider startup");
      expect(launched.error.cause).toBeInstanceOf(Error);
      expect(String(launched.error.cause)).toContain(
        "changed since profile resolution",
      );
      expect(spawn).not.toHaveBeenCalled();
    });

    it("requires a fresh extension when a saved profile's installation has disappeared", async () => {
      const { provider, root } = await installation();
      const before = await provider.resolveAnalysisProfile(target);
      if (!before.ok) throw before.error;
      await rename(root, `${root}-removed`);
      const missing = await provider.resolveAnalysisProfile(target);
      expect(missing.ok).toBe(false);
      if (missing.ok) throw new Error("Missing installation was accepted");
      expect(missing.error.message).toContain("PSP_EXTENSION_UNAVAILABLE");
    });

    it.each([
      ["name=other\nversion=12.1.3\n", "does not match"],
      ["name=ghidra-allegrex\nversion=12.1.4\n", "does not match"],
      [
        "name=ghidra-allegrex\nversion=12.1.3\nversion=12.1.3\n",
        "exactly one version",
      ],
    ])(
      "rejects incompatible or ambiguous extension metadata %s",
      async (properties, reason) => {
        const { root } = await installation();
        await writeFile(join(root, "extension.properties"), properties);
        await expect(inspectGhidraPspExtension(root, "12.1.3")).rejects.toThrow(
          reason,
        );
      },
    );

    it("does not treat an uninstall marker or missing compiled language as installed", async () => {
      const { root } = await installation();
      await rename(
        join(root, "Module.manifest"),
        join(root, "Module.manifest.uninstalled"),
      );
      await expect(inspectGhidraPspExtension(root, "12.1.3")).rejects.toThrow(
        "Module.manifest",
      );
    });

    it("rejects symlinked code instead of hashing an untracked external producer", async () => {
      const { root, directory } = await installation();
      const path = join(root, "lib/extension.jar");
      await rename(path, join(directory, "external.jar"));
      await symlink(join(directory, "external.jar"), path);
      await expect(inspectGhidraPspExtension(root, "12.1.3")).rejects.toThrow(
        "regular files",
      );
    });

    it("bounds sparse extension input before reading or allocating its declared extent", async () => {
      const { root } = await installation();
      await truncate(join(root, "lib/extension.jar"), 64 * 1024 * 1024 + 1);
      await expect(inspectGhidraPspExtension(root, "12.1.3")).rejects.toThrow(
        "inspection limit",
      );
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "PSP admission failures and explicit loader",
  () => {
    it("preserves already-aborted cancellation rather than reporting missing prerequisites", async () => {
      const { provider } = await installation();
      const result = await provider.resolveAnalysisProfile(target, {
        signal: AbortSignal.abort(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Cancellation was ignored");
      expect(result.error._tag).toBe("AnalysisCancelledError");
    });

    it("does not broaden the separately verified host platforms", async () => {
      const { config } = await installation();
      for (const platform of ["darwin", "win32"] as const) {
        const provider = new GhidraProvider(
          config,
          silentLogger,
          {},
          { ...host, platform },
        );
        expect(provider.inspectTargetSupport(target).status).toBe(
          "unsupported",
        );
      }
    });

    it.each([
      [{ byteOrder: "big" }, "little-endian"],
      [{ elfClass: 64 }, "ELF32"],
      [{ type: 0xffa0 }, "ET_EXEC"],
      [{ flags: 0x12a23001 }, "0x10a23001"],
      [{ flags: 0x10a23021 }, "0x10a23001"],
    ])(
      "refuses unverified PSP declarations %j before extension reads",
      async (change, reason) => {
        const { provider } = await installation();
        const altered = {
          ...target,
          mips: { ...target.mips, ...change },
        } as BinaryTarget;
        expect(ghidraProcessorUnsupportedReason(altered)).toContain(reason);
        expect(provider.inspectTargetSupport(altered).status).toBe(
          "unsupported",
        );
        const result = await provider.resolveAnalysisProfile(altered);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Invalid target was admitted");
        expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
      },
    );
  },
);

describe.skipIf(process.platform === "win32")(
  "PSP inspected ABI declaration boundary",
  () => {
    it("retains independently inspected PSP ABI bytes through the real target reader", async () => {
      const { directory, provider } = await installation();
      const abiOffset = 8192;
      const bytes = Buffer.alloc(abiOffset + 24);
      bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
      bytes.writeUInt16LE(2, 16);
      bytes.writeUInt16LE(8, 18);
      bytes.writeUInt32LE(1, 20);
      bytes.writeUInt32LE(52, 28);
      bytes.writeUInt32LE(0x10a23001, 36);
      bytes.writeUInt16LE(52, 40);
      bytes.writeUInt16LE(32, 42);
      bytes.writeUInt16LE(1, 44);
      bytes.writeUInt32LE(0x70000003, 52);
      bytes.writeUInt32LE(abiOffset, 56);
      bytes.writeUInt32LE(24, 68);
      bytes.writeUInt32LE(24, 72);
      // GNU readelf -x .MIPS.abiflags, not bytes generated by REA.
      bytes.set(
        Buffer.from("000002000101000200000000000000000100000000000000", "hex"),
        abiOffset,
      );
      const path = join(directory, "psp-with-abi.elf");
      await writeFile(path, bytes);
      const parsed = await parseBinaryTarget(path);
      if (!parsed.ok) throw parsed.error;
      if (
        parsed.value.kind !== "executable" ||
        parsed.value.architecture !== "mips"
      )
        throw new Error("PSP ELF was not recognized as MIPS");
      expect(parsed.value.mips.abiFlags).toEqual(pspAbiFlags);
      expect(provider.inspectTargetSupport(parsed.value).status).toBe(
        "supported",
      );
      const profile = await provider.resolveAnalysisProfile(parsed.value);
      if (!profile.ok) throw profile.error;
      expect(profile.value.profile?.parameters.mips_elf).toMatchObject({
        flags: 0x10a23001,
        abi_flags: { isa_level: 2, fp_abi: 2, flags1: 1 },
      });
    });

    it.each([
      ["version", 1],
      ["isaLevel", 32],
      ["isaRevision", 1],
      ["gprSize", 2],
      ["cpr1Size", 2],
      ["cpr2Size", 1],
      ["fpAbi", 1],
      ["fpAbi", 3],
      ["fpAbi", 5],
      ["isaExtension", 1],
      ["ases", 1],
      ["flags1", 0],
      ["flags1", 3],
      ["flags2", 1],
    ] satisfies [keyof MipsAbiFlags, number][])(
      "rejects unverified PSP ABI field %s=%i before extension discovery",
      async (field, value) => {
        const { provider, root } = await installation();
        await rename(root, `${root}-unavailable`);
        const altered: Extract<BinaryTarget, { architecture: "mips" }> = {
          ...target,
          mips: {
            elfClass: 32,
            byteOrder: "little",
            type: 2,
            flags: 0x10a23001,
            abiFlags: { ...pspAbiFlags, [field]: value },
          },
        };
        expect(provider.inspectTargetSupport(altered).status).toBe(
          "unsupported",
        );
        const result = await provider.resolveAnalysisProfile(altered);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Invalid ABI was admitted");
        expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
        expect(result.error.message).toContain(
          "separate MIPS ABI flags record",
        );
      },
    );

    it.each([undefined, null])(
      "does not guess an uninspected or absent PSP ABI record: %s",
      async (abiFlags) => {
        const { provider, root } = await installation();
        await rename(root, `${root}-unavailable`);
        const altered: Extract<BinaryTarget, { architecture: "mips" }> = {
          ...target,
          mips: {
            elfClass: 32,
            byteOrder: "little",
            type: 2,
            flags: 0x10a23001,
            ...(abiFlags === undefined ? {} : { abiFlags }),
          },
        };
        const result = await provider.resolveAnalysisProfile(altered);
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Missing ABI was inferred");
        expect(result.error._tag).toBe("AnalysisUnsupportedTargetError");
        expect(result.error.message).toContain(
          "inspected separate MIPS ABI flags record",
        );
      },
    );
  },
);

describe.skipIf(process.platform === "win32")(
  "PSP explicit loader boundary",
  () => {
    it("forces the PSP loader/language only for the selected profile", () => {
      const paths = {
        projectRoot: "/project",
        targetPath: "/target.elf",
        bridgeScriptPath: "/bridge/Rea.java",
        descriptorPath: "/session",
        ghidraLogPath: "/log",
        scriptLogPath: "/scriptlog",
      };
      expect(ghidraHeadlessArguments({ ...paths, psp: true })).toEqual(
        expect.arrayContaining([
          "-loader",
          "PspElfLoader",
          "-processor",
          "Allegrex:LE:32:default",
          "-cspec",
          "default",
        ]),
      );
      expect(ghidraHeadlessArguments(paths)).not.toContain(
        "Allegrex:LE:32:default",
      );
    });
  },
);
