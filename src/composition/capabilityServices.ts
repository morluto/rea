import type { OptionalProviderLoadFailures } from "../application/OptionalObservationProviders.js";
import {
  locateWiresharkTool,
  selectWiresharkTool,
} from "../pcap/PcapConfiguration.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import { CapabilityScope } from "../application/CapabilityScope.js";
import type { CapabilityAvailabilityFacts } from "../application/CapabilityAvailability.js";
import {
  CAPABILITY_DECLARATIONS,
  type CapabilityDeclarationId,
} from "./capabilityDeclarations.js";
import { isAbsolute } from "node:path";
import { createGpuCodeObjectsService } from "./gpu.js";
import { createPacketCaptureService, tsharkHostSupported } from "./captures.js";
import {
  createSignalRecordingService,
  sigrokHostSupported,
} from "./signals.js";
import { wasmArtifactModule } from "./wasm.js";
import { apkSignatureModule } from "./apkSignature.js";
import {
  evmInterfaceModule,
  evmHostSupported,
  evmLimiterAvailability,
} from "./evm.js";
import { createSqliteDatabaseService } from "./sqlite.js";
import { createDesktopApplicationService } from "./desktop.js";
import { createGoBinaryService } from "./go.js";
import { createRustBinaryService } from "./rust.js";
import { createBeamService } from "./erlang.js";
import { createUnityAssetsService } from "./unityAssets.js";
import { createModelArtifactService } from "./model.js";
import { createIl2cppMetadataService } from "./il2cpp.js";
import { createElectronFuseService } from "./electronFuses.js";
import { createPythonPycService } from "./pythonPyc.js";
import { createWebNetworkCaptureService } from "./webNetworkCaptures.js";
import { createWebSourceLocationService } from "./webSourceLocations.js";
import { createWebModuleTraceService } from "./webModules.js";
import { createWebRuntimeService } from "./webRuntime.js";
import {
  createJavaScriptRecoveryProvider,
  wakaruHostSupported,
} from "./javascriptRecovery.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { createReverseEngineeringService } from "./reverseEngineering.js";
import { FirmwareAnalysisService } from "../application/firmware/FirmwareAnalysisService.js";
import {
  createFirmwareAnalysisProvider,
  firmwareHostSupported,
} from "./firmware.js";
import { createAndroidAnalysisProvider } from "./android.js";
import { createPcapAnalysisProvider } from "./pcap.js";
import { createFlutterBuildAnalysisProvider } from "./flutter.js";
import { createApktoolResourceAnalysisProvider } from "./apktool.js";
import { createJebAnalysisProvider } from "./jeb.js";
import { createAdbDeviceAnalysisProvider } from "./adb.js";
import { createFridaInstrumentationProvider } from "./frida.js";
import { createCutterBridgeService } from "./cutter.js";
import {
  createGdbSessionManager,
  createRizinDebugSessionManager,
} from "./debuggerSessions.js";
import { persistentDebuggerHostSupported } from "../process/PersistentDebuggerHost.js";
import { pcapCaptureHostSupported } from "../domain/pcap/pcapAnalysis.js";
import {
  createPeLoadConfigService,
  createPeCertificatesService,
  createPeImportsService,
  createNativeExportsService,
  createPeResourcesService,
  createRecordedCrashService,
  createBinaryLayoutService,
  pwntoolsHostSupported,
  createDevicetreeService,
  createElfNotesService,
  createAppleIpsService,
  createKernelModuleService,
} from "./binaryDiagnostics.js";

import type { PacketCaptureService } from "../application/captures/PacketCaptureService.js";
import type { SignalRecordingService } from "../application/signals/SignalRecordingService.js";
import type { WasmArtifactService } from "../application/wasm/WasmArtifactService.js";
import type { ApkSignatureService } from "../application/apkSignature/ApkSignatureService.js";
import type { EvmInterfaceService } from "../application/evm/EvmInterfaceService.js";
import type { SqliteDatabaseService } from "../application/sqlite/SqliteDatabaseService.js";
import type { Il2cppMetadataService } from "../application/il2cpp/Il2cppMetadataService.js";
import type { GoBinaryService } from "../application/go/GoBinaryService.js";
import type { ElectronFuseService } from "../application/electron/ElectronFuseService.js";
import type { RustBinaryService } from "../application/rust/RustBinaryService.js";
import type { PythonPycService } from "../application/python/PythonPycService.js";
import type { BeamService } from "../application/erlang/BeamService.js";
import type { RecordedCrashService } from "../application/binaryDiagnostics/RecordedCrashService.js";
import type { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type { ElectronActiveObservationPort } from "../application/javascript/ElectronActiveObservationPort.js";
import type { ElectronObservationPort } from "../application/javascript/ElectronObservationPort.js";
import type { JavaScriptRuntimeObservationPort } from "../application/javascript/JavaScriptRuntimeObservationPort.js";
import type { FridaInstrumentationPort } from "../application/frida/FridaInstrumentationPort.js";
import type { WebModuleTraceService } from "../application/WebModuleTraceService.js";
import type { WebSourceLocationService } from "../application/WebSourceLocationService.js";
import type { WebRuntimeService } from "../application/WebRuntimeService.js";
import type { WebNetworkCaptureService } from "../application/WebNetworkCaptureService.js";
import type { JavaScriptRecoveryPort } from "../application/javascript/JavaScriptRecoveryPort.js";
import type { FirmwareAnalysisPort } from "../application/firmware/FirmwareAnalysisPort.js";
import type { AndroidAnalysisPort } from "../application/android/AndroidAnalysisPort.js";
import type { ApktoolResourceAnalysisPort } from "../application/apktool/ApktoolResourceAnalysisPort.js";
import type { PcapAnalysisPort } from "../application/pcap/PcapAnalysisPort.js";
import type { FlutterBuildAnalysisPort } from "../application/flutter/FlutterBuildAnalysisPort.js";
import type { JebAnalysisPort } from "../application/jeb/JebAnalysisPort.js";
import type { AdbDeviceAnalysisPort } from "../application/adb/AdbDeviceAnalysisPort.js";

/** Typed injection inputs shared by a capability host, independent of transport. */
export interface CapabilityServiceOptions {
  readonly packetCapture?: PacketCaptureService;
  readonly signalRecording?: SignalRecordingService;
  readonly wasmArtifact?: WasmArtifactService;
  readonly apkSignature?: ApkSignatureService;
  readonly evmInterface?: EvmInterfaceService;
  readonly sqliteDatabase?: SqliteDatabaseService;
  readonly binaryLayout?: BinaryLayoutService;
  readonly goBinary?: GoBinaryService;
  readonly il2cppMetadata?: Il2cppMetadataService;
  readonly rustBinary?: RustBinaryService;
  readonly pythonPyc?: PythonPycService;
  readonly erlangBeam?: BeamService;
  readonly electronFuses?: ElectronFuseService;
  readonly recordedCrash?: RecordedCrashService;
  readonly firmwareAnalysis?: FirmwareAnalysisPort;
  readonly javascriptRecovery?: JavaScriptRecoveryPort;
  readonly webModuleTrace?: WebModuleTraceService;
  readonly webSourceLocation?: WebSourceLocationService;
  readonly webRuntime?: WebRuntimeService;
  readonly webNetworkCapture?: WebNetworkCaptureService;
  readonly androidAnalysis?: AndroidAnalysisPort;
  readonly apktoolAnalysis?: ApktoolResourceAnalysisPort;
  readonly pcapAnalysis?: PcapAnalysisPort;
  readonly flutterAnalysis?: FlutterBuildAnalysisPort;
  readonly jebAnalysis?: JebAnalysisPort;
  readonly adbDeviceAnalysis?: AdbDeviceAnalysisPort;
  readonly browserObservation?: BrowserObservationPort;
  readonly browserScenarioCapture?: BrowserScenarioCapturePort;
  readonly electronObservation?: ElectronObservationPort;
  readonly optionalObservationProviderOwner?: "server" | "caller";
  readonly optionalProviderLoadFailures?: OptionalProviderLoadFailures;
  readonly electronActiveObservation?: ElectronActiveObservationPort;
  readonly javascriptRuntimeObservation?: JavaScriptRuntimeObservationPort;
  readonly fridaInstrumentation?: FridaInstrumentationPort;
}

const tsharkLocatable = (environment: Readonly<NodeJS.ProcessEnv>): boolean => {
  try {
    return (
      locateWiresharkTool(
        selectWiresharkTool(environment, "tshark"),
        environment,
      ) !== undefined
    );
  } catch {
    // A relative REA_TSHARK_COMMAND is configuration the tool reports at execution.
    return false;
  }
};

export interface CapabilityHostContext {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly providerEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly settings: AnalysisSettingsReader;
  readonly options: CapabilityServiceOptions;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

interface CapabilityInstance<Value> {
  readonly value: Value;
  readonly close: () => Promise<void>;
  readonly ownership: "host" | "caller";
  readonly availability?: CapabilityAvailabilityFacts;
}

const capability =
  <Value>(
    create: (context: CapabilityHostContext) => Value,
    close: (value: Value) => Promise<void>,
    observe?: (
      context: CapabilityHostContext,
      value: Value,
    ) => CapabilityAvailabilityFacts,
    ownership: (context: CapabilityHostContext) => "host" | "caller" = () =>
      "host",
  ) =>
  (context: CapabilityHostContext): CapabilityInstance<Value> => {
    const value = create(context);
    return {
      value,
      close: () => close(value),
      ownership: ownership(context),
      ...(observe === undefined
        ? {}
        : { availability: observe(context, value) }),
    };
  };

const service = <Value extends { close(): Promise<void> }>(
  create: (context: CapabilityHostContext) => Value,
  observe?: (
    context: CapabilityHostContext,
    value: Value,
  ) => CapabilityAvailabilityFacts,
) => capability(create, (value) => value.close(), observe);

const outsideHost = (injected: unknown, supported: boolean): boolean =>
  injected === undefined && !supported;
const configuredPwntools = (context: CapabilityHostContext): boolean =>
  pwntoolsHostSupported(context.platform, context.arch) &&
  isAbsolute(context.environment.REA_PWNTOOLS_PYTHON ?? "");
const sharedObservationOwnership = (context: CapabilityHostContext) =>
  context.options.optionalObservationProviderOwner === "caller"
    ? "caller"
    : "host";
const closeObservation = (value: { close?: () => Promise<void> } | undefined) =>
  value?.close?.() ?? Promise.resolve();

/** Each entry binds construction, ownership and observed availability once. */
const modules = {
  wasmArtifact: service(
    ({ environment, options, settings }) =>
      wasmArtifactModule.create(environment, options.wasmArtifact, settings),
    ({ environment, options }) => ({
      optionalFeatures: {
        wasmArtifactEnabled:
          options.wasmArtifact !== undefined ||
          isAbsolute(environment.REA_WABT_BIN_DIRECTORY ?? ""),
      },
    }),
  ),
  apkSignature: service(({ environment, options }) =>
    apkSignatureModule.create(environment, options.apkSignature),
  ),
  evmInterface: service(
    ({ environment, options }) =>
      options.evmInterface ?? evmInterfaceModule.create(environment),
    ({ environment, options, platform, arch }) => ({
      hostUnsupported: {
        evmInterface: outsideHost(
          options.evmInterface,
          evmHostSupported(platform, arch),
        ),
      },
      optionalFeatures: {
        evmInterfaceEnabled:
          options.evmInterface !== undefined ||
          evmHostSupported(platform, arch),
      },
      ...(options.evmInterface !== undefined ||
      !evmHostSupported(platform, arch)
        ? {}
        : {
            probes: {
              evmLimiterAvailability: (signal: AbortSignal) =>
                evmLimiterAvailability(environment, { signal }),
            },
          }),
    }),
  ),
  sqliteDatabase: service(
    ({ environment, options }) =>
      options.sqliteDatabase ?? createSqliteDatabaseService(environment),
  ),
  binaryLayout: service(
    ({ environment, options }) =>
      options.binaryLayout ?? createBinaryLayoutService(environment),
    (context) => ({
      hostUnsupported: {
        binaryLayout: outsideHost(
          context.options.binaryLayout,
          pwntoolsHostSupported(context.platform, context.arch),
        ),
      },
      optionalFeatures: {
        binaryLayoutEnabled:
          context.options.binaryLayout !== undefined ||
          configuredPwntools(context),
      },
    }),
  ),
  recordedCrash: service(
    ({ environment, options }) =>
      options.recordedCrash ?? createRecordedCrashService(environment),
    (context) => ({
      hostUnsupported: {
        recordedCrash: outsideHost(
          context.options.recordedCrash,
          pwntoolsHostSupported(context.platform, context.arch),
        ),
      },
      optionalFeatures: {
        recordedCrashEnabled:
          context.options.recordedCrash !== undefined ||
          configuredPwntools(context),
      },
    }),
  ),
  webSourceLocation: service(
    ({ environment, options }) =>
      options.webSourceLocation ?? createWebSourceLocationService(environment),
  ),
  webModuleTrace: service(
    ({ environment, options }) =>
      options.webModuleTrace ?? createWebModuleTraceService(environment),
    ({ environment, options }) => ({
      optionalFeatures: {
        webModuleResolutionEnabled:
          options.webModuleTrace !== undefined ||
          isAbsolute(environment.REA_BROWSER_EXECUTABLE ?? ""),
      },
    }),
  ),
  desktopApplication: service(() => createDesktopApplicationService()),
  goBinary: service(
    ({ options }) => options.goBinary ?? createGoBinaryService(),
  ),
  rustBinary: service(
    ({ options }) => options.rustBinary ?? createRustBinaryService(),
  ),
  erlangBeam: service(
    ({ options }) => options.erlangBeam ?? createBeamService(),
  ),
  modelArtifact: service(() => createModelArtifactService()),
  gpuCodeObjects: service(() => createGpuCodeObjectsService()),
  il2cppMetadata: service(
    ({ options }) => options.il2cppMetadata ?? createIl2cppMetadataService(),
  ),
  peResources: service(() => createPeResourcesService()),
  nativeExports: service(() => createNativeExportsService()),
  devicetree: service(() => createDevicetreeService()),
  elfNotes: service(() => createElfNotesService()),
  appleIps: service(() => createAppleIpsService()),
  unityAssets: service(() => createUnityAssetsService()),
  kernelModule: service(() => createKernelModuleService()),
  peLoadConfig: service(() => createPeLoadConfigService()),
  peCertificates: service(() => createPeCertificatesService()),
  peImports: service(() => createPeImportsService()),
  electronFuses: service(
    ({ options }) => options.electronFuses ?? createElectronFuseService(),
  ),
  pythonPyc: service(
    ({ options }) => options.pythonPyc ?? createPythonPycService(),
  ),
  webNetworkCapture: service(
    ({ environment, options, settings }) =>
      options.webNetworkCapture ??
      createWebNetworkCaptureService(environment, settings),
  ),
  javascriptRecovery: capability(
    ({ environment, options }) =>
      options.javascriptRecovery ??
      createJavaScriptRecoveryProvider(environment),
    (value) => value.close?.() ?? Promise.resolve(),
    ({ environment, options, platform, arch }) => ({
      hostUnsupported: {
        javascriptRecovery: outsideHost(
          options.javascriptRecovery,
          wakaruHostSupported(platform, arch),
        ),
      },
      optionalFeatures: {
        javascriptRecoveryEnabled:
          options.javascriptRecovery !== undefined ||
          (wakaruHostSupported(platform, arch) &&
            isAbsolute(environment.REA_WAKARU_COMMAND ?? "")),
      },
    }),
  ),
  artifactResources: service(() => new ArtifactResourceScope()),
  reverseEngineering: service(({ providerEnvironment }) =>
    createReverseEngineeringService(providerEnvironment),
  ),
  firmwareAnalysis: service(
    ({ environment, options }) =>
      new FirmwareAnalysisService(
        options.firmwareAnalysis ?? createFirmwareAnalysisProvider(environment),
      ),
    ({ environment, options, platform }) => ({
      hostUnsupported: {
        firmwareInspection: outsideHost(
          options.firmwareAnalysis,
          firmwareHostSupported(platform),
        ),
        firmwareExtraction: outsideHost(
          options.firmwareAnalysis,
          firmwareHostSupported(platform),
        ),
      },
      optionalFeatures: {
        firmwareInspectionEnabled:
          options.firmwareAnalysis !== undefined ||
          (firmwareHostSupported(platform) &&
            isAbsolute(environment.REA_BINWALK_COMMAND ?? "")),
        firmwareExtractionEnabled:
          options.firmwareAnalysis !== undefined ||
          (firmwareHostSupported(platform) &&
            isAbsolute(environment.REA_UNBLOB_COMMAND ?? "")),
      },
    }),
  ),
  gdbSessions: capability(
    ({ providerEnvironment }) => createGdbSessionManager(providerEnvironment),
    (value) => value.closeAll(),
    ({ platform }) => ({
      hostUnsupported: {
        persistentDebugger: !persistentDebuggerHostSupported(platform),
      },
    }),
  ),
  rizinDebugSessions: capability(
    ({ providerEnvironment }) =>
      createRizinDebugSessionManager(providerEnvironment),
    (value) => value.closeAll(),
  ),
  android: service(
    ({ environment, options, settings }) =>
      options.androidAnalysis ??
      createAndroidAnalysisProvider(environment, undefined, settings),
    (_context, value) => ({
      probes: {
        androidAnalysisAvailability: (signal: AbortSignal) =>
          value.inspectAvailability(signal),
      },
    }),
  ),
  pcap: service(
    ({ environment, options }) =>
      options.pcapAnalysis ?? createPcapAnalysisProvider(environment),
    ({ options, platform }) => ({
      hostUnsupported: {
        pcapCapture: outsideHost(
          options.pcapAnalysis,
          pcapCaptureHostSupported(platform),
        ),
      },
    }),
  ),
  flutter: service(
    ({ options }) =>
      options.flutterAnalysis ?? createFlutterBuildAnalysisProvider(),
  ),
  fridaInstrumentation: capability(
    ({ options }) =>
      options.fridaInstrumentation ?? createFridaInstrumentationProvider(),
    (value) => value.closeAll(),
    ({ options }, value) => ({
      observeProviderLoadFailures: () => {
        const failure =
          options.optionalProviderLoadFailures?.fridaInstrumentation ??
          value.availabilityFailure?.();
        return failure === undefined ? {} : { fridaInstrumentation: failure };
      },
    }),
  ),
  packetCapture: service(
    ({ environment, options }) =>
      options.packetCapture ?? createPacketCaptureService(environment),
    ({ environment, options, platform }) => ({
      hostUnsupported: {
        packetCapture: outsideHost(
          options.packetCapture,
          tsharkHostSupported(platform),
        ),
      },
      optionalFeatures: {
        packetCaptureEnabled:
          options.packetCapture !== undefined ||
          (tsharkHostSupported(platform) && tsharkLocatable(environment)),
      },
    }),
  ),
  signalRecording: service(
    ({ environment, options }) =>
      options.signalRecording ?? createSignalRecordingService(environment),
    ({ environment, options, platform }) => ({
      hostUnsupported: {
        signalRecording: outsideHost(
          options.signalRecording,
          sigrokHostSupported(platform),
        ),
      },
      optionalFeatures: {
        signalRecordingEnabled:
          options.signalRecording !== undefined ||
          (sigrokHostSupported(platform) &&
            isAbsolute(environment.REA_SIGROK_COMMAND ?? "")),
      },
    }),
  ),
  webRuntime: capability(
    ({ options }) => options.webRuntime ?? createWebRuntimeService(),
    (value) => value.provider.close?.() ?? Promise.resolve(),
  ),
  apktool: service(
    ({ environment, options }) =>
      options.apktoolAnalysis ??
      createApktoolResourceAnalysisProvider(environment),
    (_context, value) => ({
      probes: {
        apktoolAnalysisAvailability: (signal: AbortSignal) =>
          value.inspectAvailability(signal),
      },
    }),
  ),
  jeb: service(
    ({ environment, options }) =>
      options.jebAnalysis ?? createJebAnalysisProvider(environment),
    (_context, value) => ({
      probes: {
        jebAnalysisAvailability: (signal: AbortSignal) =>
          value.inspectAvailability(signal),
      },
    }),
  ),
  adbDevice: service(
    ({ environment, options }) =>
      options.adbDeviceAnalysis ?? createAdbDeviceAnalysisProvider(environment),
    (_context, value) => ({
      probes: {
        adbAnalysisAvailability: (signal: AbortSignal) =>
          value.inspectAvailability(signal),
      },
    }),
  ),
  cutter: service(({ providerEnvironment }) =>
    createCutterBridgeService(providerEnvironment),
  ),
  browserObservation: capability(
    ({ options }) => options.browserObservation,
    closeObservation,
    ({ options }) => ({
      optionalFeatures: {
        browserObservationEnabled: options.browserObservation !== undefined,
      },
    }),
    sharedObservationOwnership,
  ),
  browserScenarioCapture: capability(
    ({ options }) => options.browserScenarioCapture,
    closeObservation,
    ({ options }) => ({
      optionalFeatures: {
        browserScenarioEnabled: options.browserScenarioCapture !== undefined,
      },
    }),
    sharedObservationOwnership,
  ),
  electronObservation: capability(
    ({ options }) => options.electronObservation,
    closeObservation,
    ({ options }) => ({
      optionalFeatures: {
        electronObservationEnabled: options.electronObservation !== undefined,
      },
    }),
    sharedObservationOwnership,
  ),
  electronActiveObservation: capability(
    ({ options }) => options.electronActiveObservation,
    closeObservation,
    ({ options }) => ({
      optionalFeatures: {
        electronAutomationEnabled:
          options.electronActiveObservation !== undefined,
      },
    }),
    sharedObservationOwnership,
  ),
  javascriptRuntimeObservation: capability(
    ({ options }) => options.javascriptRuntimeObservation,
    closeObservation,
    ({ options }) => ({
      optionalFeatures: {
        v8InspectorObservationEnabled:
          options.javascriptRuntimeObservation !== undefined,
      },
    }),
    sharedObservationOwnership,
  ),
} satisfies Partial<
  Record<
    CapabilityDeclarationId,
    (context: CapabilityHostContext) => CapabilityInstance<unknown>
  >
>;

export type CapabilityServices = {
  readonly [Key in keyof typeof modules]: ReturnType<
    (typeof modules)[Key]
  >["value"];
};

/** Compose every service and its cleanup together, retaining precise typed ports. */
export const createCapabilityServices = (context: CapabilityHostContext) => {
  const scope = new CapabilityScope();
  const hostUnsupported: NonNullable<
    CapabilityAvailabilityFacts["hostUnsupported"]
  > = {};
  const optionalFeatures: NonNullable<
    CapabilityAvailabilityFacts["optionalFeatures"]
  > = {};
  const probes: NonNullable<CapabilityAvailabilityFacts["probes"]> = {};
  const failureObservers: (() => OptionalProviderLoadFailures)[] = [];
  const availability = { hostUnsupported, optionalFeatures };
  // This is a key-preserving map of a source-owned typed declaration, not an
  // external value parser or a generic operation dispatcher.
  const services = Object.fromEntries(
    Object.entries(modules).map(([id, create]) => {
      const instance = create(context);
      const declaration = CAPABILITY_DECLARATIONS[id as keyof typeof modules];
      if (declaration === undefined)
        throw new Error(`Undeclared capability ${id}`);
      Object.assign(
        availability.hostUnsupported,
        instance.availability?.hostUnsupported,
      );
      Object.assign(
        availability.optionalFeatures,
        instance.availability?.optionalFeatures,
      );
      Object.assign(probes, instance.availability?.probes);
      const observeFailure = instance.availability?.observeProviderLoadFailures;
      if (observeFailure !== undefined) failureObservers.push(observeFailure);
      return [
        id,
        instance.ownership === "host"
          ? scope.own(id, instance.value, instance.close)
          : instance.value,
      ];
    }),
  ) as CapabilityServices;
  return {
    services,
    availability,
    probes,
    observeProviderLoadFailures: (): OptionalProviderLoadFailures =>
      Object.assign({}, ...failureObservers.map((observe) => observe())),
    close: () => scope.close(),
  };
};
