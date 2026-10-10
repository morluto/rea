import { z } from "zod";
import type {
  OptionalProviderLoadFailures,
  OptionalProviderLoadFailure,
} from "./OptionalObservationProviders.js";

import {
  providerCapability,
  type ClientFeatureAvailability,
  type ProviderCapability,
  type ToolAvailability,
  type ToolAvailabilityMode,
  type ToolUnavailabilityReason,
} from "../contracts/toolOutputSchemaPrimitives.js";
import type { ToolKind } from "../contracts/toolContractTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ProviderAvailability } from "./AnalysisProvider.js";
import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import {
  clientRequirementsFor,
  NO_CLIENT_FEATURES,
} from "./CapabilityClientRequirements.js";

const statusSchema = z.object({
  open: z.boolean(),
  kind: z.enum(["executable", "database", "archive", "artifact"]).optional(),
  format: z.string().optional(),
  capabilities: z.array(providerCapability),
});

type ToolAvailabilityReason = "available" | ToolUnavailabilityReason;

type ProviderDescriptor = ProviderCapability;
export type AvailabilityPolicy = {
  readonly evmInterfaceEnabled?: boolean;
  readonly processCaptureEnabled: boolean;
  readonly optionalProviderLoadFailures?: OptionalProviderLoadFailures;
  readonly binaryLayoutEnabled?: boolean;
  readonly recordedCrashEnabled?: boolean;
  readonly firmwareInspectionEnabled?: boolean;
  readonly firmwareExtractionEnabled?: boolean;
  readonly androidAnalysisAvailability?: ProviderAvailability;
  readonly jebAnalysisAvailability?: ProviderAvailability;
  readonly javascriptRecoveryEnabled?: boolean;
  readonly webModuleResolutionEnabled?: boolean;
  readonly browserObservationEnabled?: boolean;
  readonly browserScenarioEnabled?: boolean;
  readonly electronObservationEnabled?: boolean;
  readonly electronAutomationEnabled?: boolean;
  readonly v8InspectorObservationEnabled?: boolean;
};

type AvailabilityFacts = {
  readonly defaultModeAvailable?: boolean;
  readonly modes?: readonly ToolAvailabilityMode[];
};
type Availability = AvailabilityFacts &
  (
    | { readonly reason: "available"; readonly remediation: null }
    | {
        readonly reason: ToolUnavailabilityReason;
        readonly remediation: string | null;
      }
  );
type NavigationModeResult =
  | (Extract<ToolAvailabilityMode, { available: true }> & {
      readonly reason: "available";
    })
  | (Extract<ToolAvailabilityMode, { available: false }> & {
      readonly reason: ToolUnavailabilityReason;
    });
type AvailabilityContext = {
  readonly name: string;
  readonly kind: ToolKind;
  readonly targetOpen: boolean;
  readonly targetKind:
    | "executable"
    | "database"
    | "archive"
    | "artifact"
    | undefined;
  readonly targetFormat: string | undefined;
  readonly descriptors: ReadonlyMap<string, ProviderDescriptor>;
  readonly policy: AvailabilityPolicy;
};

const ENHANCED_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  trace_native_values: ["analyze_function", "resolve_native_call_targets"],
  trace_native_ui_action: [
    "decode_interface_builder",
    "list_names",
    "procedure_callees",
  ],
  inspect_native_dispatch_metadata: ["list_names"],
  get_objc_classes: ["list_names"],
  get_objc_protocols: ["list_names"],
  batch_decompile: ["procedure_pseudo_code"],
  get_call_graph: ["procedure_callees", "procedure_callers"],
  analyze_swift_types: ["list_procedures"],
  find_xrefs_to_name: ["list_names", "xrefs"],
  binary_overview: [
    "list_segments",
    "list_documents",
    "list_procedures",
    "list_strings",
  ],
  analyze_function: ["analyze_function"],
  inspect_native_api: ["analyze_function"],
  trace_feature: [
    "list_strings",
    "list_procedures",
    "xrefs",
    "resolve_containing_procedure",
  ],
};

/** Contract kinds whose operations run on the active session target. */
const ACTIVE_TARGET_KINDS: ReadonlySet<ToolKind> = new Set([
  "official-proxy",
  "enhanced",
  "native-provider",
  "artifact-provider",
]);

/** Native contracts defined only for an active Mach-O executable. */
const MACHO_TARGET_OPERATIONS: ReadonlySet<string> = new Set([
  "inspect_macho",
  "list_architectures",
  "observe_native_calls",
  "observe_native_ui",
  "capture_native_ui_scenario",
]);

const NAVIGATION_CONTEXT_MODES = [
  {
    name: "current_selection",
    requirements: [
      "current_document",
      "current_address",
      "resolve_containing_procedure",
    ],
  },
  {
    name: "explicit_document",
    requirements: ["current_address", "resolve_containing_procedure"],
  },
] as const;

/** Build stable per-operation availability for discovery and tool visibility. */
export const buildCapabilityInventory = (
  sessionStatus: JsonValue,
  policy: AvailabilityPolicy,
  clientFeatures: ClientFeatureAvailability = NO_CLIENT_FEATURES,
): readonly ToolAvailability[] => {
  const status = statusSchema.parse(sessionStatus);
  const descriptors = new Map<string, ProviderDescriptor>(
    status.capabilities.map((descriptor) => [descriptor.operation, descriptor]),
  );
  return TOOL_CONTRACTS.map((contract): ToolAvailability => {
    const availability = availabilityFor({
      name: contract.name,
      kind: contract.kind,
      targetOpen: status.open,
      targetKind: status.kind,
      targetFormat: status.format,
      descriptors,
      policy,
    });
    const clientRequirements = clientRequirementsFor(
      contract.name,
      clientFeatures,
    );
    const clientBlocked = clientRequirements.missing_required.length > 0;
    const facts = {
      name: contract.name,
      surface: contract.kind,
      ...(availability.defaultModeAvailable === undefined
        ? {}
        : { default_mode_available: availability.defaultModeAvailable }),
      ...(availability.modes === undefined
        ? {}
        : { modes: [...availability.modes] }),
      client_requirements: clientRequirements,
      effects: { ...contract.effects },
      annotations: {
        read_only: contract.annotations.readOnlyHint ?? false,
        destructive: contract.annotations.destructiveHint ?? false,
        idempotent: contract.annotations.idempotentHint ?? false,
        open_world: contract.annotations.openWorldHint ?? true,
      },
    };
    if (clientBlocked)
      return {
        ...facts,
        available: false,
        reason: "client_capability_missing",
        remediation: `Use an MCP client that supports: ${clientRequirements.missing_required.join(", ")}.`,
      };
    return availability.reason === "available"
      ? {
          ...facts,
          available: true,
          reason: availability.reason,
          remediation: null,
        }
      : {
          ...facts,
          available: false,
          reason: availability.reason,
          remediation: availability.remediation,
        };
  }).sort((left, right) => left.name.localeCompare(right.name));
};

const availabilityFor = (context: AvailabilityContext): Availability => {
  // These built-in workflows accept a caller-selected endpoint; they do not load the optional passive provider.
  if (
    context.name === "observe_web_execution" ||
    context.name === "inspect_web_event_listeners"
  )
    return { reason: "available", remediation: null };
  if (context.name === "get_navigation_context")
    return navigationContextAvailability(context.descriptors);
  const javascriptApplication = javascriptApplicationAvailability(context);
  if (javascriptApplication !== null) return javascriptApplication;
  const failure = optionalProviderFailureFor(context);
  if (failure !== undefined)
    return {
      reason: "provider_unavailable",
      remediation: `Adapter ${failure.providerId} could not load: ${failure.reason}. Repair the adapter installation and restart REA; other capabilities remain available.`,
    };
  const workflowAvailability = workflowAvailabilityFor(context);
  if (workflowAvailability !== null) return workflowAvailability;
  const hostDecision = hostAvailability(context);
  if (hostDecision !== null) return hostDecision;
  const targetDecision = targetAvailability(context);
  if (targetDecision !== null) return targetDecision;
  return providerAvailability(context);
};

const optionalProviderFailureFor = ({
  name,
  kind,
  policy,
}: AvailabilityContext): OptionalProviderLoadFailure | undefined => {
  const failures = policy.optionalProviderLoadFailures;
  if (name === "capture_browser_scenario")
    return failures?.browserScenarioCapture;
  if (kind === "browser-provider") return failures?.browserObservation;
  if (name === "capture_electron_scenario")
    return failures?.electronActiveObservation;
  if (kind === "electron-provider") return failures?.electronObservation;
  if (kind === "runtime-provider")
    return failures?.javascriptRuntimeObservation;
  return undefined;
};

const javascriptApplicationAvailability = ({
  name,
}: AvailabilityContext): Availability | null => {
  if (name === "analyze_javascript_application")
    return { reason: "available", remediation: null };
  return name === "reconcile_javascript_runtime"
    ? { reason: "available", remediation: null }
    : null;
};

const workflowAvailabilityFor = ({
  name,
  kind,
  policy,
}: AvailabilityContext): Availability | null => {
  if (name === "trace_web_module_imports")
    return {
      reason: "available",
      remediation: null,
      defaultModeAvailable: policy.webModuleResolutionEnabled === true,
      modes: [
        {
          name: "sources-without-literal-imports",
          available: true,
          missing_operations: [],
          remediation: null,
        },
        policy.webModuleResolutionEnabled === true
          ? {
              name: "native-literal-resolution",
              available: true,
              missing_operations: [],
              remediation: null,
            }
          : {
              name: "native-literal-resolution",
              available: false,
              missing_operations: ["native-module-resolver"],
              remediation:
                "Provide an absolute REA_BROWSER_EXECUTABLE supporting import.meta.resolve; no binary target is required.",
            },
      ],
    };
  if (name === "recover_javascript_sources")
    return policy.javascriptRecoveryEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            "On Linux x64, provide an absolute REA_WAKARU_COMMAND for Wakaru 1.13.0 and util-linux prlimit. No binary target is required.",
        };
  if (name === "inspect_binary_layout")
    return policy.binaryLayoutEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            "On Linux x64, set absolute REA_PWNTOOLS_PYTHON to caller-supplied Python with pwntools 4.15.0. No active binary target is required.",
        };
  if (name === "inspect_evm_interface")
    return policy.evmInterfaceEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            "The bundled offline EVM interface profile is currently real-verified on Linux x64. No active binary target or chain endpoint is required.",
        };
  if (name === "inspect_recorded_crash")
    return policy.recordedCrashEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            "On Linux x64, set absolute REA_PWNTOOLS_PYTHON to caller-supplied Python with pwntools 4.15.0. No active binary target is required.",
        };
  if (kind === "firmware-provider") {
    const enabled =
      name === "inspect_firmware_regions"
        ? policy.firmwareInspectionEnabled
        : policy.firmwareExtractionEnabled;
    return enabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            "On Linux, provide an absolute REA_BINWALK_COMMAND (Binwalk 3.1.x, verified with 3.1.0) or REA_UNBLOB_COMMAND (Unblob 26.6.x, verified with 26.6.4) path and util-linux prlimit. Extraction also requires the selected format’s external extractor.",
        };
  }
  if (kind === "android-provider")
    return policy.androidAnalysisAvailability?.status === "available"
      ? { reason: "available", remediation: null }
      : {
          reason:
            policy.androidAnalysisAvailability?.code === "unsupported_host"
              ? "unsupported_host"
              : "provider_missing",
          remediation:
            policy.androidAnalysisAvailability?.reason ??
            "Set REA_JADX_MCP_JAR to a caller-supplied jadx-headless-mcp 0.7.1 JAR and provide a full JDK on Linux, macOS, or Windows x64 with its matching bundled native controls.",
        };
  if (kind === "jeb-provider")
    return policy.jebAnalysisAvailability?.status === "available"
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            policy.jebAnalysisAvailability?.reason ??
            "Start a JEB client serving MCP (GUI client, or headless via its programmatic launcher) and point REA_JEB_MCP_URL at it (default http://127.0.0.1:8425/mcp). REA does not install or launch JEB.",
        };
  const browser = browserProviderAvailability(name, kind, policy);
  if (browser !== null) return browser;
  if (name === "capture_process_scenario" && !policy.processCaptureEnabled)
    return {
      reason: "unsupported_host",
      remediation: "Run process capture on a supported Linux or macOS host.",
    };
  if (kind === "application") return { reason: "available", remediation: null };
  const electron = electronProviderAvailability(name, kind, policy);
  if (electron !== null) return electron;
  if (kind === "runtime-provider")
    return policy.v8InspectorObservationEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            "Start REA with its JavaScript runtime provider available.",
        };
  if (kind === "session") return { reason: "available", remediation: null };
  return null;
};

const electronProviderAvailability = (
  name: string,
  kind: ToolKind,
  policy: AvailabilityPolicy,
): Availability | null => {
  if (kind !== "electron-provider") return null;
  if (name === "capture_electron_scenario")
    return policy.electronAutomationEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            "Start REA with the Electron scenario provider available.",
        };
  return policy.electronObservationEnabled === true
    ? { reason: "available", remediation: null }
    : {
        reason: "provider_missing",
        remediation:
          "Start REA with its Electron observation provider available.",
      };
};

const browserProviderAvailability = (
  name: string,
  kind: ToolKind,
  policy: AvailabilityPolicy,
): Availability | null => {
  if (name === "capture_browser_scenario")
    return policy.browserScenarioEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            "Start REA with its browser scenario provider available.",
        };
  if (kind !== "browser-provider") return null;
  return policy.browserObservationEnabled === true
    ? { reason: "available", remediation: null }
    : {
        reason: "provider_missing",
        remediation:
          "Start REA with its browser observation provider available.",
      };
};

/**
 * Opening another target cannot make an operation run on an unsupported host.
 * Composed operations are decided by their requirements, which another
 * provider may satisfy.
 */
const hostAvailability = ({
  descriptors,
  kind,
  name,
}: AvailabilityContext): Availability | null => {
  if (kind === "enhanced") return null;
  const descriptor = descriptors.get(name);
  return descriptor?.available === false &&
    descriptor.availability_code === "unsupported_host"
    ? { reason: "unsupported_host", remediation: descriptor.reason }
    : null;
};

const targetAvailability = ({
  name,
  kind,
  targetKind,
  targetFormat,
  targetOpen,
}: AvailabilityContext): Availability | null => {
  if (!targetOpen && ACTIVE_TARGET_KINDS.has(kind))
    return {
      reason: "target_required",
      remediation: "Call open_binary with a supported local target.",
    };
  if (
    targetKind !== undefined &&
    targetKind !== "executable" &&
    targetKind !== "database" &&
    (kind === "official-proxy" || kind === "enhanced")
  )
    return {
      reason: "target_unsupported",
      remediation:
        "Inventory or extract a native executable, then call open_binary on that executable.",
    };
  if (
    targetOpen &&
    MACHO_TARGET_OPERATIONS.has(name) &&
    (targetKind !== "executable" || targetFormat !== "mach-o")
  )
    return {
      reason: "target_unsupported",
      remediation:
        "Call open_binary with a Mach-O executable or an app bundle whose main executable is Mach-O.",
    };
  return null;
};

const providerAvailability = ({
  descriptors,
  kind,
  name,
}: AvailabilityContext): Availability => {
  if (kind === "enhanced") return composedAvailability(name, descriptors);
  const descriptor = descriptors.get(name);
  if (
    descriptor === undefined &&
    (kind === "artifact-provider" ||
      kind === "managed-provider" ||
      kind === "native-provider")
  )
    return { reason: "available", remediation: null };
  if (descriptor === undefined)
    return {
      reason: "provider_missing",
      remediation:
        "Install or configure a provider that declares this operation.",
    };
  return descriptor.available
    ? { reason: "available", remediation: null }
    : {
        reason: "provider_unavailable",
        remediation:
          descriptor.reason ?? "Choose another target or configured provider.",
      };
};

const composedAvailability = (
  name: string,
  descriptors: ReadonlyMap<string, ProviderDescriptor>,
): Availability => {
  const requirements = ENHANCED_REQUIREMENTS[name];
  if (requirements === undefined)
    return {
      reason: "provider_missing",
      remediation: "No provider composition is declared for this operation.",
    };
  return composedAvailabilityFor(requirements, descriptors);
};

const composedAvailabilityFor = (
  requirements: readonly string[],
  descriptors: ReadonlyMap<string, ProviderDescriptor>,
): Availability => {
  const missing = requirements.find((operation) => !descriptors.has(operation));
  if (missing !== undefined)
    return {
      reason: "provider_missing",
      remediation: `Configure a provider for required operation ${missing}.`,
    };
  const unavailable = requirements
    .map((operation) => descriptors.get(operation))
    .find((descriptor) => descriptor?.available === false);
  if (unavailable !== undefined)
    return {
      reason:
        unavailable.availability_code === "unsupported_host"
          ? "unsupported_host"
          : "provider_unavailable",
      remediation:
        unavailable.reason ?? "Choose another target or configured provider.",
    };
  return { reason: "available", remediation: null };
};

const navigationContextAvailability = (
  descriptors: ReadonlyMap<string, ProviderDescriptor>,
): Availability => {
  const modeResults: NavigationModeResult[] = NAVIGATION_CONTEXT_MODES.map(
    (mode) => {
      const availability = composedAvailabilityFor(
        mode.requirements,
        descriptors,
      );
      if (availability.reason === "available")
        return {
          name: mode.name,
          available: true,
          reason: availability.reason,
          missing_operations: [],
          remediation: null,
        };
      return {
        name: mode.name,
        available: false,
        reason: availability.reason,
        missing_operations: mode.requirements.filter((operation) => {
          const descriptor = descriptors.get(operation);
          return descriptor === undefined || descriptor.available === false;
        }),
        remediation: availability.remediation,
      };
    },
  );
  const modes: ToolAvailabilityMode[] = modeResults.map((mode) =>
    mode.available
      ? {
          name: mode.name,
          available: true,
          missing_operations: [],
          remediation: null,
        }
      : {
          name: mode.name,
          available: false,
          missing_operations: [...mode.missing_operations],
          remediation: mode.remediation,
        },
  );
  const availableMode = modeResults.find((mode) => mode.available);
  const failures = modeResults.flatMap((mode) =>
    mode.available ? [] : [mode],
  );
  const failure = failures.sort(
    (left, right) =>
      navigationFailurePriority(left.reason) -
      navigationFailurePriority(right.reason),
  )[0];
  const specificFailureRemediation =
    failure?.reason === "provider_missing" ? undefined : failure?.remediation;
  const facts = {
    defaultModeAvailable: modes[0]?.available ?? false,
    modes,
  };
  if (availableMode !== undefined)
    return { ...facts, reason: "available", remediation: null };
  return {
    ...facts,
    reason: failure?.reason ?? "provider_missing",
    remediation:
      specificFailureRemediation ??
      `Configure a provider for one of: ${modes
        .flatMap((mode) => mode.missing_operations)
        .join(", ")}.`,
  };
};

const navigationFailurePriority = (reason: ToolAvailabilityReason): number => {
  switch (reason) {
    case "unsupported_host":
      return 0;
    case "provider_unavailable":
      return 1;
    case "provider_missing":
      return 2;
    default:
      return 3;
  }
};
