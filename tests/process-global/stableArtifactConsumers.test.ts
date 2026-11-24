import { MavenGradleMetadataProvider } from "../../src/java/MavenGradleMetadataProvider.js";
import { MavenGradleMetadataService } from "../../src/application/java/MavenGradleMetadataService.js";
import { inspectMavenGradleMetadataInputSchema } from "../../src/domain/java/mavenGradleMetadata.js";
import { mavenPomFixture } from "../../src/java/MavenGradleMetadata.fixture.js";
import { unknownTarget } from "../../src/domain/targetIdentity.js";
import { PeLoadConfigProvider } from "../../src/native/pe/PeLoadConfigProvider.js";
import { createArtifactAnalysisResources } from "../../src/providers/artifactResourceFailure.js";
import { ReleaseExposureReader } from "../../src/artifacts/ReleaseExposureReader.js";
import { BinaryHardeningProvider } from "../../src/native/hardening/BinaryHardeningProvider.js";
import { inspectPeLoadConfigInputSchema } from "../../src/domain/native/peLoadConfig.js";
import { inspectBinaryHardeningInputSchema } from "../../src/domain/native/binaryHardening.js";
import { open, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ZipReader } from "@zip.js/zip.js";

const fault = vi.hoisted(() => ({
  path: "",
  blockNew: true,
  blocked: new Set<FileHandle>(),
  handles: [] as FileHandle[],
  onClose: undefined as (() => void) | undefined,
  readFailure: undefined as { cause: unknown } | undefined,
  laterReadFailure: undefined as
    | { position: number; cause: unknown }
    | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...arguments_: Parameters<typeof original.open>) => {
      const handle = await original.open(...arguments_);
      if (String(arguments_[0]) !== fault.path) return handle;
      const close = handle.close.bind(handle);
      fault.handles.push(handle);
      if (fault.blockNew) fault.blocked.add(handle);
      if (fault.readFailure !== undefined) {
        const failure = fault.readFailure;
        handle.stat = async () => {
          throw failure.cause;
        };
      }
      if (fault.laterReadFailure !== undefined) {
        const failure = fault.laterReadFailure;
        const read = handle.read.bind(handle) as (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => Promise<{ bytesRead: number }>;
        const instrumented = handle as unknown as { read: typeof read };
        let observedStart = false;
        instrumented.read = async (buffer, offset, length, position) => {
          if (observedStart && position > failure.position) throw failure.cause;
          const result = await read(buffer, offset, length, position);
          if (position === failure.position && result.bytesRead > 0)
            observedStart = true;
          return result;
        };
      }
      handle.close = async () => {
        fault.onClose?.();
        if (fault.blocked.has(handle))
          throw new Error("controlled Rust descriptor close failure");
        await close();
      };
      return handle;
    },
  };
});

import { RustBinaryProvider } from "../../src/rust/RustBinaryProvider.js";
import { RustBinaryService } from "../../src/application/rust/RustBinaryService.js";
import {
  AnalysisError,
  resolvedAnalysisError,
} from "../../src/domain/analysisErrorBase.js";
import { createEvidence, parseEvidence } from "../../src/domain/evidence.js";
import { retainedEvidenceReferenceSchema } from "../../src/domain/evidenceReference.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { ParseFailureError } from "../../src/domain/parseFailure.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisResourceConstraintError,
} from "../../src/domain/analysisErrorCore.js";
import {
  ArtifactFileCleanupFailure,
  mapArtifactFileFailure,
  artifactFilePrimaryFacts,
  withArtifactRegularFile,
} from "../../src/resources/ArtifactFileOperation.js";
import { AnalysisCleanupLease } from "../../src/resources/AnalysisCleanupLease.js";
import { translateArtifactFailure } from "../../src/resources/index.js";
import { OwnedFileHandle } from "../../src/filesystem/OwnedFileHandle.js";
import {
  OwnedRegularFileOperationFailure,
  RegularFileCleanupFailure,
  regularFileCancellation,
} from "../../src/filesystem/OwnedRegularFile.js";
import { RegularFileOperationCancelled } from "../../src/filesystem/RegularFile.js";
import { ArtifactResourceScope } from "../../src/resources/ArtifactResourceScope.js";
import { readStableArtifact } from "../../src/resources/readStableArtifact.js";
import { ArtifactAnalysisResources } from "../../src/process/ArtifactAnalysisResources.js";
import { readLinuxResourceLimits } from "../../src/process/LinuxResourceLimits.js";
import { LocalWebSourceLocationArtifacts } from "../../src/browser/assets/WebSourceLocationArtifacts.js";
import { ok } from "../../src/domain/result.js";
import {
  webSourceLocationArgs,
  webSourceLocationFixture,
} from "../fixtures/webSourceLocation.js";
import { ArtifactReaderFailure } from "../../src/resources/ArtifactReader.js";
import { GoBinaryProvider } from "../../src/go/GoBinaryProvider.js";
import { PythonPycProvider } from "../../src/python/PythonPycProvider.js";
import { inspectPythonPycInputSchema } from "../../src/domain/python/pythonPyc.js";
import { NugetNupkgProvider } from "../../src/nuget/NugetNupkgProvider.js";
import { NugetNupkgService } from "../../src/application/nuget/NugetNupkgService.js";
import { nugetNupkgFixture } from "../../src/nuget/NugetNupkg.fixture.js";
import { inspectNugetNupkgInputSchema } from "../../src/domain/nuget/nupkg.js";
import { PeResourcesProvider } from "../../src/native/pe/PeResourcesProvider.js";
import { Il2cppMetadataProvider } from "../../src/il2cpp/Il2cppMetadataProvider.js";
import { ElfNotesProvider } from "../../src/native/elf/ElfNotesProvider.js";
import { DwarfUnitsProvider } from "../../src/native/dwarf/DwarfUnitsProvider.js";
import { NativeInitializersProvider } from "../../src/native/initializers/NativeInitializersProvider.js";
import { ElfUnwindRangesProvider } from "../../src/native/elf/ElfUnwindRangesProvider.js";
import { AppleIpsProvider } from "../../src/native/apple/AppleIpsProvider.js";
import { KernelModuleProvider } from "../../src/native/elf/KernelModuleProvider.js";
import { ElfDebugLinkProvider } from "../../src/native/elf/ElfDebugLinkProvider.js";
import { ElfDependenciesProvider } from "../../src/native/elf/ElfDependenciesProvider.js";
import { KernelBuildConfigProvider } from "../../src/native/elf/KernelBuildConfigProvider.js";
import { PeCertificatesProvider } from "../../src/native/pe/PeCertificatesProvider.js";
import { PeImportsProvider } from "../../src/native/pe/PeImportsProvider.js";
import { PeRichHeaderProvider } from "../../src/native/pe/PeRichHeaderProvider.js";
import { WindowsShortcutProvider } from "../../src/native/windows/WindowsShortcutProvider.js";
import { NativeExportsProvider } from "../../src/native/exports/NativeExportsProvider.js";
import { BeamProvider } from "../../src/erlang/BeamProvider.js";
import { inspectElfNotesInputSchema } from "../../src/domain/native/elfNotes.js";
import { inspectDwarfUnitsInputSchema } from "../../src/domain/native/dwarfUnits.js";
import { inspectNativeInitializersInputSchema } from "../../src/domain/native/nativeInitializers.js";
import { inspectElfUnwindRangesInputSchema } from "../../src/domain/native/elfUnwindRanges.js";
import { inspectAppleIpsInputSchema } from "../../src/domain/native/appleIps.js";
import { inspectKernelModuleInputSchema } from "../../src/domain/native/kernelModule.js";
import { inspectElfDebugLinkInputSchema } from "../../src/domain/native/elfDebugLink.js";
import { inspectElfDependenciesInputSchema } from "../../src/domain/native/elfDependencies.js";
import { inspectKernelBuildConfigInputSchema } from "../../src/domain/native/kernelBuildConfig.js";
import { inspectPeCertificatesInputSchema } from "../../src/domain/native/peCertificates.js";
import { inspectPeImportsInputSchema } from "../../src/domain/native/peImports.js";
import { inspectPeRichHeaderInputSchema } from "../../src/domain/native/peRichHeader.js";
import { inspectWindowsShortcutInputSchema } from "../../src/domain/native/windowsShortcut.js";
import { inspectNativeExportsInputSchema } from "../../src/domain/native/nativeExports.js";
import { inspectErlangBeamInputSchema } from "../../src/domain/erlang/beam.js";
import { ModelArtifactProvider } from "../../src/model/ModelArtifactProvider.js";
import { ggufFixture, safetensorsFixture } from "../fixtures/model/model.js";
import { inspectPeResourcesInputSchema } from "../../src/domain/native/peResources.js";
import { peResourceFixture } from "../../src/domain/pe/peResources.fixture.js";
import { createServer } from "../../src/server/createServer.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import {
  createRustImage,
  RUSTC_HASH,
  rustDependencyPayload,
} from "../fixtures/rust/image.js";
import { createIl2cppMetadataFixture } from "../fixtures/il2cpp/metadata.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { mcpTest } from "../support/mcp/mcpFixture.js";

beforeEach(() => {
  fault.path = "";
  fault.blockNew = true;
  fault.blocked.clear();
  fault.handles = [];
  fault.onClose = undefined;
  fault.readFailure = undefined;
  fault.laterReadFailure = undefined;
});

const staticProviders = [
  ["Rust", () => new RustBinaryProvider()],
  ["Go", () => new GoBinaryProvider()],
  ["PE", () => new PeResourcesProvider()],
  ["IL2CPP metadata", () => new Il2cppMetadataProvider()],
] as const;

it("preserves opaque NuGet decoder failures and the completed file identity", async () => {
  const path = await selectedImage();
  const bytes = await nugetNupkgFixture();
  await writeFile(path, bytes);
  fault.blockNew = false;
  const cause = new Error("controlled decoder runtime failure");
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* () {
      throw cause;
    });
  const provider = new NugetNupkgProvider();
  try {
    const result = await provider.inspect(
      inspectNugetNupkgInputSchema.parse({ path }),
    );
    if (result.ok) throw new Error("Expected opaque decoder failure");
    expect(result.error._tag).toBe("ArtifactOperationError");
    expect(result.error.cause).toBe(cause);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
    expect(fault.handles).toHaveLength(1);
    expect(fault.handles[0]?.fd).toBe(-1);
  } finally {
    enumeration.mockRestore();
    await provider.close();
  }
});

it("reports a NuGet package changed after hashing when its ZIP decode fails", async () => {
  const path = await selectedImage();
  const bytes = await nugetNupkgFixture();
  await writeFile(path, bytes);
  fault.blockNew = false;
  const enumerate = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      await writeFile(path, Buffer.alloc(bytes.length));
      return yield* enumerate.call(this, options);
    });
  const provider = new NugetNupkgProvider();
  try {
    const result = await provider.inspect(
      inspectNugetNupkgInputSchema.parse({ path }),
    );
    if (result.ok) throw new Error("Expected source change");
    expect(result.error).toBeInstanceOf(AnalysisArtifactChangedError);
    expect(result.error).toMatchObject({
      integrityCheck: "container-identity",
    });
    expect(fault.handles).toHaveLength(1);
    expect(fault.handles[0]?.fd).toBe(-1);
  } finally {
    enumeration.mockRestore();
    await provider.close();
  }
});

it.each(
  ["close failure", "close cancellation"].flatMap((outcome) =>
    ["NuGet", "Maven/Gradle"].map((kind) => ({ outcome, kind })),
  ),
)(
  "retains only the completed $kind file snapshot through $outcome and cleanup retry",
  async ({ outcome, kind }) => {
    const path = await selectedImage();
    const bytes =
      kind === "NuGet"
        ? await nugetNupkgFixture()
        : Buffer.from(mavenPomFixture);
    await writeFile(path, bytes);
    const controller = new AbortController();
    const reason = { source: `${kind} file finalization` };
    if (outcome === "close cancellation")
      fault.onClose = () => controller.abort(reason);
    const service =
      kind === "NuGet"
        ? new NugetNupkgService(new NugetNupkgProvider())
        : new MavenGradleMetadataService(new MavenGradleMetadataProvider());
    try {
      const result = await service.inspect(
        { path },
        { signal: controller.signal },
      );
      if (result.ok)
        throw new Error("Expected descriptor finalization failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.partialObservation).toEqual({
        kind: "file-snapshot-hash",
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
      const beforeCleanup = projectAnalysisError(result.error).details
        ?.partial_observation;
      if (outcome === "close cancellation")
        expect(result.error.cleanupPrimary?.cause).toBe(reason);
      await expect(service.close()).rejects.toBeDefined();
      expect(result.error.cleanupIncomplete).toBe(true);
      fault.blocked.clear();
      await service.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(
        projectAnalysisError(resolvedAnalysisError(result.error)).details
          ?.partial_observation,
      ).toEqual(beforeCleanup);
      expect(fault.handles).toHaveLength(1);
      expect(fault.handles[0]?.fd).toBe(-1);
    } finally {
      fault.onClose = undefined;
      fault.blocked.clear();
      await service.close();
    }
  },
);

it.each(
  ["selected producer input", "source map"].flatMap((consumer) =>
    ["close failure", "close cancellation", "physical failure"].map(
      (outcome) => ({ consumer, outcome }),
    ),
  ),
)(
  "retains completed caller input for $consumer through $outcome",
  async ({ consumer, outcome }) => {
    const path = await selectedImage();
    const bytes = Buffer.from("selected completed input");
    await writeFile(path, bytes);
    const controller = new AbortController();
    const reason = { source: "caller input finalization" };
    const physical = Object.assign(new Error("input metadata denied"), {
      code: "EACCES",
    });
    if (outcome !== "close failure")
      fault.onClose = () => controller.abort(reason);
    if (outcome === "physical failure") fault.readFailure = { cause: physical };
    const { sourceMap: _sourceMap, ...script } = webSourceLocationFixture();
    const web = new LocalWebSourceLocationArtifacts({
      load: () => Promise.resolve(ok(script)),
    });
    const resources = createArtifactAnalysisResources(
      "selected-test",
      "inspect_signal_recording",
      readStableArtifact,
      readLinuxResourceLimits,
      { message: "busy", details: {} },
    );
    const close = () =>
      consumer === "source map" ? web.close() : resources.close();
    try {
      const result =
        consumer === "source map"
          ? await web.load(
              {
                ...webSourceLocationArgs,
                source_map: { ...webSourceLocationArgs.source_map, path },
              },
              { signal: controller.signal },
            )
          : await resources.run(async () =>
              ok(
                await resources.readSelectedArtifact({
                  path,
                  maximumBytes: 1024,
                  allowanceName: "fixture input",
                  observedOutput: undefined,
                  signal: controller.signal,
                }),
              ),
            );
      if (result.ok)
        throw new Error("Expected descriptor finalization failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      const snapshot = {
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      };
      expect(result.error.partialObservation).toEqual(
        consumer === "source map"
          ? {
              kind: "web-artifact-acquisition",
              analysis: "not-performed",
              files: [
                {
                  role: "manifest",
                  file: script.manifestFile,
                  admission: "manifest-validated",
                },
                {
                  role: "source",
                  file: script.sourceFile,
                  admission: "source-verified",
                },
                ...(outcome === "physical failure"
                  ? []
                  : [
                      { role: "source-map", file: snapshot, admission: "read" },
                    ]),
              ],
            }
          : outcome === "physical failure"
            ? undefined
            : { kind: "file-snapshot-hash", ...snapshot },
      );
      const beforeCleanup = projectAnalysisError(result.error).details
        ?.partial_observation;
      if (outcome === "physical failure")
        expect(result.error.cleanupPrimary?.cause).toBe(physical);
      if (outcome === "close cancellation")
        expect(result.error.cleanupPrimary?.cause).toBe(reason);
      await expect(close()).rejects.toBeDefined();
      expect(result.error.cleanupIncomplete).toBe(true);
      fault.blocked.clear();
      await close();
      expect(result.error.cleanupIncomplete).toBe(false);
      if (consumer === "source map")
        expect(
          projectAnalysisError(resolvedAnalysisError(result.error)).details
            ?.partial_observation,
        ).toEqual(beforeCleanup);
      expect(fault.handles).toHaveLength(1);
      expect(fault.handles[0]?.fd).toBe(-1);
    } finally {
      fault.onClose = undefined;
      fault.blocked.clear();
      await close();
    }
  },
);

const expectIl2cppSource = (
  error: AnalysisError,
  path: string,
  bytes: Buffer,
) => {
  const source = parseEvidence(error.partialObservation);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(source.operation).toBe("observe_il2cpp_metadata_source");
  expect(source.subject).toMatchObject({
    local_path: path,
    identity: { sha256 },
  });
  expect(source.normalized_result).toEqual({
    artifact: { path, sha256, bytes: bytes.length },
    inventory_status: "not-returned-as-complete",
  });
};

it.each([false, true])(
  "retains completed IL2CPP source facts through failed close (cancel: %s)",
  async (cancel) => {
    const path = await selectedImage();
    const { bytes } = createIl2cppMetadataFixture();
    await writeFile(path, bytes);
    const provider = new Il2cppMetadataProvider();
    const controller = new AbortController();
    const reason = new Error("cancel during failed close");
    if (cancel) fault.onClose = () => controller.abort(reason);
    try {
      const result = await provider.inspect(
        { path },
        { signal: controller.signal },
      );
      if (result.ok) throw new Error("Expected failed close");
      if (cancel) {
        expect(result.error.cleanupPrimary).toBeInstanceOf(
          AnalysisCancelledError,
        );
        expect(result.error.cleanupPrimary?.cause).toBe(reason);
      }
      expect(result.error.cleanupIncomplete).toBe(true);
      expectIl2cppSource(result.error, path, bytes);
      expect(fault.handles).toHaveLength(1);
      expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
      fault.blocked.clear();
      await provider.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(fault.handles[0]?.fd).toBe(-1);
      expect(
        projectAnalysisError(result.error).details?.partial_observation,
      ).toEqual(result.error.partialObservation);
    } finally {
      fault.blocked.clear();
      await provider.close();
    }
  },
);

const identityFailure = () =>
  new ArtifactReaderFailure("integrity", "source replacement", {
    integrityCheck: "container-identity",
  });

const descriptorOutcomes = [
  ["completed read", false, undefined, AnalysisCancelledError],
  ["identity failure", false, identityFailure, AnalysisArtifactChangedError],
  [
    "permission failure",
    false,
    () => Object.assign(new Error("read denied"), { code: "EACCES" }),
    AnalysisAccessDeniedError,
  ],
  [
    "budget failure",
    false,
    () => new ArtifactReaderFailure("limit", "read limit"),
    AnalysisResourceConstraintError,
  ],
  ["identity failure", true, identityFailure, AnalysisArtifactChangedError],
] as const;

it.each(
  staticProviders.flatMap(([name, makeProvider]) =>
    descriptorOutcomes
      .filter(([outcome]) => name !== "Rust" || outcome !== "completed read")
      .map(([outcome, blocked, failure, expected]) => ({
        name,
        makeProvider,
        outcome,
        blocked,
        failure,
        expected,
      })),
  ),
)(
  "preserves the $name $outcome through close cancellation (blocked: $blocked)",
  async ({ makeProvider, blocked, failure, expected }) => {
    const path = await selectedImage();
    const provider = makeProvider();
    const primary = failure?.();
    const bytes =
      primary !== undefined
        ? undefined
        : provider instanceof PeResourcesProvider
          ? peResourceFixture().bytes
          : provider instanceof Il2cppMetadataProvider
            ? createIl2cppMetadataFixture().bytes
            : undefined;
    if (bytes !== undefined) await writeFile(path, bytes);
    const controller = new AbortController();
    const reason = new Error("cancel during descriptor close");
    fault.blockNew = blocked;
    fault.onClose = () => controller.abort(reason);
    if (primary !== undefined) fault.readFailure = { cause: primary };
    try {
      const result =
        provider instanceof PeResourcesProvider
          ? await provider.inspect(
              inspectPeResourcesInputSchema.parse({ path }),
              { signal: controller.signal },
            )
          : await provider.inspect({ path }, { signal: controller.signal });
      if (result.ok)
        throw new Error(
          "Expected close cancellation or a primary read failure",
        );
      expect(controller.signal.reason).toBe(reason);
      expect(result.error.cleanupIncomplete).toBe(blocked);
      let carried: unknown = result.error;
      if (blocked) {
        const aggregate = result.error.cause;
        if (!(aggregate instanceof AggregateError))
          throw new Error("Missing primary/cleanup aggregate");
        [carried] = aggregate.errors;
      }
      expect(carried).toBeInstanceOf(expected);
      expect((carried as Error).cause).toBe(primary ?? reason);

      if (provider instanceof Il2cppMetadataProvider) {
        if (bytes === undefined)
          expect(result.error.partialObservation).toBeUndefined();
        else expectIl2cppSource(result.error, path, bytes);
      }
      expect(fault.handles).toHaveLength(1);
      if (blocked) {
        expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
        fault.blocked.clear();
        await provider.close();
        expect(result.error.cleanupIncomplete).toBe(false);
      }
      expect(fault.handles[0]?.fd).toBe(-1);
    } finally {
      fault.onClose = undefined;
      fault.blocked.clear();
      await provider.close();
    }
  },
);
it("clears the Python pyc cleanup flag once a retained descriptor closes", async () => {
  const path = await selectedImage();
  const provider = new PythonPycProvider();
  const primary = new ArtifactReaderFailure(
    "integrity",
    "controlled source replacement",
    { integrityCheck: "container-identity" },
  );
  fault.readFailure = { cause: primary };
  try {
    const result = await provider.inspect(
      inspectPythonPycInputSchema.parse({ path }),
    );
    if (result.ok)
      throw new Error("Expected primary failure and retained descriptor");
    expect(result.error.cleanupIncomplete).toBe(true);
    fault.blocked.clear();
    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
  } finally {
    fault.blocked.clear();
    await provider.close();
  }
});

afterEach(async () => {
  fault.blockNew = false;
  fault.blocked.clear();
  fault.onClose = undefined;
  for (const handle of fault.handles) if (handle.fd >= 0) await handle.close();
});

const selectedImage = async (bytes = createRustImage({ format: "elf" })) => {
  const root = await createTestTempDirectory("rea-rust-artifact-owner-");
  const path = join(root, "image.elf");
  await writeFile(path, bytes);
  fault.path = path;
  return path;
};

it.each([
  "confirmed-close-cancel",
  "failed-close",
  "failed-close-cancel",
] as const)(
  "retains complete scoped model observations through %s and retries the exact file owner",
  async (mode) => {
    const path = await selectedImage();
    await writeFile(path, ggufFixture().bytes);
    const provider = new ModelArtifactProvider();
    const controller = new AbortController();
    const reason = new Error("model close cancellation");
    fault.blockNew = mode !== "confirmed-close-cancel";
    if (mode !== "failed-close") fault.onClose = () => controller.abort(reason);
    try {
      const result = await provider.inspect(
        { path, hash: "header" },
        { signal: controller.signal },
      );
      if (result.ok) throw new Error("Expected finalization failure");
      const evidence = parseEvidence(result.error.partialObservation);
      expect(evidence.operation).toBe("inspect_model_artifact");
      expect(evidence.subject.identity.kind).toBe("unknown");
      expect(evidence.normalized_result).toMatchObject({
        artifact: { path, sha256: null, read_scope: "header" },
        tensors: [{ name: "weight" }, { name: "quant" }],
      });
      if (mode === "confirmed-close-cancel") {
        expect(result.error).toBeInstanceOf(AnalysisCancelledError);
        expect(result.error.cause).toBe(reason);
        expect(fault.handles[0]?.fd).toBe(-1);
      } else {
        expect(result.error.cleanupIncomplete).toBe(true);
        if (mode === "failed-close-cancel")
          expect(result.error.cleanupPrimary?.cause).toBe(reason);
        expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
        fault.blocked.clear();
        await provider.close();
        expect(result.error.cleanupIncomplete).toBe(false);
        expect(fault.handles[0]?.fd).toBe(-1);
      }
    } finally {
      fault.onClose = undefined;
      fault.blocked.clear();
      await provider.close();
    }
  },
);

it("preserves a model permission failure when cancellation arrives during close", async () => {
  const path = await selectedImage();
  const provider = new ModelArtifactProvider();
  const denied = Object.assign(new Error("model read denied"), {
    code: "EACCES",
  });
  fault.readFailure = { cause: denied };
  fault.blockNew = false;
  const controller = new AbortController();
  fault.onClose = () => controller.abort(new Error("later stop"));
  try {
    const result = await provider.inspect(
      { path, hash: "header" },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Read failure disappeared");
    expect(result.error).toBeInstanceOf(AnalysisAccessDeniedError);
    expect(result.error.cause).toBe(denied);
    expect(result.error.partialObservation).toBeUndefined();
  } finally {
    fault.onClose = undefined;
    await provider.close();
  }
});

it("keeps the model parser cause through failed close and retry", async () => {
  const path = await selectedImage();
  const fixture = (depth: number) => {
    const nested = "[".repeat(depth) + "0" + "]".repeat(depth);
    return safetensorsFixture(
      `{"weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4],"note":${nested}}}`,
      Buffer.alloc(4),
    ).bytes;
  };
  const provider = new ModelArtifactProvider();
  try {
    fault.blockNew = false;
    await writeFile(path, fixture(1));
    const valid = await provider.inspect({ path, hash: "header" });
    expect(valid).toMatchObject({
      ok: true,
      value: { tensors: [{ name: "weight" }] },
    });

    fault.blockNew = true;
    await writeFile(path, fixture(33));
    const result = await provider.inspect({ path, hash: "header" });
    if (result.ok) throw new Error("Expected a model depth refusal");
    const { error } = result;
    const maximum = { maximum_json_depth: 32 };
    expect(projectAnalysisError(error)).toMatchObject({
      code: "cleanup_incomplete",
      details: { reported_limits: maximum },
    });
    expect(error.cleanupPrimary?.cause).toBeInstanceOf(ParseFailureError);
    expect(error.cleanupPrimary?.cause).toMatchObject({
      failure: {
        format: "model",
        kind: "limit",
        limit: { name: "json-nesting", maximum: 32 },
      },
    });
    const retained = fault.handles.at(-1);
    expect(retained?.fd).toBeGreaterThanOrEqual(0);
    fault.blocked.clear();
    await provider.close();
    expect(retained?.fd).toBe(-1);
    expect(projectAnalysisError(error)).toMatchObject({
      code: "resource_constraint",
      details: { reported_limits: maximum },
    });
    expect(resolvedAnalysisError(error).cause).toBe(
      error.cleanupPrimary?.cause,
    );
  } finally {
    fault.blocked.clear();
    await provider.close();
  }
});

it.each(["model", "foreign-fixture"])(
  "projects only a model-owned parser limit with its enforced maximum (%s)",
  async (format) => {
    const path = await selectedImage();
    const injected = new ParseFailureError({
      format,
      kind: "limit",
      detail: "fixture-owned parser limit",
      limit: { name: "json-nesting", maximum: 17 },
    });
    fault.blockNew = false;
    fault.laterReadFailure = { position: 0, cause: injected };
    const provider = new ModelArtifactProvider();
    try {
      const result = await provider.inspect({ path, hash: "header" });
      if (result.ok) throw new Error("Expected a read refusal");
      expect(result.error.cause).toBe(injected);
      const projected = projectAnalysisError(result.error);
      if (format === "model")
        expect(projected).toMatchObject({
          code: "resource_constraint",
          details: { reported_limits: { maximum_json_depth: 17 } },
          remediation: { action: expect.stringContaining("17 levels") },
        });
      else expect(projected.code).toBe("execution_failure");
    } finally {
      await provider.close();
    }
  },
);

it("retains earlier GGUF rows and physical failure while retrying failed descriptor cleanup", async () => {
  const path = await selectedImage();
  const seed = ggufFixture();
  const count = 200_000;
  const fixture = ggufFixture({
    tensors: [],
    metadata: [
      { key: "general.name", type: 8, value: seed.text("First row") },
      {
        key: "custom.bools",
        type: 9,
        value: Buffer.concat([
          seed.u32(7),
          seed.u64(BigInt(count)),
          Buffer.alloc(count),
        ]),
      },
    ],
  });
  await writeFile(path, fixture.bytes);
  const arrayStart =
    24 +
    8 +
    Buffer.byteLength("general.name") +
    4 +
    8 +
    Buffer.byteLength("First row") +
    8 +
    Buffer.byteLength("custom.bools") +
    4 +
    4 +
    8;
  const denied = Object.assign(new Error("controlled later GGUF read denial"), {
    code: "EACCES",
  });
  fault.laterReadFailure = { position: arrayStart, cause: denied };
  const provider = new ModelArtifactProvider();
  try {
    const result = await provider.inspect({ path, hash: "header" });
    if (result.ok) throw new Error("Expected physical read failure");
    expect(result.error.cleanupPrimary).toBeInstanceOf(
      AnalysisAccessDeniedError,
    );
    expect(result.error.cleanupPrimary?.cause).toBe(denied);
    expect(result.error.cleanupIncomplete).toBe(true);
    const partial = parseEvidence(result.error.partialObservation);
    expect(partial.normalized_result).toMatchObject({
      kind: "model-artifact-partial",
      metadata: [{ index: 0, key: "general.name", value: "First row" }],
      artifact: {
        path,
        header_sha256: null,
        sha256: null,
        file_identity: "unverified",
      },
    });
    expect(fault.handles).toHaveLength(1);
    expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
    fault.blocked.clear();
    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(parseEvidence(result.error.partialObservation)).toEqual(partial);
  } finally {
    fault.blocked.clear();
    await provider.close();
  }
});

mcpTest(
  "retains Rust descriptor cleanup and recovers in the same MCP connection",
  async ({ mcp }) => {
    const bytes = createRustImage({ format: "elf" });
    const path = await selectedImage(bytes);
    const service = new RustBinaryService(new RustBinaryProvider());
    const failures: AnalysisError[] = [];
    const inspect = service.inspect.bind(service);
    vi.spyOn(service, "inspect").mockImplementation(async (...arguments_) => {
      const result = await inspect(...arguments_);
      if (!result.ok) failures.push(result.error);
      return result;
    });
    const session = createTestBinarySession(() => {
      throw new Error("Unexpected native provider");
    });
    const server = createServer(
      { kind: "session", session },
      { rustBinary: service },
    );
    const client = await mcp.connect(server);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await client.callTool({
          name: "inspect_rust_binary",
          arguments: { path },
        });
        expect(response.isError).toBe(true);
        const { error } = parseMcpToolError(response);
        expect(error).toMatchObject({
          code: "cleanup_incomplete",
          details: { resources: [path] },
        });
        if (attempt === 0) {
          const reference = retainedEvidenceReferenceSchema.parse(
            error.details?.partial_observation,
          );
          const view = await client.callTool({
            name: "inspect_analysis_view",
            arguments: {
              source: reference,
              view: { kind: "rust", collection: "packages", fields: ["name"] },
            },
          });
          expect(view.isError, JSON.stringify(view.content)).not.toBe(true);
          expect(
            parseEvidence(view.structuredContent).normalized_result,
          ).toMatchObject({
            parent_evidence_id: reference.evidence_id,
            page: {
              rows: [
                { index: 0, name: "itoa" },
                { index: 1, name: "sample" },
              ],
            },
          });
        }
      }
      expect(fault.handles).toHaveLength(1);
      expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
      expect(failures.map((error) => error.cleanupIncomplete)).toEqual([
        true,
        true,
      ]);
      fault.blockNew = false;
      fault.blocked.clear();
      const recovered = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(recovered.isError).not.toBe(true);
      expect(failures.map((error) => error.cleanupIncomplete)).toEqual([
        false,
        false,
      ]);
      expect(fault.handles.every((handle) => handle.fd === -1)).toBe(true);
    } finally {
      fault.blockNew = false;
      fault.blocked.clear();
      await server.close();
      await session.close();
    }
  },
);

it("keeps mixed descriptor cleanup and its aggregate bound to the exact unresolved owners", async () => {
  const path = await selectedImage();
  const service = new RustBinaryService(new RustBinaryProvider());
  try {
    const inspections = await Promise.all([
      service.inspect({ path }),
      service.inspect({ path }),
    ]);
    expect(fault.handles).toHaveLength(2);
    const errors = inspections.map((result) => {
      if (result.ok) throw new Error("Expected retained cleanup");
      return result.error;
    });
    const firstClose = await service.close().catch((cause: unknown) => cause);
    if (!(firstClose instanceof AnalysisError))
      throw new Error("Missing typed shutdown failure");
    expect(firstClose.cleanupIncomplete).toBe(true);
    const handlesByError = errors.map((error) => {
      const aggregate = error.cause;
      if (!(aggregate instanceof AggregateError))
        throw new Error("Missing cleanup aggregate");
      const cleanup = aggregate.errors[1];
      if (
        !(cleanup instanceof AnalysisError) ||
        !(cleanup.cause instanceof ArtifactFileCleanupFailure)
      )
        throw new Error("Missing exact descriptor owner");
      return cleanup.cause.fileCleanupFailure.owner.handle;
    });
    expect(new Set(handlesByError)).toEqual(new Set(fault.handles));
    const [first, second] = handlesByError;
    if (first === undefined || second === undefined)
      throw new Error("Missing distinct descriptors");
    fault.blocked.delete(first);
    const mixedClose = await service.close().catch((cause: unknown) => cause);
    if (!(mixedClose instanceof AnalysisError))
      throw new Error("Missing mixed shutdown failure");
    expect(first.fd).toBe(-1);
    expect(second.fd).toBeGreaterThanOrEqual(0);
    expect(errors.map((error) => error.cleanupIncomplete)).toEqual([
      false,
      true,
    ]);
    expect(firstClose.cleanupIncomplete).toBe(true);
    expect(mixedClose.cleanupIncomplete).toBe(true);
    fault.blocked.clear();
    await service.close();
    expect(errors.map((error) => error.cleanupIncomplete)).toEqual([
      false,
      false,
    ]);
    expect(firstClose.cleanupIncomplete).toBe(false);
    expect(mixedClose.cleanupIncomplete).toBe(false);
  } finally {
    fault.blockNew = false;
    fault.blocked.clear();
    await service.close();
  }
});

mcpTest(
  "server shutdown releases Rust descriptors retained by a failed tool call",
  async ({ mcp }) => {
    const path = await selectedImage();
    const session = createTestBinarySession(() => {
      throw new Error("Unexpected native provider");
    });
    const server = createServer({ kind: "session", session });
    const client = await mcp.connect(server);
    try {
      const response = await client.callTool({
        name: "inspect_rust_binary",
        arguments: { path },
      });
      expect(parseMcpToolError(response).error.code).toBe("cleanup_incomplete");
      expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
      fault.blockNew = false;
      fault.blocked.clear();
      await server.close();
      expect(fault.handles[0]?.fd).toBe(-1);
    } finally {
      fault.blockNew = false;
      fault.blocked.clear();
      await server.close();
      await session.close();
    }
  },
);

it.each([
  "close denial",
  "late cancellation",
  "both",
  "physical failure",
  "output refusal",
] as const)(
  "preserves Rust acquisition through %s and releases the same descriptor",
  async (outcome) => {
    const bytes = createRustImage({ format: "elf" });
    const path = await selectedImage(bytes);
    const service = new RustBinaryService(new RustBinaryProvider());
    const controller = new AbortController();
    const reason = { request: "cancel during Rust close" };
    const physical = Object.assign(new Error("Rust input stat denied"), {
      code: "EACCES",
    });
    const pending = outcome !== "late cancellation";
    fault.blockNew = pending;
    if (outcome !== "close denial")
      fault.onClose = () => controller.abort(reason);
    if (outcome === "physical failure") fault.readFailure = { cause: physical };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const parameters = {
      path,
      max_rustc_hashes: 10,
      producer_limits: {
        input_bytes: bytes.length + 64,
        ...(outcome === "output refusal" ? { output_bytes: 16 } : {}),
      },
    };
    try {
      const result = await service.inspect(parameters, {
        signal: controller.signal,
      });
      if (result.ok) throw new Error("Expected Rust finalization failure");
      const { error } = result;
      const primary = error.cleanupPrimary ?? error;
      expect(error.cleanupIncomplete).toBe(pending);
      if (outcome !== "close denial")
        expect(controller.signal.reason).toBe(reason);
      expect(fault.handles).toHaveLength(1);
      const handle = fault.handles[0]!;
      if (pending) expect(handle.fd).toBeGreaterThanOrEqual(0);
      else expect(handle.fd).toBe(-1);
      if (outcome === "physical failure") {
        expect(primary).toBeInstanceOf(AnalysisAccessDeniedError);
        expect(primary.cause).toBe(physical);
        expect(error.partialObservation).toBeUndefined();
      } else if (outcome === "output refusal") {
        expect(primary).toBeInstanceOf(AnalysisResourceConstraintError);
        expect(primary).toMatchObject({ resource: "transport" });
        expect(error.partialObservation).toEqual({
          kind: "file-snapshot-hash",
          path,
          sha256,
          bytes: bytes.length,
        });
      } else {
        const evidence = parseEvidence(error.partialObservation);
        const dependencyStart = 1024;
        const dependencyBytes = rustDependencyPayload().length;
        expect(evidence).toMatchObject({
          operation: "inspect_rust_binary",
          subject: { identity: { format: "elf", sha256 }, local_path: path },
          locations: [
            { kind: "artifact-path", path },
            {
              kind: "file-offset-range",
              start: dependencyStart,
              end: dependencyStart + dependencyBytes,
            },
          ],
          normalized_result: {
            artifact: { path, sha256, bytes: bytes.length },
            auditable_metadata: {
              file_offset: dependencyStart,
              section_bytes: dependencyBytes,
              root_package_index: 1,
            },
            rustc_commit: {
              evidence_kind: "inferred",
              hashes: [{ hash: RUSTC_HASH, file_offset: 2048 }],
            },
          },
        });
        expect(evidence.parameters).toEqual(parameters);
        expect(primary.partialObservation).toBe(error.partialObservation);
        if (outcome !== "close denial") {
          expect(primary).toBeInstanceOf(AnalysisCancelledError);
          expect(primary.cause).toBe(reason);
        }
        if (outcome === "both") {
          expect(error.cause).toBeInstanceOf(AggregateError);
          expect((error.cause as AggregateError).errors[0]).toBe(primary);
        }
      }
      const observed = projectAnalysisError(error).details?.partial_observation;
      expect(observed).toEqual(error.partialObservation);
      if (pending) {
        await expect(service.close()).rejects.toBeInstanceOf(AnalysisError);
        expect(error.cleanupIncomplete).toBe(true);
      }
      fault.blocked.clear();
      await service.close();
      expect(error.cleanupIncomplete).toBe(false);
      expect(handle.fd).toBe(-1);
      expect(fault.handles).toEqual([handle]);
      expect(
        projectAnalysisError(resolvedAnalysisError(error)).details
          ?.partial_observation,
      ).toEqual(observed);
    } finally {
      fault.onClose = undefined;
      fault.blocked.clear();
      await service.close();
    }
  },
);

it("preserves upstream resource-bound facts through an unconfirmed descriptor close", async () => {
  const path = await selectedImage();
  const scope = new ArtifactResourceScope();
  const primary = new ArtifactReaderFailure(
    "limit",
    "Controlled input budget refusal",
    { boundary: "file-size" },
  );
  try {
    const failure = await scope
      .run(() =>
        withArtifactRegularFile(path, scope, undefined, async () => {
          throw primary;
        }),
      )
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    expect(failure).toMatchObject({ reason: "limit", boundary: "file-size" });
    if (!(failure instanceof ArtifactFileCleanupFailure))
      throw new Error("Expected exact descriptor cleanup failure");
    expect(failure.fileCleanupFailure.outcome).toEqual({
      kind: "failed",
      cause: primary,
    });
  } finally {
    fault.blocked.clear();
    await scope.close();
  }
});

it.each([
  "physical cancellation",
  "mapped foreign artifact",
  "foreign nested artifact",
] as const)(
  "preserves %s provenance while retrying only the owned descriptor",
  async (shape) => {
    const path = await selectedImage();
    const foreignPath = join(path, "..", "foreign.txt");
    await writeFile(foreignPath, "foreign owner bytes");
    const foreign = new OwnedFileHandle(await open(foreignPath, "r"));
    const foreignLease = AnalysisCleanupLease.forCloseOwner(
      foreign,
      foreignPath,
    );
    const foreignPartial = createEvidence(
      unknownTarget("not-observed"),
      { id: "foreign", name: "foreign owner", version: null },
      {
        operation: "inspect_artifact",
        parameters: {},
        result: { foreign: true },
        confidence: "observed",
      },
    );
    const foreignReason = { source: "foreign cancellation" };
    const foreignFailure = new ArtifactReaderFailure(
      "cancelled",
      "foreign artifact failure",
      {
        cause: foreignReason,
        cancellation: { reason: foreignReason },
        cleanup: { resources: [foreignPath], reason: "foreign cleanup" },
        cleanupLeases: [foreignLease],
        partialObservation: foreignPartial,
      },
    );
    const raw =
      shape === "physical cancellation"
        ? new RegularFileOperationCancelled(foreignReason)
        : shape === "foreign nested artifact"
          ? new ArtifactFileCleanupFailure(
              new RegularFileCleanupFailure({
                path: foreignPath,
                owner: foreign,
                outcome: { kind: "failed", cause: foreignFailure },
                cleanupCause: new Error("foreign descriptor close failure"),
              }),
              foreignLease,
            )
          : foreignFailure;
    const marker = new OwnedRegularFileOperationFailure(raw);
    const controller = new AbortController();
    const lateReason = { source: "late owned-close abort" };
    fault.onClose = () => controller.abort(lateReason);
    const scope = new ArtifactResourceScope();
    try {
      const failure = await scope
        .run(() =>
          withArtifactRegularFile(path, scope, controller.signal, async () => {
            throw marker;
          }),
        )
        .catch((cause: unknown) => cause);
      if (!(failure instanceof ArtifactFileCleanupFailure))
        throw new Error("Expected the actual input descriptor's failed close");
      expect(artifactFilePrimaryFacts(failure)).toEqual({
        cause: raw,
        origin: "opaque-operation",
      });
      const projected = mapArtifactFileFailure(failure, (primary) => {
        expect(primary).toBe(raw);
        return shape === "mapped foreign artifact"
          ? new ArtifactReaderFailure(
              "unavailable",
              "authored permission classification",
              { cause: raw },
            )
          : primary;
      });
      if (!(projected instanceof ArtifactFileCleanupFailure))
        throw new Error(
          "Expected the same owned descriptor envelope after projection",
        );
      for (const envelope of [failure, projected]) {
        expect(envelope.reason).toBe(
          envelope === projected && shape === "mapped foreign artifact"
            ? "unavailable"
            : "io",
        );
        expect(envelope.cancellation).toBeUndefined();
        expect(envelope.partialObservation).toBeUndefined();
        expect(envelope.cleanup?.resources).toEqual([path]);
        expect(
          regularFileCancellation(envelope.fileCleanupFailure),
        ).toBeUndefined();
      }
      expect(failure.fileCleanupFailure.outcome).toEqual({
        kind: "failed",
        cause: raw,
      });
      expect(projected.fileCleanupFailure.operationFailure).toBe(marker);
      expect(artifactFilePrimaryFacts(projected).cause).toBe(
        projected.fileCleanupFailure.outcome.kind === "failed"
          ? projected.fileCleanupFailure.outcome.cause
          : undefined,
      );
      expect(artifactFilePrimaryFacts(projected).origin).toBe(
        shape === "mapped foreign artifact"
          ? "owned-or-classified"
          : "opaque-operation",
      );
      expect(marker.operationCause).toBe(raw);
      expect(projected.cleanupLease).toBe(failure.cleanupLease);
      expect(projected.cleanupLeases).toEqual([failure.cleanupLease]);
      const error = translateArtifactFailure("inspect_artifact", projected);
      expect(error.cleanupResources).toEqual([path]);
      expect(error.cleanupIncomplete).toBe(true);
      expect(error.partialObservation).toBeUndefined();
      expect(controller.signal.reason).toBe(lateReason);
      expect(fault.handles).toHaveLength(1);
      expect(fault.handles[0]!.fd).toBeGreaterThanOrEqual(0);
      await expect(scope.close()).rejects.toThrow();
      expect(foreign.handle.fd).toBeGreaterThanOrEqual(0);
      fault.blocked.clear();
      await scope.close();
      expect(fault.handles[0]!.fd).toBe(-1);
      expect(error.cleanupIncomplete).toBe(false);
      expect(error.cleanupResources).toEqual([]);
      expect(foreign.handle.fd).toBeGreaterThanOrEqual(0);
      expect(foreignLease.released).toBe(false);
      expect(foreignFailure.cleanup?.resources).toEqual([foreignPath]);
      expect(foreignFailure.partialObservation).toBe(foreignPartial);
    } finally {
      fault.onClose = undefined;
      fault.blocked.clear();
      await scope.close();
      await foreign.close();
    }
  },
);

const stableArtifactProviders = [
  ...staticProviders,
  ["ELF notes", () => new ElfNotesProvider()],
  ["DWARF units", () => new DwarfUnitsProvider()],
  ["native initializers", () => new NativeInitializersProvider()],
  ["ELF unwind ranges", () => new ElfUnwindRangesProvider()],
  ["Apple IPS", () => new AppleIpsProvider()],
  ["kernel module", () => new KernelModuleProvider()],
  ["ELF debug link", () => new ElfDebugLinkProvider()],
  ["ELF dependencies", () => new ElfDependenciesProvider()],
  ["kernel build config", () => new KernelBuildConfigProvider()],
  ["PE certificates", () => new PeCertificatesProvider()],
  ["PE load configuration", () => new PeLoadConfigProvider()],
  ["release exposure", () => new ReleaseExposureReader()],
  ["binary hardening", () => new BinaryHardeningProvider()],
  ["PE imports", () => new PeImportsProvider()],
  ["PE Rich header", () => new PeRichHeaderProvider()],
  ["Windows shortcut", () => new WindowsShortcutProvider()],
  ["native exports", () => new NativeExportsProvider()],
  ["Python pyc", () => new PythonPycProvider()],
  ["NuGet nupkg", () => new NugetNupkgProvider()],
  ["Maven/Gradle metadata", () => new MavenGradleMetadataProvider()],
] as const;

const fileFailureProviders = [
  ...stableArtifactProviders,
  ["BEAM", () => new BeamProvider()],
] as const;

const inspectFileFailure = (
  provider: ReturnType<(typeof fileFailureProviders)[number][1]>,
  path: string,
  signal?: AbortSignal,
) => {
  const options = signal === undefined ? undefined : { signal };
  if (provider instanceof MavenGradleMetadataProvider)
    return provider.inspect(
      inspectMavenGradleMetadataInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof NugetNupkgProvider)
    return provider.inspect(
      inspectNugetNupkgInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof PythonPycProvider)
    return provider.inspect(
      inspectPythonPycInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof ElfNotesProvider)
    return provider.inspect(
      inspectElfNotesInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof DwarfUnitsProvider)
    return provider.inspect(
      inspectDwarfUnitsInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof NativeInitializersProvider)
    return provider.inspect(
      inspectNativeInitializersInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof ElfUnwindRangesProvider)
    return provider.inspect(
      inspectElfUnwindRangesInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof AppleIpsProvider)
    return provider.inspect(
      inspectAppleIpsInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof KernelModuleProvider)
    return provider.inspect(
      inspectKernelModuleInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof ElfDebugLinkProvider)
    return provider.inspect(
      inspectElfDebugLinkInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof ElfDependenciesProvider)
    return provider.inspect(
      inspectElfDependenciesInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof KernelBuildConfigProvider)
    return provider.inspect(
      inspectKernelBuildConfigInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof PeCertificatesProvider)
    return provider.inspect(
      inspectPeCertificatesInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof PeLoadConfigProvider)
    return provider.inspect(
      inspectPeLoadConfigInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof PeRichHeaderProvider)
    return provider.inspect(
      inspectPeRichHeaderInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof BinaryHardeningProvider)
    return provider.inspect(
      inspectBinaryHardeningInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof PeImportsProvider)
    return provider.inspect(
      inspectPeImportsInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof WindowsShortcutProvider)
    return provider.inspect(
      inspectWindowsShortcutInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof NativeExportsProvider)
    return provider.inspect(
      inspectNativeExportsInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof BeamProvider)
    return provider.inspect(
      inspectErlangBeamInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof PeResourcesProvider)
    return provider.inspect(
      inspectPeResourcesInputSchema.parse({ path }),
      options,
    );
  if (provider instanceof ReleaseExposureReader)
    return provider.inspect({ path }, options, () => undefined);
  return provider.inspect({ path }, options);
};

it.each(
  stableArtifactProviders.flatMap(([name, makeProvider]) =>
    [
      ["ESTALE", "AnalysisInputError"],
      ["ENOTFILE", "AnalysisInputError"],
      ["EISDIR", "AnalysisInputError"],
      ["ELOOP", "AnalysisInputError"],
      ["EACCES", "AnalysisAccessDeniedError"],
      ["EIO", undefined],
    ].map(([code, expectedTag]) => ({ name, makeProvider, code, expectedTag })),
  ),
)(
  "preserves $name descriptor failure classification for $code",
  async ({ makeProvider, code, expectedTag }) => {
    const path = await selectedImage();
    const provider = makeProvider();
    const physical = Object.assign(new Error("descriptor metadata failed"), {
      code,
    });
    fault.blockNew = false;
    fault.readFailure = { cause: physical };
    try {
      const result = await inspectFileFailure(provider, path);
      if (result.ok) throw new Error("Expected physical read failure");
      expect(result.error.cause).toBe(physical);
      expect(result.error._tag).toBe(
        expectedTag ??
          (provider instanceof ElfNotesProvider ||
          provider instanceof DwarfUnitsProvider ||
          provider instanceof ElfUnwindRangesProvider ||
          provider instanceof KernelModuleProvider ||
          provider instanceof ElfDebugLinkProvider ||
          provider instanceof ElfDependenciesProvider ||
          provider instanceof KernelBuildConfigProvider ||
          provider instanceof PeCertificatesProvider ||
          provider instanceof PeResourcesProvider ||
          provider instanceof NugetNupkgProvider ||
          provider instanceof MavenGradleMetadataProvider
            ? "ArtifactOperationError"
            : "ProviderAdapterError"),
      );
      if (result.error instanceof AnalysisInputError)
        expect(result.error.issues).toEqual([
          {
            path: ["path"],
            reason: "invalid_value",
            message: expect.stringContaining(path),
          },
        ]);
      expect(fault.handles).toHaveLength(1);
      expect(fault.handles[0]!.fd).toBe(-1);
    } finally {
      await provider.close();
    }
  },
);

it.each(fileFailureProviders)(
  "uses the original %s physical failure across nested descriptor owners",
  async (_name, makeProvider) => {
    const path = await selectedImage();
    const scope = new ArtifactResourceScope();
    const provider = makeProvider();
    const primary = new ArtifactReaderFailure(
      "integrity",
      "original source replacement",
      { integrityCheck: "container-identity" },
    );
    try {
      const nested = await scope
        .run(() =>
          withArtifactRegularFile(path, scope, undefined, async () => {
            throw primary;
          }),
        )
        .catch((cause: unknown) => cause);
      expect(nested).toBeInstanceOf(ArtifactFileCleanupFailure);
      fault.readFailure = { cause: nested };
      const result = await inspectFileFailure(provider, path);
      if (result.ok) throw new Error("Expected nested physical failure");
      expect(result.error.cleanupPrimary).toBeInstanceOf(
        AnalysisArtifactChangedError,
      );
      expect(result.error.cleanupPrimary?.cause).toBe(primary);
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(fault.handles).toHaveLength(2);
      fault.blocked.delete(fault.handles[1]!);
      await provider.close();
      expect(fault.handles[1]?.fd).toBe(-1);
      expect(fault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
      expect(result.error.cleanupIncomplete).toBe(true);
      fault.blocked.clear();
      await scope.close();
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      fault.blocked.clear();
      await provider.close();
      await scope.close();
    }
  },
);

it.each(
  fileFailureProviders.flatMap(([name, makeProvider]) =>
    ["recorded", "later"].map((timing) => ({ name, makeProvider, timing })),
  ),
)(
  "classifies $name finalization using the owner with $timing cancellation",
  async ({ makeProvider, timing }) => {
    const path = await selectedImage();
    const scope = new ArtifactResourceScope();
    const provider = makeProvider();
    const controller = new AbortController();
    const reason = new Error("file owner cancellation");
    if (timing === "recorded") fault.onClose = () => controller.abort(reason);
    let run: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const failure = await scope
        .run(() =>
          readStableArtifact(
            path,
            1024 * 1024,
            timing === "recorded" ? controller.signal : undefined,
            undefined,
            scope,
          ),
        )
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
      // Inject a real completed-close failure at the provider's acquisition
      // boundary, after the owner has recorded its outcome and cancellation.
      run = vi
        .spyOn(ArtifactResourceScope.prototype, "run")
        .mockImplementationOnce(async () => {
          if (timing === "later") controller.abort(reason);
          throw failure;
        });
      const result = await inspectFileFailure(
        provider,
        path,
        timing === "later" ? controller.signal : undefined,
      );
      run.mockRestore();
      run = undefined;
      if (result.ok) throw new Error("Expected retained close failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      if (timing === "recorded") {
        expect(result.error.cleanupPrimary).toBeInstanceOf(
          AnalysisCancelledError,
        );
        expect(result.error.cleanupPrimary?.cause).toBe(reason);
      } else
        expect(result.error.cleanupPrimary).not.toBeInstanceOf(
          AnalysisCancelledError,
        );
      fault.blocked.clear();
      await scope.close();
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      run?.mockRestore();
      fault.onClose = undefined;
      fault.blocked.clear();
      await provider.close();
      await scope.close();
    }
  },
);

it.each([false, true])(
  "preserves a pyc permission failure through late cancellation (failed close: %s)",
  async (failedClose) => {
    const path = await selectedImage();
    const provider = new PythonPycProvider();
    const controller = new AbortController();
    const physical = Object.assign(new Error("pyc descriptor stat denied"), {
      code: "EACCES",
    });
    fault.blockNew = failedClose;
    fault.readFailure = { cause: physical };
    fault.onClose = () => controller.abort(physical);
    try {
      const result = await provider.inspect(
        inspectPythonPycInputSchema.parse({ path }),
        { signal: controller.signal },
      );
      if (result.ok) throw new Error("Expected physical read failure");
      const primary = result.error.cleanupPrimary ?? result.error;
      expect(primary).toBeInstanceOf(AnalysisAccessDeniedError);
      expect(primary.cause).toBe(physical);
      expect(result.error.cleanupIncomplete).toBe(failedClose);
      expect(fault.handles).toHaveLength(1);
      expect(fault.handles[0]!.fd >= 0).toBe(failedClose);
      fault.blocked.clear();
      await provider.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(fault.handles[0]!.fd).toBe(-1);
    } finally {
      fault.onClose = undefined;
      fault.blocked.clear();
      await provider.close();
    }
  },
);
