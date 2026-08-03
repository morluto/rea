import { z } from "zod";

import type { ClientFeatureAvailability } from "../contracts/toolOutputSchemaPrimitives.js";
import type { ToolKind } from "../contracts/toolContractTypes.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { GENERATED_MCP_TOOL_CATALOG } from "../generatedMcpToolCatalog.js";

const statusSchema = z.object({
  open: z.boolean(),
  kind: z.enum(["executable", "database", "archive", "artifact"]).optional(),
  format: z.string().optional(),
  capabilities: z.array(
    z.object({
      operation: z.string(),
      available: z.boolean(),
      reason: z.string().nullable(),
      availability_code: z.string().nullable().optional(),
    }),
  ),
});

type ToolAvailabilityReason =
  | "available"
  | "client_capability_missing"
  | "target_required"
  | "provider_missing"
  | "provider_unavailable"
  | "target_unsupported"
  | "unsupported_host"
  | "policy_disabled";

type ProviderDescriptor = {
  readonly available: boolean;
  readonly reason: string | null;
  readonly availability_code?: string | null;
};
export type AvailabilityPolicy = {
  readonly processCaptureEnabled: boolean;
  readonly evidenceFileRoots: number;
  readonly investigationInputRoots: number;
  readonly browserObservationEnabled?: boolean;
  readonly browserScenarioEnabled?: boolean;
  readonly electronObservationEnabled?: boolean;
  readonly v8InspectorObservationEnabled?: boolean;
  readonly javascriptReplayEnabled?: boolean;
  readonly managedRuntimeEnabled?: boolean;
};

type ClientFeatureName = keyof ClientFeatureAvailability;

const NO_CLIENT_FEATURES: ClientFeatureAvailability = {
  elicitation_form: false,
  elicitation_url: false,
  roots: false,
  sampling: false,
};

const CLIENT_FEATURE_REQUIREMENTS: Readonly<
  Record<
    string,
    {
      readonly required: readonly ClientFeatureName[];
      readonly optional: readonly ClientFeatureName[];
    }
  >
> = {
  capture_process_scenario: {
    required: [],
    optional: ["elicitation_form"],
  },
};
type Availability = {
  readonly reason: ToolAvailabilityReason;
  readonly remediation: string | null;
  readonly defaultModeAvailable?: boolean;
  readonly modes?: readonly CapabilityMode[];
};
type CapabilityMode = {
  readonly name: string;
  readonly available: boolean;
  readonly missing_operations: readonly string[];
  readonly remediation: string | null;
};
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
  swift_classes: ["list_procedures"],
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
) => {
  const status = statusSchema.parse(sessionStatus);
  const descriptors = new Map<string, ProviderDescriptor>(
    status.capabilities.map((descriptor) => [
      descriptor.operation,
      {
        available: descriptor.available,
        reason: descriptor.reason,
        availability_code: descriptor.availability_code ?? null,
      },
    ]),
  );
  return GENERATED_MCP_TOOL_CATALOG.map((contract) => {
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
    return {
      name: contract.name,
      surface: contract.kind,
      available: availability.reason === "available" && !clientBlocked,
      reason: clientBlocked
        ? ("client_capability_missing" as const)
        : availability.reason,
      remediation: clientBlocked
        ? `Use an MCP client that supports: ${clientRequirements.missing_required.join(", ")}.`
        : availability.remediation,
      ...(availability.defaultModeAvailable === undefined
        ? {}
        : { default_mode_available: availability.defaultModeAvailable }),
      ...(availability.modes === undefined
        ? {}
        : { modes: availability.modes }),
      client_requirements: clientRequirements,
      effects: { ...contract.effects },
      annotations: {
        read_only: contract.annotations.readOnlyHint ?? false,
        destructive: contract.annotations.destructiveHint ?? false,
        idempotent: contract.annotations.idempotentHint ?? false,
        open_world: contract.annotations.openWorldHint ?? true,
      },
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
};

const clientRequirementsFor = (
  name: string,
  clientFeatures: ClientFeatureAvailability,
) => {
  const requirements = CLIENT_FEATURE_REQUIREMENTS[name] ?? {
    required: [],
    optional: [],
  };
  return {
    required: [...requirements.required],
    optional: [...requirements.optional],
    missing_required: requirements.required.filter(
      (feature) => !clientFeatures[feature],
    ),
    missing_optional: requirements.optional.filter(
      (feature) => !clientFeatures[feature],
    ),
  };
};

const availabilityFor = (context: AvailabilityContext): Availability => {
  if (context.name === "get_navigation_context")
    return navigationContextAvailability(context.descriptors);
  const javascriptApplication = javascriptApplicationAvailability(context);
  if (javascriptApplication !== null) return javascriptApplication;
  const policyDecision = policyAvailability(context);
  if (policyDecision !== null) return policyDecision;
  const targetDecision = targetAvailability(context);
  if (targetDecision !== null) return targetDecision;
  return providerAvailability(context);
};

const javascriptApplicationAvailability = ({
  name,
  policy,
}: AvailabilityContext): Availability | null => {
  if (name === "analyze_javascript_application")
    return policy.investigationInputRoots === 0
      ? {
          reason: "policy_disabled",
          remediation:
            "Configure an exact REA_INVESTIGATION_INPUT_ROOTS_JSON root in the MCP registration, then restart the registered MCP server or client.",
        }
      : { reason: "available", remediation: null };
  return name === "reconcile_javascript_runtime"
    ? { reason: "available", remediation: null }
    : null;
};

const policyAvailability = ({
  name,
  kind,
  policy,
}: AvailabilityContext): Availability | null => {
  const browser = browserPolicyAvailability(name, kind, policy);
  if (browser !== null) return browser;
  if (name === "capture_process_scenario" && !policy.processCaptureEnabled)
    return {
      reason: "policy_disabled",
      remediation:
        "Enable or grant process_capture within the administrator ceiling.",
    };
  if (name === "run_controlled_replay" && !policy.javascriptReplayEnabled)
    return {
      reason: "policy_disabled",
      remediation:
        "Enable javascript_replay with exact source roots and sandbox executables.",
    };
  if (name === "run_controlled_replay")
    return { reason: "available", remediation: null };
  if (
    name === "plan_managed_runtime_correlation" &&
    !policy.managedRuntimeEnabled
  )
    return {
      reason: "policy_disabled",
      remediation:
        "Enable managed_runtime with exact artifact roots and a runtime executable.",
    };
  if (name === "plan_managed_runtime_correlation")
    return { reason: "available", remediation: null };
  if (kind === "application") return { reason: "available", remediation: null };
  if (name === "import_evidence_bundle" && policy.evidenceFileRoots === 0)
    return {
      reason: "policy_disabled",
      remediation: "Configure or grant an evidence_read root.",
    };
  if (kind === "electron-provider")
    return policy.electronObservationEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "policy_disabled",
          remediation:
            "Enable Electron observation and configure a loopback CDP endpoint and canonical file roots.",
        };
  if (kind === "runtime-provider")
    return policy.v8InspectorObservationEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "policy_disabled",
          remediation:
            "Enable V8 Inspector observation and configure exact loopback endpoints plus canonical file roots or exact origins.",
        };
  if (kind === "session") return { reason: "available", remediation: null };
  return null;
};

const browserPolicyAvailability = (
  name: string,
  kind: ToolKind,
  policy: AvailabilityPolicy,
): Availability | null => {
  if (name === "capture_browser_scenario")
    return policy.browserScenarioEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "policy_disabled",
          remediation:
            "Enable browser scenarios and configure exact executable roots or loopback CDP endpoints, page origins, and environment secret names.",
        };
  if (kind !== "browser-provider") return null;
  return policy.browserObservationEnabled === true
    ? { reason: "available", remediation: null }
    : {
        reason: "policy_disabled",
        remediation:
          "Enable browser observation and configure exact CDP endpoint and page origins.",
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
): {
  readonly reason: ToolAvailabilityReason;
  readonly remediation: string | null;
} => {
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
  const modes = NAVIGATION_CONTEXT_MODES.map((mode) => {
    const availability = composedAvailabilityFor(
      mode.requirements,
      descriptors,
    );
    return {
      name: mode.name,
      available: availability.reason === "available",
      missing_operations: mode.requirements.filter((operation) => {
        const descriptor = descriptors.get(operation);
        return descriptor === undefined || descriptor.available === false;
      }),
      remediation: availability.remediation,
    };
  });
  const availableMode = modes.find((mode) => mode.available);
  return {
    reason: availableMode === undefined ? "provider_missing" : "available",
    remediation:
      availableMode === undefined
        ? `Configure a provider for one of: ${modes
            .flatMap((mode) => mode.missing_operations)
            .join(", ")}.`
        : null,
    defaultModeAvailable: modes[0]?.available ?? false,
    modes,
  };
};
