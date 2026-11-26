import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { inspectPeResourcesInputSchema } from "../../../src/domain/native/peResources.js";
import { inspectPeCertificatesInputSchema } from "../../../src/domain/native/peCertificates.js";
import { inspectPeImportsInputSchema } from "../../../src/domain/native/peImports.js";
import { inspectElfNotesInputSchema } from "../../../src/domain/native/elfNotes.js";
import { inspectKernelBuildConfigInputSchema } from "../../../src/domain/native/kernelBuildConfig.js";
import { KernelBuildConfigProvider } from "../../../src/native/elf/KernelBuildConfigProvider.js";
import { kernelBuildConfigFixture } from "../../../src/native/elf/KernelBuildConfig.fixture.js";
import { inspectKernelModuleInputSchema } from "../../../src/domain/native/kernelModule.js";
import { inspectElfDependenciesInputSchema } from "../../../src/domain/native/elfDependencies.js";
import { inspectNativeExportsInputSchema } from "../../../src/domain/native/nativeExports.js";
import { inspectAppleIpsInputSchema } from "../../../src/domain/native/appleIps.js";
import { inspectWindowsShortcutInputSchema } from "../../../src/domain/native/windowsShortcut.js";
import { inspectApkSignatureInputSchema } from "../../../src/domain/apkSignature/apkSignatureQuery.js";
import { PeResourcesProvider } from "../../../src/native/pe/PeResourcesProvider.js";
import { PeCertificatesProvider } from "../../../src/native/pe/PeCertificatesProvider.js";
import { PeImportsProvider } from "../../../src/native/pe/PeImportsProvider.js";
import { elfNoteFixture } from "../../../src/native/elf/ElfNotes.fixture.js";
import { ElfNotesProvider } from "../../../src/native/elf/ElfNotesProvider.js";
import { kernelModuleFixture } from "../../../src/native/elf/KernelModule.fixture.js";
import { KernelModuleProvider } from "../../../src/native/elf/KernelModuleProvider.js";
import { elfDependencyFixture } from "../../../src/native/elf/ElfDependencies.fixture.js";
import { ElfDependenciesProvider } from "../../../src/native/elf/ElfDependenciesProvider.js";
import { NativeExportsProvider } from "../../../src/native/exports/NativeExportsProvider.js";
import { AppleIpsProvider } from "../../../src/native/apple/AppleIpsProvider.js";
import { WindowsShortcutProvider } from "../../../src/native/windows/WindowsShortcutProvider.js";
import { ApkSignatureProvider } from "../../../src/apkSignature/ApkSignatureProvider.js";
import { peResourceFixture } from "../../../src/domain/pe/peResources.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const inspectionFactory =
  <Input, Inspection>(
    Provider: new () => {
      inspect: (input: Input, options: { signal: AbortSignal }) => Inspection;
      close(): Promise<void>;
    },
    schema: { parse(value: { path: string }): Input },
  ) =>
  () => {
    const provider = new Provider();
    return {
      inspect: (path: string, signal: AbortSignal) =>
        provider.inspect(schema.parse({ path }), { signal }),
      close: () => provider.close(),
    };
  };

const cases = [
  {
    name: "PE resources",
    make: inspectionFactory(PeResourcesProvider, inspectPeResourcesInputSchema),
  },
  {
    name: "PE certificates",
    make: inspectionFactory(
      PeCertificatesProvider,
      inspectPeCertificatesInputSchema,
    ),
  },
  {
    name: "PE imports",
    make: inspectionFactory(PeImportsProvider, inspectPeImportsInputSchema),
  },
  {
    name: "ELF notes",
    fixture: elfNoteFixture,
    report: {
      entries: expect.arrayContaining([
        expect.objectContaining({ type_name: "gnu_build_id" }),
      ]),
    },
    make: inspectionFactory(ElfNotesProvider, inspectElfNotesInputSchema),
  },
  {
    name: "kernel build config",
    fixture: kernelBuildConfigFixture,
    report: { config: { status: "present", option_count: 9 } },
    make: inspectionFactory(
      KernelBuildConfigProvider,
      inspectKernelBuildConfigInputSchema,
    ),
  },
  {
    name: "kernel modules",
    fixture: kernelModuleFixture,
    report: { applicability: "applicable", signature: { status: "present" } },
    make: inspectionFactory(
      KernelModuleProvider,
      inspectKernelModuleInputSchema,
    ),
  },
  {
    name: "ELF dependencies",
    fixture: elfDependencyFixture,
    report: {
      needed: expect.arrayContaining([
        expect.objectContaining({ name: "libc.so.6" }),
      ]),
    },
    make: inspectionFactory(
      ElfDependenciesProvider,
      inspectElfDependenciesInputSchema,
    ),
  },
  {
    name: "native exports",
    make: inspectionFactory(
      NativeExportsProvider,
      inspectNativeExportsInputSchema,
    ),
  },
  {
    name: "Apple IPS",
    make: inspectionFactory(AppleIpsProvider, inspectAppleIpsInputSchema),
  },
  {
    name: "Windows shortcut",
    make: inspectionFactory(
      WindowsShortcutProvider,
      inspectWindowsShortcutInputSchema,
    ),
  },
  {
    name: "APK signatures",
    make: inspectionFactory(
      ApkSignatureProvider,
      inspectApkSignatureInputSchema,
    ),
  },
] as const;

const modes = [
  "close-failure",
  "close-cancel",
  "close-cancel-null",
  "close-both",
] as const;

it.each(cases.flatMap((entry) => modes.map((mode) => ({ ...entry, mode }))))(
  "retains completed $name acquisition through $mode",
  async (entry) => {
    const { make, mode } = entry;
    const root = await createTestTempDirectory("rea-native-finalization-");
    const path = join(root, "selected.bin");
    const bytes =
      "fixture" in entry ? entry.fixture() : peResourceFixture().bytes;
    await writeFile(path, bytes);
    const controller = new AbortController();
    const reason =
      mode === "close-cancel-null" ? null : { request: "cancel during close" };
    const closeFailure = Object.assign(new Error("controlled close EIO"), {
      code: "EIO",
    });
    const original = OwnedFileHandle.prototype.close;
    let owner: OwnedFileHandle | undefined;
    const close = vi
      .spyOn(OwnedFileHandle.prototype, "close")
      .mockImplementationOnce(async function (this: OwnedFileHandle) {
        owner = this;
        if (mode !== "close-failure") controller.abort(reason);
        if (mode === "close-failure" || mode === "close-both")
          throw closeFailure;
        await original.call(this);
      });
    const provider = make();
    try {
      const result = await provider.inspect(path, controller.signal);
      if (result.ok) throw new Error("Expected finalization failure");
      const artifact = {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      };
      const observation = result.error.partialObservation;
      if ("report" in entry)
        expect(observation).toMatchObject({ artifact, ...entry.report });
      else
        expect(observation).toEqual({
          kind: "file-snapshot-hash",
          ...artifact,
        });
      expect(
        projectAnalysisError(result.error).details?.partial_observation,
      ).toEqual(observation);
      const failedClose = mode === "close-failure" || mode === "close-both";
      expect(result.error.cleanupIncomplete).toBe(failedClose);
      if (failedClose) expect(owner?.handle.fd).toBeGreaterThanOrEqual(0);
      if (mode !== "close-failure") {
        const primary = result.error.cleanupPrimary ?? result.error;
        expect(primary).toMatchObject({
          _tag: "AnalysisCancelledError",
          cause: reason,
        });
      }
      close.mockRestore();
      await provider.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(owner?.handle.fd).toBe(-1);
    } finally {
      close.mockRestore();
      await provider.close();
    }
  },
);
