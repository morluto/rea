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
import { GENERATED_MCP_TOOL_CATALOG } from "../generatedMcpToolCatalog.js";
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
  readonly processCaptureEnabled: boolean;
  readonly optionalProviderLoadFailures?: OptionalProviderLoadFailures;
  readonly firmwareInspectionEnabled?: boolean;
  readonly firmwareExtractionEnabled?: boolean;
  readonly androidAnalysisEnabled?: boolean;
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
  return GENERATED_MCP_TOOL_CATALOG.map((contract): ToolAvailability => {
    const availability = availabilityFor({
      name: contract.name,
      kind: contract.kind,
      targetOpen: status.open,
      targetKind: status.kind,
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
    return policy.androidAnalysisEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "provider_missing",
          remediation:
            "Set REA_JADX_MCP_JAR to a caller-supplied jadx-headless-mcp 0.7.1 JAR and provide Java on Linux or macOS. Only Linux has real-provider verification.",
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

const targetAvailability = ({
  kind,
  targetKind,
  targetOpen,
}: AvailabilityContext): Availability | null => {
  if (!targetOpen && (kind === "official-proxy" || kind === "enhanced"))
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
  if (
    !descriptor.available &&
    descriptor.availability_code === "unsupported_host"
  )
    return {
      reason: "unsupported_host",
      remediation: descriptor.reason,
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
