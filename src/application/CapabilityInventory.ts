import { z } from "zod";

import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import type { JsonValue } from "../domain/jsonValue.js";

const statusSchema = z.object({
  open: z.boolean(),
  kind: z.enum(["executable", "database", "archive", "artifact"]).optional(),
  format: z.string().optional(),
  capabilities: z.array(
    z.object({
      operation: z.string(),
      available: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
});

export type ToolAvailabilityReason =
  | "available"
  | "target_required"
  | "provider_missing"
  | "provider_unavailable"
  | "target_unsupported"
  | "unsupported_host"
  | "policy_disabled";

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
  trace_feature: [
    "list_strings",
    "list_procedures",
    "xrefs",
    "resolve_containing_procedure",
  ],
};

/** Build stable per-operation availability without hiding familiar tools. */
export const buildCapabilityInventory = (
  sessionStatus: JsonValue,
  policy: {
    readonly processCaptureEnabled: boolean;
    readonly evidenceFileRoots: number;
    readonly browserObservationEnabled?: boolean;
    readonly electronObservationEnabled?: boolean;
    readonly javascriptReplayEnabled?: boolean;
    readonly managedRuntimeEnabled?: boolean;
  },
) => {
  const status = statusSchema.parse(sessionStatus);
  const descriptors = new Map(
    status.capabilities.map((descriptor) => [descriptor.operation, descriptor]),
  );
  return TOOL_CONTRACTS.map((contract) => {
    const availability = availabilityFor(
      contract.name,
      contract.kind,
      status.open,
      status.kind,
      descriptors,
      policy,
    );
    return {
      name: contract.name,
      surface: contract.kind,
      available: availability.reason === "available",
      reason: availability.reason,
      remediation: availability.remediation,
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

const availabilityFor = (
  name: string,
  kind: (typeof TOOL_CONTRACTS)[number]["kind"],
  targetOpen: boolean,
  targetKind: "executable" | "database" | "archive" | "artifact" | undefined,
  descriptors: ReadonlyMap<
    string,
    { readonly available: boolean; readonly reason: string | null }
  >,
  policy: {
    readonly processCaptureEnabled: boolean;
    readonly evidenceFileRoots: number;
    readonly browserObservationEnabled?: boolean;
    readonly electronObservationEnabled?: boolean;
    readonly javascriptReplayEnabled?: boolean;
    readonly managedRuntimeEnabled?: boolean;
  },
): {
  readonly reason: ToolAvailabilityReason;
  readonly remediation: string | null;
} => {
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
  if (kind === "browser-provider")
    return policy.browserObservationEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "policy_disabled",
          remediation:
            "Enable browser observation and configure exact CDP endpoint and page origins.",
        };
  if (kind === "electron-provider")
    return policy.electronObservationEnabled === true
      ? { reason: "available", remediation: null }
      : {
          reason: "policy_disabled",
          remediation:
            "Enable Electron observation and configure a loopback CDP endpoint and canonical file roots.",
        };
  if (kind === "session") return { reason: "available", remediation: null };
  if (!targetOpen)
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
  if (kind === "enhanced") return composedAvailability(name, descriptors);
  const descriptor = descriptors.get(name);
  if (descriptor === undefined)
    return {
      reason: "provider_missing",
      remediation:
        "Install or configure a provider that declares this operation.",
    };
  if (
    !descriptor.available &&
    descriptor.reason?.toLowerCase().includes("require macos") === true
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
  descriptors: ReadonlyMap<
    string,
    { readonly available: boolean; readonly reason: string | null }
  >,
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
        unavailable.reason?.toLowerCase().includes("require macos") === true
          ? "unsupported_host"
          : "provider_unavailable",
      remediation:
        unavailable.reason ?? "Choose another target or configured provider.",
    };
  return { reason: "available", remediation: null };
};
