import { describe, expect, it } from "vitest";

import { buildCapabilityInventory } from "./CapabilityInventory.js";

const enabledPolicy: Parameters<typeof buildCapabilityInventory>[1] = {
  processCaptureEnabled: true,
  evidenceFileRoots: 1,
  investigationInputRoots: 1,
  browserObservationEnabled: true,
  browserScenarioEnabled: true,
  electronObservationEnabled: true,
  v8InspectorObservationEnabled: true,
  javascriptReplayEnabled: true,
  managedRuntimeEnabled: true,
};

const status = (
  options: {
    readonly open?: boolean;
    readonly kind?: "executable" | "database" | "archive" | "artifact";
    readonly capabilities?: readonly {
      readonly operation: string;
      readonly available: boolean;
      readonly reason: string | null;
      readonly availability_code?: "unsupported_host";
    }[];
  } = {},
) => ({
  open: options.open ?? false,
  ...(options.kind === undefined ? {} : { kind: options.kind }),
  capabilities: (options.capabilities ?? []).map((capability) => ({
    ...capability,
    availability_code: capability.available
      ? null
      : (capability.availability_code ?? null),
    input_contract_version: 1,
    output_contract_version: 1,
    pagination: "none" as const,
    exhaustive: true,
    effects: {
      mutates_artifact: false,
      launches_process: false,
      may_show_ui: false,
      may_access_network: false,
      may_write_filesystem: false,
      changes_permissions: false,
      requires_root: false,
    },
    limits: {
      max_results: null,
      max_payload_bytes: null,
      timeout_ms: null,
    },
    limitations: [],
  })),
});

const entry = (
  name: string,
  sessionStatus: ReturnType<typeof status>,
  policy = enabledPolicy,
) => {
  const found = buildCapabilityInventory(sessionStatus, policy).find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`missing capability ${name}`);
  return found;
};

describe("capability inventory: provider status", () => {
  it.each([
    {
      label: "requires a target",
      name: "current_address",
      sessionStatus: status(),
      reason: "target_required",
      remediation: "open_binary",
    },
    {
      label: "rejects an incompatible target family",
      name: "current_address",
      sessionStatus: status({ open: true, kind: "archive" }),
      reason: "target_unsupported",
      remediation: "native executable",
    },
    {
      label: "reports a missing provider operation",
      name: "current_address",
      sessionStatus: status({ open: true, kind: "executable" }),
      reason: "provider_missing",
      remediation: "provider",
    },
    {
      label: "distinguishes an unsupported host",
      name: "current_address",
      sessionStatus: status({
        open: true,
        kind: "executable",
        capabilities: [
          {
            operation: "current_address",
            available: false,
            availability_code: "unsupported_host",
            reason: "Operation requires macOS",
          },
        ],
      }),
      reason: "unsupported_host",
      remediation: "macOS",
    },
    {
      label: "retains a provider failure",
      name: "current_address",
      sessionStatus: status({
        open: true,
        kind: "executable",
        capabilities: [
          {
            operation: "current_address",
            available: false,
            reason: "Provider session is unhealthy",
          },
        ],
      }),
      reason: "provider_unavailable",
      remediation: "unhealthy",
    },
    {
      label: "reports an available provider operation",
      name: "current_address",
      sessionStatus: status({
        open: true,
        kind: "executable",
        capabilities: [
          {
            operation: "current_address",
            available: true,
            reason: null,
          },
        ],
      }),
      reason: "available",
      remediation: null,
    },
  ])("$label", ({ name, sessionStatus, reason, remediation }) => {
    const availability = entry(name, sessionStatus);
    expect(availability).toMatchObject({
      reason,
      available: reason === "available",
    });
    if (remediation === null) expect(availability.remediation).toBeNull();
    else expect(availability.remediation).toContain(remediation);
  });

  it.each([
    ["capture_process_scenario", { processCaptureEnabled: false }],
    ["inspect_web_page", { browserObservationEnabled: false }],
    ["capture_browser_scenario", { browserScenarioEnabled: false }],
    ["inspect_electron_page", { electronObservationEnabled: false }],
    ["observe_javascript_runtime", { v8InspectorObservationEnabled: false }],
    ["run_controlled_replay", { javascriptReplayEnabled: false }],
    ["plan_managed_runtime_correlation", { managedRuntimeEnabled: false }],
  ] as const)("reports stable policy denial for %s", (name, override) => {
    const availability = entry(name, status(), {
      ...enabledPolicy,
      ...override,
    });
    expect(availability).toMatchObject({
      available: false,
      reason: "policy_disabled",
    });
    expect(availability.remediation).toEqual(expect.any(String));
    expect(availability.remediation?.length).toBeGreaterThan(0);
  });
});

describe("capability inventory: caller guidance", () => {
  it("gives every unavailable public tool an actionable remediation", () => {
    const inventory = buildCapabilityInventory(status(), {
      ...enabledPolicy,
      processCaptureEnabled: false,
      evidenceFileRoots: 0,
      investigationInputRoots: 0,
      browserObservationEnabled: false,
      electronObservationEnabled: false,
      v8InspectorObservationEnabled: false,
      javascriptReplayEnabled: false,
      managedRuntimeEnabled: false,
    });
    for (const availability of inventory)
      if (!availability.available) {
        expect(availability.reason).not.toBe("available");
        expect(availability.remediation).toEqual(expect.any(String));
        expect(availability.remediation?.length).toBeGreaterThan(0);
      }
  });

  it("projects negotiated client features into per-tool requirements", () => {
    const withoutElicitation = buildCapabilityInventory(
      status(),
      enabledPolicy,
    ).find(({ name }) => name === "capture_process_scenario");
    const withElicitation = buildCapabilityInventory(status(), enabledPolicy, {
      elicitation_form: true,
      elicitation_url: false,
      roots: false,
      sampling: false,
    }).find(({ name }) => name === "capture_process_scenario");

    expect(withoutElicitation?.client_requirements).toEqual({
      required: [],
      optional: ["elicitation_form"],
      missing_required: [],
      missing_optional: ["elicitation_form"],
    });
    expect(withElicitation?.client_requirements).toEqual({
      required: [],
      optional: ["elicitation_form"],
      missing_required: [],
      missing_optional: [],
    });
  });

  it("allows explicit documents when the provider has no current-document getter", () => {
    const capabilities = [
      "current_document",
      "current_address",
      "resolve_containing_procedure",
    ].map((operation) => ({
      operation,
      available: true,
      reason: null,
    }));
    expect(
      entry(
        "get_navigation_context",
        status({ open: true, kind: "executable", capabilities }),
      ),
    ).toMatchObject({
      available: true,
      reason: "available",
      default_mode_available: true,
      modes: [
        { name: "current_selection", available: true },
        { name: "explicit_document", available: true },
      ],
    });
    expect(
      entry(
        "get_navigation_context",
        status({
          open: true,
          kind: "executable",
          capabilities: capabilities.slice(1),
        }),
      ),
    ).toMatchObject({
      available: true,
      reason: "available",
      default_mode_available: false,
      modes: [
        { name: "current_selection", available: false },
        { name: "explicit_document", available: true },
      ],
    });
    expect(
      entry(
        "get_navigation_context",
        status({
          open: true,
          kind: "executable",
          capabilities: capabilities.slice(1, 2),
        }),
      ),
    ).toMatchObject({
      available: false,
      reason: "provider_missing",
      remediation: expect.stringContaining("resolve_containing_procedure"),
    });
  });

  it("preserves the most specific navigation mode failure", () => {
    expect(
      entry(
        "get_navigation_context",
        status({
          open: true,
          kind: "executable",
          capabilities: [
            {
              operation: "current_address",
              available: false,
              availability_code: "unsupported_host",
              reason: "Navigation requires macOS.",
            },
            {
              operation: "resolve_containing_procedure",
              available: true,
              reason: null,
            },
          ],
        }),
      ),
    ).toMatchObject({
      available: false,
      reason: "unsupported_host",
      remediation: "Navigation requires macOS.",
    });
  });
});
