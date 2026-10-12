import { describe, expect, it } from "vitest";

import {
  buildCapabilityInventory,
  compactToolAvailability,
} from "./CapabilityInventory.js";
import { TOOL_CONTRACTS } from "../contracts/toolContracts.js";
import {
  expandToolAvailability,
  toolAvailabilityInventory,
  type ToolAvailability,
} from "../contracts/toolOutputSchemaPrimitives.js";

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
  capabilities:
    options.capabilities === undefined || options.capabilities.length === 0
      ? []
      : [
          {
            provider: { id: "fixture", name: "Fixture", version: "1" },
            shared_limitations: [],
            groups: options.capabilities.map((capability) => ({
              operations: [capability.operation],
              effects: [],
              limitations: [],
              available: capability.available,
              reason: capability.reason,
              availability_code: capability.available
                ? null
                : (capability.availability_code ?? null),
            })),
          },
        ],
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
  it("admits physical universal Mach-O targets for native Mach-O operations", () => {
    expect(
      entry(
        "inspect_native_dispatch_metadata",
        status({
          open: true,
          kind: "executable",
          format: "mach-o-universal",
          capabilities: [
            {
              operation: "inspect_native_dispatch_metadata",
              available: true,
              reason: null,
            },
          ],
        }),
      ),
    ).toMatchObject({ available: false, reason: "provider_missing" });
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
});

describe("compact tool availability", () => {
  it("round-trips complete facts, omitted modes, and per-group client requirements", () => {
    const full = buildCapabilityInventory(status(), enabledPolicy);
    const alternateRequirements = {
      required: ["roots"],
      optional: [],
      missing_required: ["roots"],
      missing_optional: [],
    } satisfies ToolAvailability["client_requirements"];
    const withOverride = full.map((entry, index) =>
      index === 1
        ? {
            ...entry,
            available: false as const,
            reason: "client_capability_missing" as const,
            remediation: "Use an MCP client with roots support.",
            client_requirements: alternateRequirements,
          }
        : entry,
    );
    const compact = compactToolAvailability(withOverride);
    const expanded = expandToolAvailability(compact).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );

    expect(expanded).toEqual(
      withOverride.toSorted((left, right) =>
        left.name.localeCompare(right.name),
      ),
    );
    expect(compact.client_requirements).toEqual(
      withOverride[0]?.client_requirements,
    );
    expect(
      compact.groups.find((group) => group.client_requirements !== undefined)
        ?.client_requirements,
    ).toEqual(alternateRequirements);
    expect(compact.groups.every((group) => group.names.length > 0)).toBe(true);
    const names = compact.groups.flatMap((group) => group.names).sort();
    expect(names).toEqual(TOOL_CONTRACTS.map(({ name }) => name).sort());
    expect(new Set(names).size).toBe(names.length);
    expect(expanded.some((entry) => !Object.hasOwn(entry, "modes"))).toBe(true);
  });

  it("preserves an empty inventory with an explicit empty client baseline", () => {
    const compact = compactToolAvailability([]);
    expect(compact).toEqual({
      client_requirements: {
        required: [],
        optional: [],
        missing_required: [],
        missing_optional: [],
      },
      groups: [],
    });
    expect(expandToolAvailability(compact)).toEqual([]);
  });

  it("rejects malformed compact facts and accepts an equivalent explicit baseline", () => {
    const compact = compactToolAvailability(
      buildCapabilityInventory(status(), enabledPolicy),
    );
    const firstGroup = compact.groups[0];
    expect(firstGroup).toBeDefined();
    if (firstGroup === undefined) throw new Error("Expected tool groups");
    const availableIndex = compact.groups.findIndex((group) => group.available);
    if (availableIndex < 0) throw new Error("Expected an available tool group");

    const malformedInventories = [
      {
        ...compact,
        groups: compact.groups.map((group, index) =>
          index === 0
            ? { ...group, effects: [...group.effects, "unknown_effect"] }
            : group,
        ),
      },
      {
        ...compact,
        groups: compact.groups.map((group, index) =>
          index === 0
            ? {
                ...group,
                annotations: [...group.annotations, "unknown_hint"],
              }
            : group,
        ),
      },
      {
        ...compact,
        groups: compact.groups.map((group, index) =>
          index === 0 ? { ...group, names: [] } : group,
        ),
      },
      {
        ...compact,
        groups: compact.groups.map((group, index) =>
          index === 0 ? { ...group, names: [""] } : group,
        ),
      },
      {
        ...compact,
        groups: compact.groups.map((group, index) =>
          index === availableIndex
            ? { ...group, reason: "provider_missing" }
            : group,
        ),
      },
      {
        ...compact,
        groups: compact.groups.map((group, index) =>
          index === availableIndex
            ? { ...group, remediation: "unexpected remediation" }
            : group,
        ),
      },
    ];
    for (const malformed of malformedInventories)
      expect(toolAvailabilityInventory.safeParse(malformed).success).toBe(
        false,
      );

    const inheritedGroup = compact.groups.find(
      (group) => group.client_requirements === undefined,
    );
    expect(inheritedGroup).toBeDefined();
    if (inheritedGroup === undefined)
      throw new Error("Expected an inherited client-requirements group");
    const explicitBaseline = {
      ...compact,
      groups: compact.groups.map((group) =>
        group === inheritedGroup
          ? { ...group, client_requirements: compact.client_requirements }
          : group,
      ),
    };
    const parsedOverride =
      toolAvailabilityInventory.safeParse(explicitBaseline);
    expect(parsedOverride.success).toBe(true);
    if (parsedOverride.success)
      expect(expandToolAvailability(parsedOverride.data)).toEqual(
        expandToolAvailability(compact),
      );
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

  it("lists shared missing operations once in combined remediation", () => {
    const availability = entry(
      "get_navigation_context",
      status({ open: true, kind: "executable" }),
    );

    expect(availability).toMatchObject({
      reason: "provider_missing",
      remediation:
        "Configure a provider for one of: current_document, current_address, resolve_containing_procedure.",
      modes: [
        {
          name: "current_selection",
          missing_operations: [
            "current_document",
            "current_address",
            "resolve_containing_procedure",
          ],
        },
        {
          name: "explicit_document",
          missing_operations: [
            "current_address",
            "resolve_containing_procedure",
          ],
        },
      ],
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
