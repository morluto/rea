// oxlint-disable max-lines -- Keep the exhaustive static provenance bindings together; this table has no execution or host-availability logic.
import type { ProviderIdentity } from "../application/AnalysisProvider.js";
import type { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
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

/** Static provenance bindings; host availability belongs to runtime inspection. */
export interface CapabilityDeclaration {
  readonly providers: readonly {
    readonly identity: ProviderIdentity;
    readonly operations: readonly CanonicalOperationName[];
  }[];
}

const providerBinding = <
  const Operations extends readonly CanonicalOperationName[],
>(
  identity: ProviderIdentity,
  operations: Operations,
) => ({ identity, operations });

/** Shared source facts, with no factory, schema or generated-catalog imports. */
export const CAPABILITY_DECLARATIONS = {
  adbDevice: {
    providers: [
      providerBinding(ADB_PROVIDER_IDENTITY, [
        "capture_adb_screen",
        "collect_adb_bugreport",
        "inspect_adb_client",
        "inspect_adb_device",
        "inspect_adb_display",
        "inspect_adb_package",
        "inspect_adb_window",
        "install_adb_package",
        "list_adb_devices",
        "list_adb_directory",
        "list_adb_features",
        "list_adb_packages",
        "list_adb_processes",
        "list_adb_services",
        "pull_adb_file",
        "pull_adb_package",
        "push_adb_file",
        "read_adb_logcat",
        "read_adb_setting",
        "resolve_adb_packages",
        "start_adb_activity",
        "start_adb_app",
        "stop_adb_app",
        "uninstall_adb_package",
      ]),
    ],
  },
  analysisView: {
    providers: [
      providerBinding(ANALYSIS_VIEW_PROVIDER, ["inspect_analysis_view"]),
    ],
  },
  android: {
    providers: [
      providerBinding(JADX_PROVIDER_IDENTITY, [
        "inspect_android_class",
        "inspect_android_jni_bindings",
        "inspect_android_method",
        "inspect_android_package",
        "search_android_classes",
        "trace_android_references",
      ]),
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
      providerBinding(APK_SIGNATURE_PROVIDER_IDENTITY, [
        "inspect_apk_signature",
      ]),
    ],
  },
  apktool: {
    providers: [
      providerBinding(APKTOOL_PROVIDER_IDENTITY, [
        "decode_android_resources",
        "inspect_apktool_client",
      ]),
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
      providerBinding(ARTIFACT_GRAPH_PROVIDER, [
        "decode_interface_builder",
        "extract_artifact",
        "inspect_artifact",
        "inspect_asset_catalog",
        "inspect_keyed_archive",
        "trace_dylib_resolution",
      ]),
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
      providerBinding(CDP_BROWSER_PROVIDER_IDENTITY, [
        "analyze_web_bundle",
        "capture_web_screenshot",
        "compare_web_captures",
        "compare_web_screenshots",
        "discover_webmcp_tools",
        "inspect_web_event_listeners",
        "inspect_web_page",
        "list_browser_targets",
      ]),
    ],
  },
  browserScenarioCapture: {
    providers: [
      providerBinding(PLAYWRIGHT_BROWSER_SCENARIO_PROVIDER_IDENTITY, [
        "capture_browser_scenario",
      ]),
    ],
  },
  byteEntropy: {
    providers: [
      providerBinding(BYTE_ENTROPY_PROVIDER, ["inspect_byte_entropy"]),
    ],
  },
  cutter: {
    providers: [
      providerBinding(CUTTER_PROVIDER_IDENTITY, [
        "cutter_command",
        "list_cutter_sessions",
      ]),
    ],
  },
  desktopApplication: {
    providers: [
      providerBinding(ARTIFACT_GRAPH_PROVIDER, ["inspect_desktop_application"]),
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
      providerBinding(ERLANG_BEAM_PROVIDER_IDENTITY, ["inspect_erlang_beam"]),
    ],
  },
  evmInterface: {
    providers: [
      providerBinding(EVMOLE_PROVIDER_IDENTITY, ["inspect_evm_interface"]),
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
      providerBinding(FLUTTER_PROVIDER_IDENTITY, [
        "identify_flutter_build",
        "inspect_dart_aot",
      ]),
    ],
  },
  fridaInstrumentation: {
    providers: [
      providerBinding(FRIDA_PROVIDER_IDENTITY, [
        "close_frida_session",
        "frida_session_status",
        "instrument_with_frida",
        "list_frida_devices",
        "list_frida_processes",
        "load_frida_script",
        "resume_frida_session",
        "start_frida_session",
        "unload_frida_script",
      ]),
    ],
  },
  gdbSessions: {
    providers: [
      providerBinding(GDB_PROVIDER_IDENTITY, [
        "close_gdb_session",
        "gdb_console",
        "gdb_session_status",
        "start_gdb_session",
      ]),
    ],
  },
  ghidra: {
    providers: [providerBinding(GHIDRA_PROVIDER_IDENTITY, GHIDRA_OPERATIONS)],
  },
  goBinary: {
    providers: [
      providerBinding(GO_BINARY_PROVIDER_IDENTITY, ["inspect_go_binary"]),
    ],
  },
  gpuCodeObjects: {
    providers: [
      providerBinding(GPU_CODE_OBJECTS_PROVIDER_IDENTITY, [
        "inspect_gpu_code_objects",
      ]),
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
      providerBinding(IL2CPP_METADATA_PROVIDER_IDENTITY, [
        "inspect_il2cpp_metadata",
      ]),
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
      providerBinding(WAKARU_PROVIDER_IDENTITY, ["recover_javascript_sources"]),
    ],
  },
  javascriptRuntimeObservation: {
    providers: [
      providerBinding(V8_INSPECTOR_PROVIDER_IDENTITY, [
        "list_javascript_runtime_targets",
        "observe_javascript_runtime",
      ]),
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
      providerBinding(JEB_PROVIDER_IDENTITY, [
        "decompile_jeb_item",
        "inspect_jeb_client",
        "list_jeb_units",
        "open_jeb_project",
      ]),
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
      providerBinding(MANAGED_STATIC_PROVIDER, [
        "inspect_managed_artifact",
        "inspect_managed_members",
        "inspect_managed_native_boundaries",
      ]),
    ],
  },
  managedWorkflow: {
    providers: [
      providerBinding(MANAGED_WORKFLOW_PROVIDER, [
        "compare_managed_members",
        "import_managed_reconstruction",
        "project_managed_application_graph",
        "verify_managed_native_boundaries",
      ]),
    ],
  },
  modelArtifact: {
    providers: [
      providerBinding(MODEL_ARTIFACT_PROVIDER_IDENTITY, [
        "inspect_model_artifact",
      ]),
    ],
  },
  nativeExports: {
    providers: [
      providerBinding(NATIVE_EXPORTS_PROVIDER, ["inspect_native_exports"]),
    ],
  },
  nativeMacOS: {
    providers: [
      providerBinding(NATIVE_MACOS_PROVIDER_IDENTITY, [
        "capture_native_ui_scenario",
        "demangle_swift",
        "inspect_macho",
        "inspect_plist",
        "inspect_signature",
        "list_architectures",
        "observe_native_calls",
        "observe_native_ui",
      ]),
    ],
  },
  packetCapture: {
    providers: [
      providerBinding(TSHARK_PROVIDER_IDENTITY, [
        "inspect_packet_capture",
        "inspect_packet_fields",
      ]),
    ],
  },
  pcap: {
    providers: [
      providerBinding(PCAP_PROVIDER_IDENTITY, [
        "inspect_pcap_capture",
        "inspect_pcap_client",
      ]),
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
      providerBinding(PYTHON_PYC_PROVIDER_IDENTITY, ["inspect_python_pyc"]),
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
      providerBinding(RIZIN_DEBUGGER_PROVIDER_IDENTITY, [
        "close_rizin_debug_session",
        "rizin_debug_command",
        "rizin_debug_session_status",
        "start_rizin_debug_session",
      ]),
    ],
  },
  rustBinary: {
    providers: [
      providerBinding(RUST_BINARY_PROVIDER_IDENTITY, ["inspect_rust_binary"]),
    ],
  },
  signalRecording: {
    providers: [
      providerBinding(SIGROK_PROVIDER_IDENTITY, [
        "decode_signal_recording",
        "inspect_signal_decoders",
      ]),
    ],
  },
  sqliteDatabase: {
    providers: [
      providerBinding(SQLITE_PROVIDER_IDENTITY, ["inspect_sqlite_database"]),
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
      providerBinding(SAZ_CAPTURE_PROVIDER_IDENTITY, [
        "inspect_web_network_capture",
      ]),
      providerBinding(HAR_CAPTURE_PROVIDER_IDENTITY, [
        "inspect_web_network_capture",
      ]),
      providerBinding(MITMPROXY_CAPTURE_PROVIDER_IDENTITY, [
        "inspect_web_network_capture",
      ]),
      providerBinding(QLOG_CAPTURE_PROVIDER_IDENTITY, [
        "inspect_web_network_capture",
      ]),
    ],
  },
  webRuntime: {
    providers: [
      providerBinding(CDP_BROWSER_PROVIDER_IDENTITY, [
        "observe_web_execution",
        "observe_web_session",
      ]),
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
