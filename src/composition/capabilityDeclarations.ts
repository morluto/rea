// oxlint-disable max-lines -- Keep the exhaustive static provenance bindings together; this table has no execution or host-availability logic.
import type { ProviderIdentity } from "../application/AnalysisProvider.js";
import type { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { ToolContractGroupId } from "../contracts/toolFamilies.js";
import { ADB_PROVIDER_IDENTITY } from "../adb/AdbProviderIdentity.js";
import { JADX_PROVIDER_IDENTITY } from "../android/JadxRelease.js";
import { APK_SIGNATURE_PROVIDER_IDENTITY } from "../apkSignature/ApkSignatureRelease.js";
import { APKTOOL_PROVIDER_IDENTITY } from "../apktool/ApktoolProviderIdentity.js";
import {
  HAR_CAPTURE_PROVIDER_IDENTITY,
  MITMPROXY_CAPTURE_PROVIDER_IDENTITY,
  QLOG_CAPTURE_PROVIDER_IDENTITY,
  SAZ_CAPTURE_PROVIDER_IDENTITY,
} from "../browser/history/CaptureProviderIdentities.js";
import {
  CDP_BROWSER_PROVIDER_IDENTITY,
  CDP_ELECTRON_PROVIDER_IDENTITY,
  PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY,
  PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY,
} from "../browser/providerIdentities.js";
import { TSHARK_PROVIDER_IDENTITY } from "../captures/TsharkProviderIdentity.js";
import { CUTTER_PROVIDER_IDENTITY } from "../cutter/CutterProviderIdentity.js";
import {
  ANALYSIS_VIEW_PROVIDER,
  ANDROID_APPLICATION_PROVIDER,
  APPLE_APPLICATION_PROVIDER,
  APPLE_IPS_PROVIDER,
  ARTIFACT_GRAPH_PROVIDER,
  BYTE_ENTROPY_PROVIDER,
  DEVICETREE_PROVIDER,
  ELF_NOTES_PROVIDER,
  HARMONY_APPLICATION_PROVIDER,
  JAVASCRIPT_APPLICATION_PROVIDER,
  JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
  JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER,
  KERNEL_MODULE_PROVIDER,
  MANAGED_STATIC_PROVIDER,
  MANAGED_WORKFLOW_PROVIDER,
  NATIVE_EXPORTS_PROVIDER,
  PE_CERTIFICATES_PROVIDER,
  PE_IMPORTS_PROVIDER,
  PE_LOAD_CONFIG_PROVIDER,
  PE_RESOURCES_PROVIDER,
  WEB_SCRIPT_EXPORT_PROVIDER,
} from "../domain/investigationProviders.js";
import { SQLITE_PROVIDER_IDENTITY } from "../domain/sqlite/SqliteProviderIdentity.js";
import {
  WEB_MODULE_TRACE_PROVIDER,
  WEB_SOURCE_LOCATION_PROVIDER,
} from "../domain/webTraceProviders.js";
import { ELECTRON_FUSE_PROVIDER_IDENTITY } from "../electron/ElectronFuseProviderIdentity.js";
import { ERLANG_BEAM_PROVIDER_IDENTITY } from "../erlang/ErlangBeamProviderIdentity.js";
import { UNITY_ASSETS_PROVIDER_IDENTITY } from "../unity/UnityAssetsProviderIdentity.js";
import { EVMOLE_PROVIDER_IDENTITY } from "../evm/EvmoleProviderIdentity.js";
import {
  BINWALK_PROVIDER_IDENTITY,
  UNBLOB_PROVIDER_IDENTITY,
} from "../firmware/FirmwareProviderIdentities.js";
import { FLUTTER_PROVIDER_IDENTITY } from "../flutter/FlutterProviderIdentity.js";
import { FRIDA_PROVIDER_IDENTITY } from "../frida/FridaProviderIdentity.js";
import { GDB_PROVIDER_IDENTITY } from "../gdb/GdbProviderIdentity.js";
import {
  GHIDRA_OPERATIONS,
  GHIDRA_PROVIDER_IDENTITY,
} from "../ghidra/GhidraProviderMetadata.js";
import { GO_BINARY_PROVIDER_IDENTITY } from "../go/GoBinaryProviderIdentity.js";
import { GPU_CODE_OBJECTS_PROVIDER_IDENTITY } from "../gpu/GpuCodeObjectsProviderIdentity.js";
import {
  HOPPER_OPERATIONS,
  HOPPER_PROVIDER_IDENTITY,
} from "../hopper/HopperProviderMetadata.js";
import {
  IDA_OPERATIONS,
  IDA_PROVIDER_IDENTITY,
} from "../ida/IdaProviderMetadata.js";
import { IL2CPP_METADATA_PROVIDER_IDENTITY } from "../il2cpp/Il2CppMetadataProviderIdentity.js";
import { V8_INSPECTOR_PROVIDER_IDENTITY } from "../inspector/providerIdentity.js";
import { WAKARU_PROVIDER_IDENTITY } from "../javascript/recovery/WakaruProviderIdentity.js";
import { JEB_PROVIDER_IDENTITY } from "../jeb/JebProviderIdentity.js";
import {
  KUNA_OPERATIONS,
  KUNA_PROVIDER_IDENTITY,
} from "../kuna/KunaProviderMetadata.js";
import { MODEL_ARTIFACT_PROVIDER_IDENTITY } from "../model/ModelArtifactProviderIdentity.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY } from "../native/NativeMacosProviderIdentity.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "../native/pwntools/PwntoolsProviderIdentity.js";
import { OBJDUMP_PROVIDER_IDENTITY } from "../objdump/ObjdumpProviderIdentity.js";
import { PCAP_PROVIDER_IDENTITY } from "../pcap/PcapProviderIdentity.js";
import { PYTHON_PYC_PROVIDER_IDENTITY } from "../python/PythonPycProviderIdentity.js";
import { RIZIN_DEBUGGER_PROVIDER_IDENTITY } from "../rizin/RizinDebuggerProviderIdentity.js";
import { RIZIN_PROVIDER_IDENTITY } from "../rizin/RizinProviderIdentity.js";
import { RUST_BINARY_PROVIDER_IDENTITY } from "../rust/RustBinaryProviderIdentity.js";
import { SIGROK_PROVIDER_IDENTITY } from "../signals/SigrokProviderIdentity.js";
import { WABT_PROVIDER_IDENTITY } from "../wasm/WabtRelease.js";

type CanonicalOperationName = (typeof TOOL_CONTRACTS)[number]["name"];

/** Whole source groups grow with their canonical contracts; provider subsets stay explicit. */
export type CapabilityOperationSelection =
  | readonly CanonicalOperationName[]
  | { readonly group: ToolContractGroupId };

/** Static provenance bindings; host availability belongs to runtime inspection. */
export interface CapabilityDeclaration {
  readonly providers: readonly {
    readonly identity: ProviderIdentity;
    readonly operations: CapabilityOperationSelection;
  }[];
}

const providerBinding = <const Operations extends CapabilityOperationSelection>(
  identity: ProviderIdentity,
  operations: Operations,
) => ({ identity, operations });

/** Shared source facts, with no factory, schema or generated-catalog imports. */
export const CAPABILITY_DECLARATIONS = {
  adbDevice: {
    providers: [
      providerBinding(ADB_PROVIDER_IDENTITY, { group: "ADB_TOOL_CONTRACTS" }),
    ],
  },
  analysisView: {
    providers: [
      providerBinding(ANALYSIS_VIEW_PROVIDER, {
        group: "ANALYSIS_VIEW_TOOL_CONTRACTS",
      }),
    ],
  },
  android: {
    providers: [
      providerBinding(JADX_PROVIDER_IDENTITY, {
        group: "ANDROID_TOOL_CONTRACTS",
      }),
    ],
  },
  androidApplicationGraph: {
    providers: [
      providerBinding(ANDROID_APPLICATION_PROVIDER, [
        "project_android_application_graph",
      ]),
    ],
  },
  apkSignature: {
    providers: [
      providerBinding(APK_SIGNATURE_PROVIDER_IDENTITY, {
        group: "APK_SIGNATURE_TOOL_CONTRACTS",
      }),
    ],
  },
  apktool: {
    providers: [
      providerBinding(APKTOOL_PROVIDER_IDENTITY, {
        group: "APKTOOL_TOOL_CONTRACTS",
      }),
    ],
  },
  appleApplicationGraph: {
    providers: [
      providerBinding(APPLE_APPLICATION_PROVIDER, [
        "project_apple_application_graph",
      ]),
    ],
  },
  appleIps: {
    providers: [providerBinding(APPLE_IPS_PROVIDER, ["inspect_apple_ips"])],
  },
  applicationWorkflows: {
    providers: [
      providerBinding(JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER, [
        "build_reconstruction_obligation_ledger",
        "compare_application_versions",
        "compare_javascript_export_shapes",
        "compare_source_to_bundle",
        "evaluate_reconstruction_coverage",
        "guided_workflows",
        "read_guidance_section",
        "search_guidance",
        "trace_application_feature",
        "trace_javascript_semantics",
      ]),
    ],
  },
  artifactGraph: {
    providers: [
      providerBinding(ARTIFACT_GRAPH_PROVIDER, {
        group: "ARTIFACT_TOOL_CONTRACTS",
      }),
    ],
  },
  artifactResources: { providers: [] },
  binaryLayout: {
    providers: [
      providerBinding(PWNTOOLS_PROVIDER_IDENTITY, ["inspect_binary_layout"]),
    ],
  },
  browserObservation: {
    providers: [
      providerBinding(CDP_BROWSER_PROVIDER_IDENTITY, {
        group: "BROWSER_TOOL_CONTRACTS",
      }),
    ],
  },
  browserScenarioCapture: {
    providers: [
      providerBinding(PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY, {
        group: "BROWSER_SCENARIO_TOOL_CONTRACTS",
      }),
    ],
  },
  byteEntropy: {
    providers: [
      providerBinding(BYTE_ENTROPY_PROVIDER, ["inspect_byte_entropy"]),
    ],
  },
  cutter: {
    providers: [
      providerBinding(CUTTER_PROVIDER_IDENTITY, {
        group: "CUTTER_TOOL_CONTRACTS",
      }),
    ],
  },
  desktopApplication: {
    providers: [
      providerBinding(ARTIFACT_GRAPH_PROVIDER, {
        group: "DESKTOP_APPLICATION_TOOL_CONTRACTS",
      }),
    ],
  },
  devicetree: {
    providers: [providerBinding(DEVICETREE_PROVIDER, ["inspect_devicetree"])],
  },
  electronActiveObservation: {
    providers: [
      providerBinding(PLAYWRIGHT_ELECTRON_ACTIVE_PROVIDER_IDENTITY, [
        "capture_electron_scenario",
      ]),
    ],
  },
  electronFuses: {
    providers: [
      providerBinding(ELECTRON_FUSE_PROVIDER_IDENTITY, [
        "inspect_electron_fuses",
      ]),
    ],
  },
  electronObservation: {
    providers: [
      providerBinding(CDP_ELECTRON_PROVIDER_IDENTITY, [
        "inspect_electron_page",
        "list_electron_targets",
      ]),
    ],
  },
  elfNotes: {
    providers: [providerBinding(ELF_NOTES_PROVIDER, ["inspect_elf_notes"])],
  },
  erlangBeam: {
    providers: [
      providerBinding(ERLANG_BEAM_PROVIDER_IDENTITY, {
        group: "ERLANG_BEAM_TOOL_CONTRACTS",
      }),
    ],
  },
  unityAssets: {
    providers: [
      providerBinding(UNITY_ASSETS_PROVIDER_IDENTITY, {
        group: "UNITY_TOOL_CONTRACTS",
      }),
    ],
  },
  evmInterface: {
    providers: [
      providerBinding(EVMOLE_PROVIDER_IDENTITY, {
        group: "EVM_TOOL_CONTRACTS",
      }),
    ],
  },
  firmwareAnalysis: {
    providers: [
      providerBinding(BINWALK_PROVIDER_IDENTITY, ["inspect_firmware_regions"]),
      providerBinding(UNBLOB_PROVIDER_IDENTITY, ["extract_firmware"]),
    ],
  },
  flutter: {
    providers: [
      providerBinding(FLUTTER_PROVIDER_IDENTITY, {
        group: "FLUTTER_TOOL_CONTRACTS",
      }),
    ],
  },
  fridaInstrumentation: {
    providers: [
      providerBinding(FRIDA_PROVIDER_IDENTITY, {
        group: "FRIDA_TOOL_CONTRACTS",
      }),
    ],
  },
  gdbSessions: {
    providers: [
      providerBinding(GDB_PROVIDER_IDENTITY, { group: "GDB_TOOL_CONTRACTS" }),
    ],
  },
  ghidra: {
    providers: [providerBinding(GHIDRA_PROVIDER_IDENTITY, GHIDRA_OPERATIONS)],
  },
  goBinary: {
    providers: [
      providerBinding(GO_BINARY_PROVIDER_IDENTITY, {
        group: "GO_TOOL_CONTRACTS",
      }),
    ],
  },
  gpuCodeObjects: {
    providers: [
      providerBinding(GPU_CODE_OBJECTS_PROVIDER_IDENTITY, {
        group: "GPU_TOOL_CONTRACTS",
      }),
    ],
  },
  harmonyApplicationGraph: {
    providers: [
      providerBinding(HARMONY_APPLICATION_PROVIDER, [
        "project_harmony_application_graph",
      ]),
    ],
  },
  hopper: {
    providers: [providerBinding(HOPPER_PROVIDER_IDENTITY, HOPPER_OPERATIONS)],
  },
  ida: {
    providers: [providerBinding(IDA_PROVIDER_IDENTITY, IDA_OPERATIONS)],
  },
  il2cppMetadata: {
    providers: [
      providerBinding(IL2CPP_METADATA_PROVIDER_IDENTITY, {
        group: "IL2CPP_TOOL_CONTRACTS",
      }),
    ],
  },
  javascriptApplication: {
    providers: [
      providerBinding(JAVASCRIPT_APPLICATION_PROVIDER, [
        "analyze_javascript_application",
      ]),
    ],
  },
  javascriptRecovery: {
    providers: [
      providerBinding(WAKARU_PROVIDER_IDENTITY, {
        group: "JAVASCRIPT_RECOVERY_TOOL_CONTRACTS",
      }),
    ],
  },
  javascriptRuntimeObservation: {
    providers: [
      providerBinding(V8_INSPECTOR_PROVIDER_IDENTITY, {
        group: "JAVASCRIPT_RUNTIME_OBSERVATION_TOOL_CONTRACTS",
      }),
    ],
  },
  javascriptRuntimeReconciliation: {
    providers: [
      providerBinding(JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER, [
        "reconcile_javascript_runtime",
      ]),
    ],
  },
  jeb: {
    providers: [
      providerBinding(JEB_PROVIDER_IDENTITY, { group: "JEB_TOOL_CONTRACTS" }),
    ],
  },
  kernelModule: {
    providers: [
      providerBinding(KERNEL_MODULE_PROVIDER, ["inspect_kernel_module"]),
    ],
  },
  kuna: {
    providers: [providerBinding(KUNA_PROVIDER_IDENTITY, KUNA_OPERATIONS)],
  },
  managedStatic: {
    providers: [
      providerBinding(MANAGED_STATIC_PROVIDER, {
        group: "MANAGED_TOOL_CONTRACTS",
      }),
    ],
  },
  managedWorkflow: {
    providers: [
      providerBinding(MANAGED_WORKFLOW_PROVIDER, {
        group: "MANAGED_WORKFLOW_TOOL_CONTRACTS",
      }),
    ],
  },
  modelArtifact: {
    providers: [
      providerBinding(MODEL_ARTIFACT_PROVIDER_IDENTITY, {
        group: "MODEL_TOOL_CONTRACTS",
      }),
    ],
  },
  nativeExports: {
    providers: [
      providerBinding(NATIVE_EXPORTS_PROVIDER, ["inspect_native_exports"]),
    ],
  },
  nativeMacOS: {
    providers: [
      providerBinding(NATIVE_MACOS_PROVIDER_IDENTITY, {
        group: "NATIVE_TOOL_CONTRACTS",
      }),
    ],
  },
  packetCapture: {
    providers: [
      providerBinding(TSHARK_PROVIDER_IDENTITY, {
        group: "CAPTURE_TOOL_CONTRACTS",
      }),
    ],
  },
  pcap: {
    providers: [
      providerBinding(PCAP_PROVIDER_IDENTITY, { group: "PCAP_TOOL_CONTRACTS" }),
    ],
  },
  peCertificates: {
    providers: [
      providerBinding(PE_CERTIFICATES_PROVIDER, ["inspect_pe_certificates"]),
    ],
  },
  peImports: {
    providers: [providerBinding(PE_IMPORTS_PROVIDER, ["inspect_pe_imports"])],
  },
  peLoadConfig: {
    providers: [
      providerBinding(PE_LOAD_CONFIG_PROVIDER, ["inspect_pe_load_config"]),
    ],
  },
  peResources: {
    providers: [
      providerBinding(PE_RESOURCES_PROVIDER, ["inspect_pe_resources"]),
    ],
  },
  pythonPyc: {
    providers: [
      providerBinding(PYTHON_PYC_PROVIDER_IDENTITY, {
        group: "PYTHON_PYC_TOOL_CONTRACTS",
      }),
    ],
  },
  recordedCrash: {
    providers: [
      providerBinding(PWNTOOLS_PROVIDER_IDENTITY, ["inspect_recorded_crash"]),
    ],
  },
  reverseEngineering: {
    providers: [
      providerBinding(OBJDUMP_PROVIDER_IDENTITY, ["inspect_with_objdump"]),
      providerBinding(RIZIN_PROVIDER_IDENTITY, ["execute_rizin_command"]),
    ],
  },
  rizinDebugSessions: {
    providers: [
      providerBinding(RIZIN_DEBUGGER_PROVIDER_IDENTITY, {
        group: "RIZIN_DEBUG_TOOL_CONTRACTS",
      }),
    ],
  },
  rustBinary: {
    providers: [
      providerBinding(RUST_BINARY_PROVIDER_IDENTITY, {
        group: "RUST_TOOL_CONTRACTS",
      }),
    ],
  },
  signalRecording: {
    providers: [
      providerBinding(SIGROK_PROVIDER_IDENTITY, {
        group: "SIGNAL_TOOL_CONTRACTS",
      }),
    ],
  },
  sqliteDatabase: {
    providers: [
      providerBinding(SQLITE_PROVIDER_IDENTITY, {
        group: "SQLITE_TOOL_CONTRACTS",
      }),
    ],
  },
  wasmArtifact: {
    providers: [
      providerBinding(WABT_PROVIDER_IDENTITY, ["inspect_wasm_artifact"]),
    ],
  },
  webModuleTrace: {
    providers: [
      providerBinding(WEB_MODULE_TRACE_PROVIDER, ["trace_web_module_imports"]),
    ],
  },
  webNetworkCapture: {
    providers: [
      providerBinding(SAZ_CAPTURE_PROVIDER_IDENTITY, {
        group: "WEB_NETWORK_CAPTURE_TOOL_CONTRACTS",
      }),
      providerBinding(HAR_CAPTURE_PROVIDER_IDENTITY, {
        group: "WEB_NETWORK_CAPTURE_TOOL_CONTRACTS",
      }),
      providerBinding(MITMPROXY_CAPTURE_PROVIDER_IDENTITY, {
        group: "WEB_NETWORK_CAPTURE_TOOL_CONTRACTS",
      }),
      providerBinding(QLOG_CAPTURE_PROVIDER_IDENTITY, {
        group: "WEB_NETWORK_CAPTURE_TOOL_CONTRACTS",
      }),
    ],
  },
  webRuntime: {
    providers: [
      providerBinding(CDP_BROWSER_PROVIDER_IDENTITY, {
        group: "WEB_RUNTIME_TOOL_CONTRACTS",
      }),
    ],
  },
  webScriptExport: {
    providers: [
      providerBinding(WEB_SCRIPT_EXPORT_PROVIDER, ["export_web_scripts"]),
    ],
  },
  webSourceLocation: {
    providers: [
      providerBinding(WEB_SOURCE_LOCATION_PROVIDER, [
        "trace_web_source_location",
      ]),
    ],
  },
} as const satisfies Readonly<Record<string, CapabilityDeclaration>>;

export type CapabilityDeclarationId = keyof typeof CAPABILITY_DECLARATIONS;
