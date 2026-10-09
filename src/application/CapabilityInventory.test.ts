import { describe, expect, it } from "vitest";

import { toolAvailability } from "../contracts/toolOutputSchemaPrimitives.js";
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

const availableAndroidAvailability: NonNullable<
  Parameters<typeof buildCapabilityInventory>[1]["androidAnalysisAvailability"]
> = { status: "available", code: null, reason: null, diagnostics: {} };

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

describe("capability inventory: provider status", () => {
  it("reports firmware inspection and extraction prerequisites independently", () => {
    const policy = {
      processCaptureEnabled: true,
      firmwareInspectionEnabled: true,
    };
    expect(entry("inspect_firmware_regions", status(), policy)).toMatchObject({
      available: true,
      surface: "firmware-provider",
    });
    expect(entry("extract_firmware", status(), policy)).toMatchObject({
      available: false,
      reason: "provider_missing",
      remediation: expect.stringContaining("REA_UNBLOB_COMMAND"),
    });
    expect(
      entry("extract_firmware", status(), {
        processCaptureEnabled: true,
        firmwareExtractionEnabled: true,
      }),
    ).toMatchObject({ available: true });
  });
  it("keeps Android APK operations target-free and reports their explicit engine prerequisite", () => {
    expect(
      entry("inspect_android_package", status(), {
        processCaptureEnabled: true,
        androidAnalysisAvailability: availableAndroidAvailability,
      }),
    ).toMatchObject({
      available: true,
      surface: "android-provider",
      reason: "available",
    });
    expect(
      entry("inspect_android_package", status(), {
        processCaptureEnabled: true,
      }),
    ).toMatchObject({
      available: false,
      reason: "provider_missing",
      remediation: expect.stringContaining("REA_JADX_MCP_JAR"),
    });
  });
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

  it("keeps configured workflows callable and reports only real host or provider limits", () => {
    const inventory = buildCapabilityInventory(status(), {
      ...enabledPolicy,
      processCaptureEnabled: false,
      browserObservationEnabled: false,
      browserScenarioEnabled: false,
      electronObservationEnabled: false,
      electronAutomationEnabled: false,
      v8InspectorObservationEnabled: false,
    });
    const byName = new Map(inventory.map((item) => [item.name, item]));
    expect(byName.get("capture_process_scenario")).toMatchObject({
      available: false,
      reason: "unsupported_host",
    });
    expect(byName.get("inspect_web_page")).toMatchObject({
      available: false,
      reason: "provider_missing",
    });
  });
});

describe("capability inventory: active-target operations", () => {
  const ACTIVE_TARGET_TOOLS = [
    "inspect_macho",
    "inspect_signature",
    "list_architectures",
    "demangle_swift",
    "inspect_artifact",
    "extract_artifact",
  ] as const;
  const declared = (
    names: readonly string[],
    availability: {
      readonly available: boolean;
      readonly reason: string | null;
    } = {
      available: true,
      reason: null,
    },
  ) => names.map((operation) => ({ operation, ...availability }));
  const reasons = (
    sessionStatus: ReturnType<typeof status>,
    names: readonly string[],
    policy = enabledPolicy,
  ) =>
    Object.fromEntries(
      names.map((name) => [name, entry(name, sessionStatus, policy).reason]),
    );

  it("requires an open target even when the provider declares the operation", () => {
    const closed = status({ capabilities: declared(ACTIVE_TARGET_TOOLS) });
    for (const name of ACTIVE_TARGET_TOOLS)
      expect(entry(name, closed)).toMatchObject({
        available: false,
        reason: "target_required",
        remediation: expect.stringContaining("open_binary"),
      });
  });

  it("keeps explicit-path operations available without a target", () => {
    const explicitPath = [
      "inspect_managed_artifact",
      "inspect_binary_layout",
      "inspect_recorded_crash",
      "inspect_evm_interface",
    ];
    expect(
      reasons(status(), explicitPath, {
        ...enabledPolicy,
        binaryLayoutEnabled: true,
        recordedCrashEnabled: true,
        evmInterfaceEnabled: true,
      }),
    ).toEqual(
      Object.fromEntries(explicitPath.map((name) => [name, "available"])),
    );
  });

  it("reserves Mach-O operations for an open Mach-O executable", () => {
    const capabilities = declared(ACTIVE_TARGET_TOOLS);
    const machO = status({
      open: true,
      kind: "executable",
      format: "mach-o",
      capabilities,
    });
    const zip = status({
      open: true,
      kind: "archive",
      format: "zip",
      capabilities,
    });
    const elf = status({
      open: true,
      kind: "executable",
      format: "elf",
      capabilities,
    });
    expect(reasons(machO, ACTIVE_TARGET_TOOLS)).toEqual(
      Object.fromEntries(
        ACTIVE_TARGET_TOOLS.map((name) => [name, "available"]),
      ),
    );
    for (const target of [zip, elf])
      expect(reasons(target, ACTIVE_TARGET_TOOLS)).toEqual({
        inspect_macho: "target_unsupported",
        inspect_signature: "available",
        list_architectures: "target_unsupported",
        demangle_swift: "available",
        inspect_artifact: "available",
        extract_artifact: "available",
      });
    expect(entry("inspect_macho", zip).remediation).toContain("Mach-O");
  });

  it("reports an unsupported host before asking for a target", () => {
    const capabilities = declared(["inspect_macho"], {
      available: false,
      reason: "Native macOS utilities require macOS.",
    }).map((capability) => ({
      ...capability,
      availability_code: "unsupported_host" as const,
    }));
    for (const sessionStatus of [
      status({ capabilities }),
      status({ open: true, kind: "archive", format: "zip", capabilities }),
    ])
      expect(entry("inspect_macho", sessionStatus)).toMatchObject({
        reason: "unsupported_host",
        remediation: "Native macOS utilities require macOS.",
      });
    const composed = capabilities.map((capability) => ({
      ...capability,
      operation: "inspect_native_dispatch_metadata",
    }));
    expect(
      entry(
        "inspect_native_dispatch_metadata",
        status({ capabilities: composed }),
      ).reason,
    ).toBe("target_required");
  });
});

describe("capability inventory: caller guidance", () => {
  it("gives every unavailable public tool an actionable remediation", () => {
    const inventory = buildCapabilityInventory(status(), {
      ...enabledPolicy,
      processCaptureEnabled: false,
      browserObservationEnabled: false,
      electronObservationEnabled: false,
      v8InspectorObservationEnabled: false,
    });
    for (const availability of inventory)
      if (!availability.available) {
        expect(availability.reason).not.toBe("available");
        expect(availability.remediation).toEqual(expect.any(String));
        expect(availability.remediation?.length).toBeGreaterThan(0);
      }
  });

  it("keeps the public availability schema consistent with generated states", () => {
    const inventory = buildCapabilityInventory(status(), enabledPolicy);
    const unavailable = inventory.find(({ available }) => !available);
    expect(unavailable).toBeDefined();
    expect(toolAvailability.safeParse(unavailable).success).toBe(true);
    expect(
      toolAvailability.safeParse({ ...unavailable, available: true }).success,
    ).toBe(false);
    expect(
      toolAvailability.safeParse({
        ...unavailable,
        available: false,
        reason: "available",
      }).success,
    ).toBe(false);
  });

  it("does not require interactive elicitation for process capture", () => {
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
      optional: [],
      missing_required: [],
      missing_optional: [],
    });
    expect(withElicitation?.client_requirements).toEqual({
      required: [],
      optional: [],
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

describe("optional JavaScript recovery availability", () => {
  it("keeps optional recovery target-free and does not disable other static workflows", () => {
    expect(entry("recover_javascript_sources", status())).toMatchObject({
      available: false,
      reason: "provider_missing",
      remediation: expect.stringContaining("REA_WAKARU_COMMAND"),
    });
    expect(
      entry("recover_javascript_sources", status(), {
        processCaptureEnabled: true,
        javascriptRecoveryEnabled: true,
      }),
    ).toMatchObject({
      available: true,
      surface: "application",
    });
    expect(entry("analyze_javascript_application", status())).toMatchObject({
      available: true,
    });
    expect(entry("inspect_analysis_view", status())).toMatchObject({
      available: true,
      surface: "application",
    });
  });
});
