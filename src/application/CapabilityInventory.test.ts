import { describe, expect, it } from "vitest";

import { buildCapabilityInventory } from "./CapabilityInventory.js";

it("reports module syntax and native resolution availability separately", () => {
  const input = { open: false, capabilities: [] };
  const unavailable = buildCapabilityInventory(input, {
    processCaptureEnabled: false,
  }).find((tool) => tool.name === "trace_web_module_imports");
  expect(unavailable).toMatchObject({
    available: true,
    default_mode_available: false,
    modes: [
      expect.objectContaining({
        name: "sources-without-literal-imports",
        available: true,
      }),
      expect.objectContaining({
        name: "native-literal-resolution",
        available: false,
      }),
    ],
  });
  const enabled = buildCapabilityInventory(input, {
    processCaptureEnabled: false,
    webModuleResolutionEnabled: true,
  }).find((tool) => tool.name === "trace_web_module_imports");
  expect(enabled).toMatchObject({
    available: true,
    default_mode_available: true,
  });
});

const enabledPolicy: Parameters<typeof buildCapabilityInventory>[1] = {
  processCaptureEnabled: true,
  browserObservationEnabled: true,
  browserScenarioEnabled: true,
  electronObservationEnabled: true,
  v8InspectorObservationEnabled: true,
};

const status = (
  options: {
    readonly open?: boolean;
    readonly kind?: "executable" | "database" | "archive" | "artifact";
    readonly format?: string;
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
  ...(options.format === undefined ? {} : { format: options.format }),
  capabilities: (options.capabilities ?? []).map((capability) => ({
    ...capability,
    availability_code: capability.available
      ? null
      : (capability.availability_code ?? null),
    effects: {
      mutates_artifact: false,
      launches_process: false,
      may_show_ui: false,
      may_access_network: false,
      may_write_filesystem: false,
      changes_permissions: false,
      requires_root: false,
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

describe("capability failure reasons", () => {
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
});

describe("partial navigation availability", () => {
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

it("reports host denial before target mismatch but keeps composed workflow prerequisites", () => {
  const capability = {
    operation: "inspect_macho",
    available: false,
    availability_code: "unsupported_host" as const,
    reason: "Native macOS utilities require macOS.",
  };
  for (const target of [
    {},
    { open: true, kind: "archive" as const, format: "zip" },
  ]) {
    expect(
      entry("inspect_macho", status({ ...target, capabilities: [capability] })),
    ).toMatchObject({
      reason: "unsupported_host",
      remediation: capability.reason,
    });
  }
  expect(
    entry(
      "inspect_native_dispatch_metadata",
      status({
        capabilities: [
          { ...capability, operation: "inspect_native_dispatch_metadata" },
        ],
      }),
    ).reason,
  ).toBe("target_required");
});
