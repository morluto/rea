import type { AnalysisViewRetention } from "../application/analysisView/AnalysisViewRetention.js";
import type { ApkSignatureService } from "../application/apkSignature/ApkSignatureService.js";
import type { DesktopApplicationService } from "../application/artifacts/DesktopApplicationService.js";
import type { AppleIpsService } from "../application/binaryDiagnostics/AppleIpsService.js";
import type { BinaryHardeningService } from "../application/binaryDiagnostics/BinaryHardeningService.js";
import type { ByteEntropyService } from "../application/binaryDiagnostics/ByteEntropyService.js";
import type { DevicetreeService } from "../application/binaryDiagnostics/DevicetreeService.js";
import type { DwarfUnitsService } from "../application/binaryDiagnostics/DwarfUnitsService.js";
import type { ElfDebugLinkService } from "../application/binaryDiagnostics/ElfDebugLinkService.js";
import type { ElfDependenciesService } from "../application/binaryDiagnostics/ElfDependenciesService.js";
import type { ElfNotesService } from "../application/binaryDiagnostics/ElfNotesService.js";
import type { ElfUnwindRangesService } from "../application/binaryDiagnostics/ElfUnwindRangesService.js";
import type { KernelBuildConfigService } from "../application/binaryDiagnostics/KernelBuildConfigService.js";
import type { KernelModuleService } from "../application/binaryDiagnostics/KernelModuleService.js";
import type { NativeExportsService } from "../application/binaryDiagnostics/NativeExportsService.js";
import type { NativeInitializersService } from "../application/binaryDiagnostics/NativeInitializersService.js";
import type { PeCertificatesService } from "../application/binaryDiagnostics/PeCertificatesService.js";
import type { PeImportsService } from "../application/binaryDiagnostics/PeImportsService.js";
import type { PeLoadConfigService } from "../application/binaryDiagnostics/PeLoadConfigService.js";
import type { PeUnwindRangesService } from "../application/binaryDiagnostics/PeUnwindRangesService.js";
import type { PeOverlayService } from "../application/binaryDiagnostics/PeOverlayService.js";
import type { PeResourcesService } from "../application/binaryDiagnostics/PeResourcesService.js";
import type { RecordedCrashService } from "../application/binaryDiagnostics/RecordedCrashService.js";
import type { WindowsShortcutService } from "../application/binaryDiagnostics/WindowsShortcutService.js";
import type { DebPackageService } from "../application/deb/DebPackageService.js";
import type { BeamService } from "../application/erlang/BeamService.js";
import type { EvmInterfaceService } from "../application/evm/EvmInterfaceService.js";
import type { GoBinaryService } from "../application/go/GoBinaryService.js";
import type { GpuCodeObjectsService } from "../application/gpu/GpuCodeObjectsService.js";
import type { Il2cppMetadataService } from "../application/il2cpp/Il2cppMetadataService.js";
import { retainAnalysisResultSources } from "../application/investigation/recordEvidenceSources.js";
import type { MavenGradleMetadataService } from "../application/java/MavenGradleMetadataService.js";
import type { ModelArtifactService } from "../application/model/ModelArtifactService.js";
import type { NugetNupkgService } from "../application/nuget/NugetNupkgService.js";
import type { OciImageLayoutService } from "../application/oci/OciImageLayoutService.js";
import type { PythonPycService } from "../application/python/PythonPycService.js";
import type { ReleaseExposureService } from "../application/releaseExposure/ReleaseExposureService.js";
import type { RustBinaryService } from "../application/rust/RustBinaryService.js";
import type { SqliteDatabaseService } from "../application/sqlite/SqliteDatabaseService.js";
import type { V8CodeCacheService } from "../application/v8CodeCache/V8CodeCacheService.js";
import type { VsixPackageService } from "../application/vsix/VsixPackageService.js";
import type { WasmArtifactService } from "../application/wasm/WasmArtifactService.js";
import { compareWasmInterfaces } from "../application/wasm/WasmInterfaceComparisonService.js";
import { ok } from "../domain/result.js";
import type { ContractToolBindings } from "./contractToolBindings.js";

type Bind<Service> = (
  service: Service,
  retention: AnalysisViewRetention,
) => ContractToolBindings;

/**
 * MCP bindings for offline single-artifact inspection services (binary
 * diagnostics, language/runtime packages, archives, and databases).
 */
export const OFFLINE_INSPECTION_TOOL_BINDINGS = {
  byteEntropy: ((service) => ({
    inspect_byte_entropy: {
      admission: "sdk",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ByteEntropyService>,
  peResources: ((service) => ({
    inspect_pe_resources: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeResourcesService>,
  nativeExports: ((service) => ({
    inspect_native_exports: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<NativeExportsService>,
  devicetree: ((service) => ({
    inspect_devicetree: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<DevicetreeService>,
  elfNotes: ((service) => ({
    inspect_elf_notes: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ElfNotesService>,
  elfDebugLink: ((service) => ({
    inspect_elf_debug_link: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ElfDebugLinkService>,
  nativeInitializers: ((service) => ({
    inspect_native_initializers: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<NativeInitializersService>,
  elfUnwindRanges: ((service) => ({
    inspect_elf_unwind_ranges: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ElfUnwindRangesService>,
  appleIps: ((service) => ({
    inspect_apple_ips: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<AppleIpsService>,
  kernelModule: ((service) => ({
    inspect_kernel_module: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<KernelModuleService>,
  kernelBuildConfig: ((service) => ({
    inspect_kernel_build_config: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<KernelBuildConfigService>,
  peLoadConfig: ((service) => ({
    inspect_pe_load_config: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeLoadConfigService>,
  peUnwindRanges: ((service) => ({
    inspect_pe_unwind_ranges: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeUnwindRangesService>,
  peOverlay: ((service) => ({
    inspect_pe_overlay: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeOverlayService>,
  releaseExposure: ((service) => ({
    audit_release_exposure: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ReleaseExposureService>,
  binaryHardening: ((service) => ({
    inspect_binary_hardening: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<BinaryHardeningService>,
  peCertificates: ((service) => ({
    inspect_pe_certificates: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeCertificatesService>,
  peImports: ((service) => ({
    inspect_pe_imports: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeImportsService>,
  windowsShortcut: ((service) => ({
    inspect_windows_shortcut: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<WindowsShortcutService>,
  recordedCrash: ((service) => ({
    inspect_recorded_crash: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<RecordedCrashService>,
  desktopApplication: ((service) => ({
    inspect_desktop_application: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<DesktopApplicationService>,
  modelArtifact: ((service, retention) => ({
    inspect_model_artifact: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<ModelArtifactService>,
  gpuCodeObjects: ((service, retention) => ({
    inspect_gpu_code_objects: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<GpuCodeObjectsService>,
  evmInterface: ((service) => ({
    inspect_evm_interface: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<EvmInterfaceService>,
  goBinary: ((service, retention) => ({
    inspect_go_binary: {
      admission: "application",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<GoBinaryService>,
  il2cppMetadata: ((service, retention) => ({
    inspect_il2cpp_metadata: {
      admission: "application",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<Il2cppMetadataService>,
  rustBinary: ((service, retention) => ({
    inspect_rust_binary: {
      admission: "application",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<RustBinaryService>,
  nugetNupkg: ((service) => ({
    inspect_nuget_nupkg: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<NugetNupkgService>,
  debPackage: ((service) => ({
    inspect_deb_package: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<DebPackageService>,
  vsixPackage: ((service) => ({
    inspect_vsix_package: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<VsixPackageService>,
  ociImageLayout: ((service) => ({
    inspect_oci_image_layout: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<OciImageLayoutService>,
  pythonPyc: ((service) => ({
    inspect_python_pyc: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PythonPycService>,
  erlangBeam: ((service) => ({
    inspect_erlang_beam: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<BeamService>,
  v8CodeCache: ((service) => ({
    inspect_v8_code_cache: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<V8CodeCacheService>,
  wasmArtifact: ((service, retention) => ({
    compare_wasm_interfaces: {
      admission: "sdk",
      run: async (rawInput, options) => {
        const result = retainAnalysisResultSources(
          "compare_wasm_interfaces",
          retention.recordEvidence,
          await compareWasmInterfaces(
            rawInput,
            options,
            retention.evidenceById,
          ),
          { sourceOwner: "caller" },
        );
        return result.ok ? ok(result.value.evidence) : result;
      },
    },
    inspect_wasm_artifact: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<Pick<WasmArtifactService, "inspect">>,
  apkSignature: ((service, retention) => ({
    inspect_apk_signature: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<Pick<ApkSignatureService, "inspect">>,
  sqliteDatabase: ((service) => ({
    inspect_sqlite_database: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<SqliteDatabaseService>,
  mavenGradleMetadata: ((service) => ({
    inspect_maven_gradle_metadata: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<MavenGradleMetadataService>,
  dwarfUnits: ((service) => ({
    inspect_dwarf_units: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<DwarfUnitsService>,
  elfDependencies: ((service) => ({
    inspect_elf_dependencies: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ElfDependenciesService>,
} as const;
