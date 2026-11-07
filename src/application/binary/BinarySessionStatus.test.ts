import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";
import { describe, expect, it } from "vitest";

import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import { z } from "zod";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { ProviderRejectionCode } from "../../domain/providerSelection.js";
import {
  analysisProviderCandidate,
  analysisProviderCandidateSummary,
  expandProviderCapabilities,
  expandToolAvailability,
  operationProviderCandidate,
  operationRequirements,
  sessionProviderFacts,
  type ProviderCapabilitySet,
} from "../../contracts/toolOutputSchemaPrimitives.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import type { ResolvedAppBundleResourceRoot } from "../AppBundleExecutable.js";
import type { AnalysisProviderCandidateStatus } from "./AnalysisProviderRegistry.js";
import type {
  SessionProviderRoute,
  SessionProviderRouter,
} from "./SessionProviderRouter.js";
import {
  binarySessionStatus,
  restrictAdvertisedCapabilities,
} from "./BinarySessionStatus.js";
import {
  APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE,
  nativeMacOSCapabilities,
} from "../../native/NativeMacOSProviderMetadata.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY } from "../../native/NativeMacosProviderIdentity.js";
import {
  buildCapabilityInventory,
  compactToolAvailability,
  MULTI_MODE_REMEDIATION,
} from "../CapabilityInventory.js";

const projectedStatusSchema = z.object({
  capabilities: sessionProviderFacts.shape.capabilities,
  analysis_provider_candidates: z.array(analysisProviderCandidate),
});
const summaryStatusSchema = z.object({
  capabilities: sessionProviderFacts.shape.capabilities,
  analysis_provider_candidates: z.array(analysisProviderCandidateSummary),
});

const providerA: ProviderIdentity = {
  id: "provider-a",
  name: "Provider A",
  version: "1.0",
};
const providerB: ProviderIdentity = {
  id: "provider-b",
  name: "Provider B",
  version: "2.0",
};

const MUTATING_EFFECTS = {
  mutates_artifact: true,
  launches_process: false,
  may_show_ui: false,
  may_access_network: false,
  may_write_filesystem: false,
  changes_permissions: false,
  requires_root: false,
};

type DescriptorOptions = {
  readonly launchesProcess?: boolean;
} & (
  | {
      readonly available?: true;
      readonly reason?: never;
      readonly availabilityCode?: never;
    }
  | {
      readonly available: false;
      readonly reason?: string;
      readonly availabilityCode?: ProviderRejectionCode;
    }
);

const descriptor = (
  provider: ProviderIdentity,
  operation: CapabilityDescriptor["operation"],
  limitations: readonly string[],
  options: DescriptorOptions = {},
): CapabilityDescriptor => {
  const availability =
    options.available === false
      ? {
          available: false as const,
          reason: options.reason ?? "Unavailable",
          ...(options.availabilityCode === undefined
            ? {}
            : { availabilityCode: options.availabilityCode }),
        }
      : { available: true as const, reason: null };
  return {
    provider,
    operation,
    ...availability,
    effects: {
      mutatesArtifact: true,
      launchesProcess: options.launchesProcess ?? false,
      mayShowUi: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: false,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations,
  };
};

const candidate = (
  provider: ProviderIdentity,
  capabilities: readonly CapabilityDescriptor[],
): AnalysisProviderCandidateStatus => ({
  provider,
  availability: {
    status: "available",
    code: null,
    reason: null,
    diagnostics: {},
  },
  targetSupport: {
    status: "unknown",
    code: null,
    reason: "No target is open.",
    diagnostics: {},
  },
  selected: true,
  capabilities,
});

const project = async (
  routeCapabilities: readonly CapabilityDescriptor[],
  candidates: readonly AnalysisProviderCandidateStatus[],
  runtimeUnavailability: ReadonlyMap<
    string,
    { readonly reason: string }
  > = new Map(),
  target?: BinaryTarget,
) =>
  projectedStatusSchema.parse(
    await projectStatus(routeCapabilities, candidates, {
      runtimeUnavailability,
      ...(target === undefined ? {} : { target }),
    }),
  );

const projectStatus = async (
  routeCapabilities: readonly CapabilityDescriptor[],
  candidates: readonly AnalysisProviderCandidateStatus[],
  options: {
    readonly runtimeUnavailability?: ReadonlyMap<
      string,
      { readonly reason: string }
    >;
    readonly target?: BinaryTarget;
    readonly detail?: "summary" | "complete" | "operation";
    readonly operation?: string;
    readonly deepOperations?: readonly string[];
    readonly bundleResourceRoot?: ResolvedAppBundleResourceRoot;
  } = {},
) => {
  const route: SessionProviderRoute = {
    identity: providerA,
    profile: null,
    selection: undefined,
    createClient: () => {
      throw new Error("Projection does not create clients");
    },
    capabilities: new Map(
      routeCapabilities.map((capability) => [capability.operation, capability]),
    ),
    binding: null,
  };
  const router: Pick<
    SessionProviderRouter,
    "candidateStatuses" | "deepOperations"
  > = {
    candidateStatuses: async () => candidates,
    deepOperations: () =>
      new Set(
        options.deepOperations ??
          candidates.flatMap(({ capabilities }) =>
            capabilities.map(({ operation }) => operation),
          ),
      ),
  };
  return binarySessionStatus({
    investigation: {
      evidence_records: 0,
      unknown_revisions: 0,
      unknown_heads: 0,
      retained_representation_bytes: 0,
      maximum_representation_bytes: 0,
      persistence: "memory",
    },
    target: options.target,
    route,
    router,
    runtimeUnavailability: options.runtimeUnavailability ?? new Map(),
    runId: undefined,
    runtimeLineageSnapshots: [],
    requestActivitySnapshots: [],
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.operation === undefined
      ? {}
      : { operation: options.operation }),
    ...(options.bundleResourceRoot === undefined
      ? {}
      : { bundleResourceRoot: options.bundleResourceRoot }),
  });
};

const expandCanonicalCapabilities = (sets: readonly ProviderCapabilitySet[]) =>
  [...expandProviderCapabilities(sets)].sort((left, right) =>
    compareUnicodeCodePoints(left.operation, right.operation),
  );

const selectedCapabilities = [
  descriptor(providerA, "xrefs", ["Shared limitation"]),
  descriptor(providerA, "procedure_info", ["Shared limitation"]),
  descriptor(providerA, "read_bytes", ["Shared limitation", "beta detail"]),
];
const otherCapabilities = [
  descriptor(providerB, "read_bytes", ["Different limitation"], {
    launchesProcess: true,
    available: false,
    reason: "Architecture unsupported",
    availabilityCode: "architecture_unsupported",
  }),
];

const expectedRouteCapabilities: ProviderCapabilitySet[] = [
  {
    provider: providerA,
    shared_limitations: ["Shared limitation"],
    groups: [
      {
        operations: ["procedure_info"],
        effects: ["mutates_artifact"],
        limitations: [],
        available: false,
        reason: "Runtime operation failure",
        availability_code: null,
        runtime_unavailable: true,
      },
      {
        operations: ["read_bytes"],
        effects: ["mutates_artifact"],
        limitations: ["beta detail"],
        available: true,
        reason: null,
        availability_code: null,
      },
      {
        operations: ["xrefs"],
        effects: ["mutates_artifact"],
        limitations: [],
        available: true,
        reason: null,
        availability_code: null,
      },
    ],
  },
];
const expectedExpandedRouteCapabilities = [
  {
    provider: providerA,
    operation: "procedure_info",
    available: false,
    reason: "Runtime operation failure",
    availability_code: null,
    runtime_unavailable: true,
    effects: MUTATING_EFFECTS,
    limitations: ["Shared limitation"],
  },
  {
    provider: providerA,
    operation: "read_bytes",
    available: true,
    reason: null,
    availability_code: null,
    effects: MUTATING_EFFECTS,
    limitations: ["Shared limitation", "beta detail"],
  },
  {
    provider: providerA,
    operation: "xrefs",
    available: true,
    reason: null,
    availability_code: null,
    effects: MUTATING_EFFECTS,
    limitations: ["Shared limitation"],
  },
];
const expectedCandidateCapabilities: ProviderCapabilitySet[] = [
  {
    provider: providerA,
    shared_limitations: ["Shared limitation"],
    groups: [
      {
        operations: ["procedure_info", "xrefs"],
        effects: ["mutates_artifact"],
        limitations: [],
        available: true,
        reason: null,
        availability_code: null,
      },
      {
        operations: ["read_bytes"],
        effects: ["mutates_artifact"],
        limitations: ["beta detail"],
        available: true,
        reason: null,
        availability_code: null,
      },
    ],
  },
  {
    provider: providerB,
    shared_limitations: ["Different limitation"],
    groups: [
      {
        operations: ["read_bytes"],
        effects: ["mutates_artifact", "launches_process"],
        limitations: [],
        available: false,
        reason: "Architecture unsupported",
        availability_code: "architecture_unsupported",
      },
    ],
  },
];
const expectedCandidateStatusFacts = [
  expect.objectContaining({
    provider: providerA,
    target_support: {
      status: "unknown",
      code: null,
      reason: "No target is open.",
      diagnostics: {},
    },
    capabilities: [expectedCandidateCapabilities[0]],
  }),
  expect.objectContaining({
    provider: providerB,
    capabilities: [expectedCandidateCapabilities[1]],
  }),
];
const expectedExpandedCandidateCapabilities = [
  [
    {
      provider: providerA,
      operation: "procedure_info",
      available: true,
      reason: null,
      availability_code: null,
      effects: MUTATING_EFFECTS,
      limitations: ["Shared limitation"],
    },
    {
      provider: providerA,
      operation: "read_bytes",
      available: true,
      reason: null,
      availability_code: null,
      effects: MUTATING_EFFECTS,
      limitations: ["Shared limitation", "beta detail"],
    },
    {
      provider: providerA,
      operation: "xrefs",
      available: true,
      reason: null,
      availability_code: null,
      effects: MUTATING_EFFECTS,
      limitations: ["Shared limitation"],
    },
  ],
  [
    {
      provider: providerB,
      operation: "read_bytes",
      available: false,
      reason: "Architecture unsupported",
      availability_code: "architecture_unsupported",
      effects: { ...MUTATING_EFFECTS, launches_process: true },
      limitations: ["Different limitation"],
    },
  ],
];

describe("binary session provider capability projection", () => {
  it("keeps the private dispatch reader profile out of public capability status", async () => {
    const capabilities = nativeMacOSCapabilities("darwin");
    const projected = await project(capabilities, [
      candidate(NATIVE_MACOS_PROVIDER_IDENTITY, capabilities),
    ]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(
      APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE.provider.version,
    );
    expect(serialized).not.toContain(
      APPLE_DISPATCH_METADATA_ANALYSIS_PROFILE.digest,
    );
    expect(projectedStatusSchema.parse(projected)).toEqual(projected);
  });

  it("preserves provider scope and route overlays while factoring exact prefixes", async () => {
    const selectedBefore = structuredClone(selectedCapabilities);
    const otherBefore = structuredClone(otherCapabilities);
    const status = await project(
      selectedCapabilities,
      [
        candidate(providerA, selectedCapabilities),
        candidate(providerB, otherCapabilities),
      ],
      new Map([["procedure_info", { reason: "Runtime operation failure" }]]),
    );
    expect(selectedCapabilities).toEqual(selectedBefore);
    expect(otherCapabilities).toEqual(otherBefore);
    expect(status.capabilities).toEqual(expectedRouteCapabilities);
    expect(expandCanonicalCapabilities(status.capabilities)).toEqual(
      expectedExpandedRouteCapabilities,
    );
    expect(status.analysis_provider_candidates).toEqual(
      expectedCandidateStatusFacts,
    );
    const selectedCandidate = status.analysis_provider_candidates[0];
    const otherCandidate = status.analysis_provider_candidates[1];
    expect(selectedCandidate).toBeDefined();
    expect(otherCandidate).toBeDefined();
    expect(
      expandCanonicalCapabilities(selectedCandidate?.capabilities ?? []),
    ).toEqual(expectedExpandedCandidateCapabilities[0]);
    expect(
      expandCanonicalCapabilities(otherCandidate?.capabilities ?? []),
    ).toEqual(expectedExpandedCandidateCapabilities[1]);
  });

  it("restricts the public report without erasing provider facts", async () => {
    const status = await project(selectedCapabilities, [
      candidate(providerA, selectedCapabilities),
      candidate(providerB, otherCapabilities),
    ]);
    const restricted = projectedStatusSchema.parse(
      restrictAdvertisedCapabilities(
        structuredClone(status),
        (operation) => operation !== "read_bytes",
      ),
    );

    // The complete facts remain available for availability checks: a composed
    // tool can depend on an operation the public report hides.
    expect(
      expandCanonicalCapabilities(status.capabilities).map(
        ({ operation }) => operation,
      ),
    ).toContain("read_bytes");
    // A scoped registration hides these tools from `tools/list`, so naming
    // them in the public report would direct the agent to a failing call.
    expect(
      expandCanonicalCapabilities(restricted.capabilities).map(
        ({ operation }) => operation,
      ),
    ).toEqual(["procedure_info", "xrefs"]);
    expect(
      expandCanonicalCapabilities(
        restricted.analysis_provider_candidates[0]?.capabilities ?? [],
      ).map(({ operation }) => operation),
    ).toEqual(["procedure_info", "xrefs"]);
    expect(restricted.analysis_provider_candidates[1]?.capabilities).toEqual(
      [],
    );
  });

  it("keeps empty route and candidate capability collections empty", async () => {
    const status = await project([], [candidate(providerA, [])]);
    expect(status.capabilities).toEqual([]);
    expect(status.analysis_provider_candidates[0]?.capabilities).toEqual([]);
  });

  it("preserves repeated limitations in their original order", async () => {
    const capabilities = [
      descriptor(providerA, "procedure_info", [
        "Repeated",
        "Repeated",
        "left detail",
      ]),
      descriptor(providerA, "xrefs", ["Repeated", "Repeated", "right detail"]),
    ];
    const status = await project(capabilities, []);

    expect(status.capabilities[0]).toMatchObject({
      shared_limitations: ["Repeated", "Repeated"],
      groups: [
        { operations: ["procedure_info"], limitations: ["left detail"] },
        { operations: ["xrefs"], limitations: ["right detail"] },
      ],
    });
    expect(
      expandCanonicalCapabilities(status.capabilities).map(
        ({ limitations }) => limitations,
      ),
    ).toEqual([
      ["Repeated", "Repeated", "left detail"],
      ["Repeated", "Repeated", "right detail"],
    ]);
  });
});

it.each(["elf", "pe"] as const)(
  "reports format rejection for %s dylib discovery",
  async (format) => {
    const target: BinaryTarget = {
      kind: "executable",
      format,
      path: "/fixture",
      sha256: "a".repeat(64),
      architecture: "x86_64",
      availableArchitectures: ["x86_64"],
      ...(format === "pe"
        ? { executableRole: "application" as const, managed: false }
        : {}),
    } as BinaryTarget;
    const status = await project(
      [descriptor(providerA, "trace_dylib_resolution", [])],
      [],
      new Map(),
      target,
    );
    expect(expandCanonicalCapabilities(status.capabilities)).toMatchObject([
      {
        operation: "trace_dylib_resolution",
        available: false,
        availability_code: "target_format_unsupported",
      },
    ]);
  },
);

const dispatchTarget = (format: "elf" | "mach-o"): BinaryTarget => ({
  kind: "executable",
  format,
  path: "/fixture",
  sha256: "a".repeat(64),
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
});

it.each([
  { format: "elf", symbols: false, nativeAvailable: false, route: false },
  { format: "elf", symbols: true, nativeAvailable: false, route: true },
  { format: "mach-o", symbols: false, nativeAvailable: true, route: true },
] as const)(
  "projects $format dispatch applicability and symbol fallback ($symbols)",
  async ({ format, symbols, nativeAvailable, route }) => {
    const target = dispatchTarget(format);
    const native = nativeMacOSCapabilities("darwin").find(
      (item) => item.operation === "inspect_native_dispatch_metadata",
    );
    if (native === undefined) throw new Error("Missing native dispatch reader");
    const capabilities = [
      native,
      descriptor(providerA, "decode_interface_builder", []),
      descriptor(providerA, "procedure_address", []),
      descriptor(providerA, "procedure_callees", []),
      ...(symbols ? [descriptor(providerA, "list_names", [])] : []),
    ];
    const status = await projectStatus(capabilities, [], { target });
    const parsed = projectedStatusSchema.parse(status);
    const projected = expandCanonicalCapabilities(parsed.capabilities).find(
      (item) => item.operation === "inspect_native_dispatch_metadata",
    );
    expect(projected).toMatchObject({
      available: nativeAvailable,
      availability_code: nativeAvailable ? null : "target_format_unsupported",
    });
    const inventory = buildCapabilityInventory(status, {
      processCaptureEnabled: false,
    });
    const dispatch = inventory.find(
      (item) => item.name === "inspect_native_dispatch_metadata",
    );
    expect(dispatch?.available).toBe(route);
    const trace = inventory.find(
      (item) => item.name === "trace_native_ui_action",
    );
    expect(
      trace?.modes?.find((mode) => mode.name === "native_seed_call_trace"),
    ).toMatchObject({
      available: route,
      missing_operations: route
        ? []
        : ["inspect_native_dispatch_metadata", "list_names"],
    });
    if (!route) {
      expect(trace?.remediation).toBe(MULTI_MODE_REMEDIATION);
      const authored = trace?.modes?.find(
        (mode) => mode.name === "authored_ui_dispatch",
      );
      const nativeSeed = trace?.modes?.find(
        (mode) => mode.name === "native_seed_call_trace",
      );
      expect(authored?.remediation).not.toBe(nativeSeed?.remediation);
      expect(authored?.missing_operations).toContain(
        "decode_interface_builder",
      );
    }
  },
);

it("does not impose the Apple reader's target rule on another provider", async () => {
  const target = dispatchTarget("elf");
  const status = await projectStatus(
    [descriptor(providerA, "inspect_native_dispatch_metadata", [])],
    [],
    { target },
  );
  const projected = expandCanonicalCapabilities(
    projectedStatusSchema.parse(status).capabilities,
  );
  expect(projected).toMatchObject([
    { operation: "inspect_native_dispatch_metadata", available: true },
  ]);
  const inventory = buildCapabilityInventory(status, {
    processCaptureEnabled: false,
  });
  expect(
    inventory.find((item) => item.name === "inspect_native_dispatch_metadata"),
  ).toMatchObject({ available: true });
});

it("keeps distinct recovery for an unbound non-bundle session", async () => {
  const native = nativeMacOSCapabilities("darwin").find(
    (item) => item.operation === "inspect_native_dispatch_metadata",
  );
  if (native === undefined) throw new Error("Missing native dispatch reader");
  const status = await projectStatus(
    [native, descriptor(providerA, "decode_interface_builder", [])],
    [],
    { target: dispatchTarget("mach-o") },
  );
  const inventory = buildCapabilityInventory(status, {
    processCaptureEnabled: false,
  });
  const trace = inventory.find(
    (item) => item.name === "trace_native_ui_action",
  );
  expect(trace).toMatchObject({
    available: false,
    reason: "provider_unavailable",
    remediation: MULTI_MODE_REMEDIATION,
  });
  const authored = trace?.modes?.find(
    (mode) => mode.name === "authored_ui_dispatch",
  );
  const nativeSeed = trace?.modes?.find(
    (mode) => mode.name === "native_seed_call_trace",
  );
  expect(authored?.missing_operations).toContain("decode_interface_builder");
  expect(nativeSeed?.missing_operations).toContain("procedure_address");
  expect(authored?.remediation).not.toBe(nativeSeed?.remediation);
});

it("keeps host unavailability ahead of target applicability", async () => {
  const native = nativeMacOSCapabilities("linux").find(
    (item) => item.operation === "inspect_native_dispatch_metadata",
  );
  if (native === undefined) throw new Error("Missing native dispatch reader");
  const target = dispatchTarget("elf");
  const projected = await project([native], [], new Map(), target);
  expect(expandCanonicalCapabilities(projected.capabilities)).toMatchObject([
    {
      operation: "inspect_native_dispatch_metadata",
      available: false,
      availability_code: "unsupported_host",
    },
  ]);
});

describe("binary session summary projection", () => {
  it("keeps each candidate's status, code and reason in summary without diagnostics or capability sets", async () => {
    const unavailable: AnalysisProviderCandidateStatus = {
      ...candidate(providerB, otherCapabilities),
      availability: {
        status: "unavailable",
        code: "not_configured",
        reason: "PROVIDER_B_HOME is not set.",
        remediation: "Set PROVIDER_B_HOME; see docs/provider-b.md.",
        diagnostics: { checks: [{ name: "configuration", ok: false }] },
      },
      targetSupport: {
        status: "unsupported",
        code: "architecture_unsupported",
        reason: "Provider B cannot select this slice.",
        diagnostics: { architecture: "arm64" },
      },
      selected: false,
    };
    const pending: AnalysisProviderCandidateStatus = {
      ...candidate(providerA, selectedCapabilities),
      availability: {
        status: "unknown",
        code: null,
        reason: "Provider A startup is still pending.",
        diagnostics: { startup: "pending" },
      },
    };
    const candidates = [pending, unavailable];
    const before = structuredClone(candidates);
    const runtimeUnavailability = new Map([
      ["procedure_info", { reason: "Runtime operation failure" }],
    ]);
    const complete = projectedStatusSchema.parse(
      await projectStatus(selectedCapabilities, candidates, {
        runtimeUnavailability,
      }),
    );
    const raw = await projectStatus(selectedCapabilities, candidates, {
      runtimeUnavailability,
      detail: "summary",
    });
    const summary = summaryStatusSchema.parse(raw);

    expect(candidates).toEqual(before);
    expect(summary.capabilities).toEqual(complete.capabilities);
    expect(summary.analysis_provider_candidates).toEqual([
      {
        provider: providerA,
        availability: {
          status: "unknown",
          code: null,
          reason: "Provider A startup is still pending.",
        },
        target_support: {
          status: "unknown",
          code: null,
          reason: "No target is open.",
        },
        selected: true,
      },
      {
        provider: providerB,
        availability: {
          status: "unavailable",
          code: "not_configured",
          reason: "PROVIDER_B_HOME is not set.",
        },
        target_support: {
          status: "unsupported",
          code: "architecture_unsupported",
          reason: "Provider B cannot select this slice.",
        },
        selected: false,
      },
    ]);
    expect(JSON.stringify(raw)).not.toContain("diagnostics");
    // Complete detail keeps the owner's repair; summary omits it.
    expect(
      complete.analysis_provider_candidates[1]?.availability,
    ).toMatchObject({
      remediation: "Set PROVIDER_B_HOME; see docs/provider-b.md.",
    });
    expect(JSON.stringify(raw)).not.toContain("PROVIDER_B_HOME;");
    expect(
      analysisProviderCandidate
        .array()
        .safeParse(summary.analysis_provider_candidates).success,
    ).toBe(false);
  });
});

it("narrows summary capabilities without inventing omitted candidate facts", async () => {
  const source = await projectStatus(
    selectedCapabilities,
    [candidate(providerA, selectedCapabilities)],
    { detail: "summary" },
  );
  const summary = summaryStatusSchema.parse(source);
  const selected = summaryStatusSchema.parse(
    restrictAdvertisedCapabilities(
      source,
      (operation) => operation === "read_bytes",
    ),
  );
  expect(
    expandCanonicalCapabilities(selected.capabilities).map(
      ({ operation }) => operation,
    ),
  ).toEqual(["read_bytes"]);
  expect(selected.analysis_provider_candidates).toEqual(
    summary.analysis_provider_candidates,
  );
  expect(selected.analysis_provider_candidates[0]).not.toHaveProperty(
    "capabilities",
  );
  expect(selected.analysis_provider_candidates[0]!.target_support).toEqual({
    status: "unknown",
    code: null,
    reason: "No target is open.",
  });
});

it("groups readiness repairs exactly and drops one replaced by a runtime observation", async () => {
  const unavailable = (
    operation: CapabilityDescriptor["operation"],
    remediation: string,
  ): CapabilityDescriptor => {
    const declared = descriptor(providerA, operation, [], {
      available: false,
      reason: "Configured registration is invalid.",
    });
    if (declared.available) throw new Error("Expected an unavailable fixture");
    return { ...declared, remediation };
  };
  const status = await project(
    [
      unavailable("procedure_info", "Correct REA_FIXTURE_CONFIG."),
      unavailable("read_bytes", "Correct REA_FIXTURE_CONFIG."),
      unavailable("list_names", "Unset REA_FIXTURE_CACHE."),
      unavailable("xrefs", "Correct REA_FIXTURE_CONFIG."),
    ],
    [],
    new Map([["xrefs", { reason: "Runtime operation failure" }]]),
  );
  const groups = status.capabilities.flatMap(({ groups }) => groups);
  expect(groups).toEqual([
    expect.objectContaining({
      operations: ["list_names"],
      remediation: "Unset REA_FIXTURE_CACHE.",
    }),
    expect.objectContaining({
      operations: ["procedure_info", "read_bytes"],
      reason: "Configured registration is invalid.",
      remediation: "Correct REA_FIXTURE_CONFIG.",
    }),
    expect.not.objectContaining({ remediation: expect.anything() }),
  ]);
  expect(groups[2]).toMatchObject({
    operations: ["xrefs"],
    reason: "Runtime operation failure",
  });
  const inventory = new Map(
    buildCapabilityInventory(
      { open: true, kind: "executable", capabilities: status.capabilities },
      { processCaptureEnabled: true },
    ).map((entry) => [entry.name, entry]),
  );
  expect(inventory.get("procedure_info")?.remediation).toBe(
    "Correct REA_FIXTURE_CONFIG.",
  );
  // A static or runtime-only refusal has no separate repair to prefer.
  expect(inventory.get("xrefs")?.remediation).toBe("Runtime operation failure");
  // A scoped registration narrows operations without dropping their repair.
  const scoped = projectedStatusSchema.parse(
    restrictAdvertisedCapabilities(
      status,
      (operation) => operation === "procedure_info",
    ),
  );
  expect(scoped.capabilities.flatMap(({ groups }) => groups)).toEqual([
    expect.objectContaining({
      operations: ["procedure_info"],
      remediation: "Correct REA_FIXTURE_CONFIG.",
    }),
  ]);
});

it("keeps independent decompilation and value flow in distinct capability groups", async () => {
  const status = await projectStatus(
    [
      {
        ...descriptor(providerA, "procedure_pseudo_code", []),
        independentDecompile: true,
      },
      {
        ...descriptor(providerA, "analyze_function", []),
        nativeValueFlow: { status: "supported" as const },
      },
      descriptor(providerA, "xrefs", []),
    ],
    [],
  );
  const projected = z
    .object({ capabilities: sessionProviderFacts.shape.capabilities })
    .parse(status);
  const capabilities = expandProviderCapabilities(projected.capabilities);
  expect(
    capabilities.find((item) => item.operation === "procedure_pseudo_code"),
  ).toMatchObject({ independent_decompile: true });
  expect(
    capabilities.find((item) => item.operation === "analyze_function"),
  ).toMatchObject({ native_value_flow: { status: "supported" } });
  expect(
    capabilities.find((item) => item.operation === "xrefs"),
  ).not.toHaveProperty("independent_decompile");
  expect(
    capabilities.find((item) => item.operation === "xrefs"),
  ).not.toHaveProperty("native_value_flow");
});

it.each([
  { detail: "summary", supported: true },
  { detail: "complete", supported: true },
  { detail: "summary", supported: false },
  { detail: "complete", supported: false },
] as const)(
  "retains routed value-flow ownership and runtime failures in $detail discovery when supported=$supported",
  async ({ detail, supported }) => {
    const source = {
      ...descriptor(providerA, "analyze_function", []),
      nativeValueFlow: supported
        ? { status: "supported" as const }
        : { status: "unavailable" as const, reason: "No value flow." },
    };
    const resolver = descriptor(providerB, "resolve_native_call_targets", []);
    const providerC = { id: "provider-c", name: "Provider C", version: "3" };
    const unselected = {
      ...descriptor(providerC, "analyze_function", []),
      nativeValueFlow: { status: "unavailable" as const, reason: "Unselected" },
    };
    const status = await projectStatus(
      [source, resolver],
      [{ ...candidate(providerC, [unselected]), selected: false }],
      {
        target: dispatchTarget("elf"),
        detail,
        runtimeUnavailability: new Map([
          ["resolve_native_call_targets", { reason: "Resolver failed." }],
        ]),
      },
    );
    const projected = z
      .object({ capabilities: sessionProviderFacts.shape.capabilities })
      .parse(status);
    const route = expandProviderCapabilities(projected.capabilities);
    expect(
      route.find((item) => item.operation === "analyze_function"),
    ).toMatchObject({
      provider: providerA,
      native_value_flow: { status: supported ? "supported" : "unavailable" },
    });
    const inventory = buildCapabilityInventory(status, {
      processCaptureEnabled: false,
    });
    const item = expandToolAvailability(
      compactToolAvailability(inventory, detail),
    ).find((candidate) => candidate.name === "trace_native_values");
    expect(item).toMatchObject({
      available: false,
      reason: "provider_unavailable",
      remediation: expect.stringContaining("Resolver failed."),
      value_flow_support: {
        status: supported ? "supported" : "unavailable",
        provider_id: providerA.id,
      },
    });
    if (!supported) expect(item?.remediation).toContain("No value flow.");
  },
);

it("preserves an unsupported resolver host alongside unavailable value flow", async () => {
  const source = {
    ...descriptor(providerA, "analyze_function", []),
    nativeValueFlow: {
      status: "unavailable" as const,
      reason: "No value flow.",
    },
  };
  const resolver = {
    ...descriptor(providerB, "resolve_native_call_targets", [], {
      available: false,
      reason: "Resolver host is unsupported.",
      availabilityCode: "unsupported_host",
    }),
    remediation: "Use a supported resolver host.",
  };
  const status = await projectStatus([source, resolver], [], {
    target: dispatchTarget("elf"),
    detail: "summary",
  });
  const item = buildCapabilityInventory(status, {
    processCaptureEnabled: false,
  }).find((entry) => entry.name === "trace_native_values");
  expect(item).toMatchObject({ available: false, reason: "unsupported_host" });
  expect(item?.remediation).toContain("No value flow.");
  expect(item?.remediation).toContain("Use a supported resolver host.");
});

const providerC: ProviderIdentity = {
  id: "provider-c",
  name: "Provider C",
  version: null,
};
const operationStatusSchema = z.object({
  capabilities: sessionProviderFacts.shape.capabilities,
  operation: z.string(),
  operation_requirements: operationRequirements,
  operation_candidates: z.array(operationProviderCandidate),
});
const searchCandidates = (): AnalysisProviderCandidateStatus[] => [
  candidate(providerA, [descriptor(providerA, "search_bytes", [])]),
  {
    ...candidate(providerB, [
      descriptor(providerB, "search_bytes", [], {
        available: false,
        reason: "Masked byte search has not been verified for Provider B.",
      }),
    ]),
    availability: {
      status: "unavailable",
      code: "unsupported_host",
      reason: "Provider B does not run on this host.",
      remediation: "Use a supported host.",
      diagnostics: { platform: "win32" },
    },
    selected: false,
  },
  {
    ...candidate(providerC, [descriptor(providerC, "xrefs", [])]),
    targetSupport: {
      status: "unsupported",
      code: "target_format_unsupported",
      reason: "Provider C cannot read this format.",
      diagnostics: {},
    },
    selected: false,
  },
];

describe("binary session operation projection", () => {
  it("keeps readiness, target support, selection and declaration separate for one operation", async () => {
    const candidates = searchCandidates();
    const before = structuredClone(candidates);
    const raw = await projectStatus(selectedCapabilities, candidates, {
      detail: "operation",
      operation: "search_bytes",
    });
    const view = operationStatusSchema.parse(raw);

    expect(candidates).toEqual(before);
    expect(raw).not.toHaveProperty("analysis_provider_candidates");
    expect(JSON.stringify(raw)).not.toContain("diagnostics");
    expect(JSON.stringify(raw)).not.toContain("Use a supported host.");
    expect(view.operation).toBe("search_bytes");
    expect(view.operation_requirements).toEqual({
      kind: "operations",
      requirements: ["search_bytes"],
    });
    expect(view.operation_candidates).toEqual([
      {
        provider: providerA,
        selected: true,
        availability: { status: "available", code: null, reason: null },
        // Unknown stays unknown; it is not reported as unsupported.
        target_support: {
          status: "unknown",
          code: null,
          reason: "No target is open.",
        },
        declaration: {
          status: "available",
          missing_operations: [],
          operations: [{ operation: "search_bytes", status: "available" }],
        },
      },
      {
        provider: providerB,
        selected: false,
        availability: {
          status: "unavailable",
          code: "unsupported_host",
          reason: "Provider B does not run on this host.",
        },
        target_support: {
          status: "unknown",
          code: null,
          reason: "No target is open.",
        },
        declaration: {
          status: "unavailable",
          missing_operations: ["search_bytes"],
          operations: [
            {
              operation: "search_bytes",
              status: "unavailable",
              reason:
                "Masked byte search has not been verified for Provider B.",
              availability_code: null,
            },
          ],
        },
      },
      {
        provider: providerC,
        selected: false,
        availability: { status: "available", code: null, reason: null },
        target_support: {
          status: "unsupported",
          code: "target_format_unsupported",
          reason: "Provider C cannot read this format.",
        },
        declaration: {
          status: "not_declared",
          missing_operations: ["search_bytes"],
          operations: [{ operation: "search_bytes", status: "not_declared" }],
        },
      },
    ]);
    // Route capabilities stay those of the current route, as in summary.
    const summary = summaryStatusSchema.parse(
      await projectStatus(selectedCapabilities, candidates, {
        detail: "summary",
      }),
    );
    expect(view.capabilities).toEqual(summary.capabilities);
  });

  it("reports no alternative without inventing one", async () => {
    const [, unavailable, undeclared] = searchCandidates();
    const view = operationStatusSchema.parse(
      await projectStatus(
        selectedCapabilities,
        [candidate(providerA, selectedCapabilities), unavailable!, undeclared!],
        {
          detail: "operation",
          operation: "search_bytes",
          deepOperations: ["search_bytes", "xrefs", "procedure_info"],
        },
      ),
    );
    expect(
      view.operation_candidates.map(({ provider, declaration }) => [
        provider.id,
        declaration.status,
      ]),
    ).toEqual([
      ["provider-a", "not_declared"],
      ["provider-b", "unavailable"],
      ["provider-c", "not_declared"],
    ]);
  });
});

describe("binary session composed operation projection", () => {
  it("reports mode-dependent declarations and the default mode separately", async () => {
    const view = operationStatusSchema.parse(
      await projectStatus(
        selectedCapabilities,
        [
          candidate(providerA, [
            descriptor(providerA, "procedure_address", []),
            descriptor(providerA, "procedure_callers", []),
          ]),
        ],
        {
          detail: "operation",
          operation: "get_call_graph",
          deepOperations: [
            "procedure_address",
            "procedure_callers",
            "procedure_callees",
          ],
        },
      ),
    );
    expect(view.operation_requirements).toEqual({
      kind: "modes",
      default_mode: "forward",
      modes: [
        {
          name: "forward",
          requirements: ["procedure_address", "procedure_callees"],
        },
        {
          name: "backward",
          requirements: ["procedure_address", "procedure_callers"],
        },
      ],
    });
    expect(view.operation_candidates[0]?.declaration).toEqual({
      status: "available",
      missing_operations: ["procedure_callees"],
      operations: [
        { operation: "procedure_address", status: "available" },
        { operation: "procedure_callees", status: "not_declared" },
        { operation: "procedure_callers", status: "available" },
      ],
      default_mode_available: false,
      modes: [
        {
          name: "forward",
          status: "unavailable",
          missing_operations: ["procedure_callees"],
        },
        { name: "backward", status: "available", missing_operations: [] },
      ],
    });
  });

  it("reports a partially declared composed tool with its missing operations", async () => {
    const view = operationStatusSchema.parse(
      await projectStatus(
        selectedCapabilities,
        [candidate(providerA, [descriptor(providerA, "analyze_function", [])])],
        {
          detail: "operation",
          operation: "trace_native_values",
          deepOperations: ["analyze_function", "resolve_native_call_targets"],
        },
      ),
    );
    expect(view.operation_candidates[0]?.declaration).toEqual({
      status: "unavailable",
      missing_operations: ["resolve_native_call_targets"],
      operations: [
        { operation: "analyze_function", status: "available" },
        { operation: "resolve_native_call_targets", status: "not_declared" },
      ],
    });
  });

  it.each([
    ["operation view without operation", { detail: "operation" as const }],
    [
      "operation with another view",
      { detail: "summary" as const, operation: "search_bytes" },
    ],
    [
      "unknown tool",
      { detail: "operation" as const, operation: "no_such_tool" },
    ],
    [
      "tool served outside deep providers",
      { detail: "operation" as const, operation: "inspect_macho" },
    ],
  ])("rejects %s before candidate discovery", async (_name, view) => {
    let discovered = false;
    const route: SessionProviderRoute = {
      identity: providerA,
      profile: null,
      selection: undefined,
      createClient: () => {
        throw new Error("Projection does not create clients");
      },
      capabilities: new Map(),
      binding: null,
    };
    await expect(
      binarySessionStatus({
        investigation: {
          evidence_records: 0,
          unknown_revisions: 0,
          unknown_heads: 0,
          retained_representation_bytes: 0,
          maximum_representation_bytes: 0,
          persistence: "memory",
        },
        target: undefined,
        route,
        router: {
          candidateStatuses: async () => {
            discovered = true;
            return searchCandidates();
          },
          deepOperations: () => new Set(["search_bytes", "xrefs"]),
        },
        runtimeUnavailability: new Map(),
        runId: undefined,
        runtimeLineageSnapshots: [],
        requestActivitySnapshots: [],
        ...view,
      }),
    ).rejects.toBeInstanceOf(AnalysisInputError);
    expect(discovered).toBe(false);
  });
});

describe("binary session direct composed operation projection", () => {
  it("uses the modes that decide a direct composed tool's availability", async () => {
    const capabilities = [
      descriptor(providerA, "current_address", []),
      descriptor(providerA, "resolve_containing_procedure", []),
    ];
    const view = operationStatusSchema.parse(
      await projectStatus(capabilities, [candidate(providerA, capabilities)], {
        detail: "operation",
        operation: "get_navigation_context",
        deepOperations: [
          "current_document",
          "current_address",
          "resolve_containing_procedure",
        ],
      }),
    );
    expect(view.operation_requirements).toEqual({
      kind: "modes",
      default_mode: "current_selection",
      modes: [
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
      ],
    });
    expect(view.operation_candidates[0]?.declaration).toMatchObject({
      status: "available",
      missing_operations: ["current_document"],
      default_mode_available: false,
      modes: [
        {
          name: "current_selection",
          status: "unavailable",
          missing_operations: ["current_document"],
        },
        { name: "explicit_document", status: "available" },
      ],
    });
    // The same composition decides the tool's reported availability.
    const availability = buildCapabilityInventory(
      await projectStatus(capabilities, []),
      { processCaptureEnabled: false },
    ).find(({ name }) => name === "get_navigation_context");
    expect(availability?.modes?.map(({ name }) => name)).toEqual([
      "current_selection",
      "explicit_document",
    ]);
    expect(availability?.default_mode_available).toBe(false);
  });
});

describe("binary session operation projection in a resource-only session", () => {
  const resourceRoot: ResolvedAppBundleResourceRoot = {
    callerPath: "/fixture/Probe.app",
    canonicalPath: "/fixture/Probe.app",
    infoPlistPath: "/fixture/Probe.app/Contents/Info.plist",
    layout: "contents",
    executableSha256: null,
  };

  it("reports target-free candidates instead of an empty list", async () => {
    const candidates = searchCandidates();
    const view = operationStatusSchema.parse(
      await projectStatus([], candidates, {
        detail: "operation",
        operation: "search_bytes",
        bundleResourceRoot: resourceRoot,
      }),
    );
    expect(
      view.operation_candidates.map(({ provider }) => provider.id),
    ).toEqual(["provider-a", "provider-b", "provider-c"]);
    expect(view.operation_candidates[0]).toMatchObject({
      target_support: { status: "unknown" },
      declaration: { status: "available" },
    });
  });

  it("keeps summary and complete candidates unchanged in a resource-only session", async () => {
    for (const detail of ["summary", "complete"] as const) {
      const status = await projectStatus([], searchCandidates(), {
        detail,
        bundleResourceRoot: resourceRoot,
      });
      expect(status).toMatchObject({ analysis_provider_candidates: [] });
    }
  });
});

describe("binary session operation declarations under provider readiness", () => {
  const unready = (
    provider: ProviderIdentity,
    capabilities: readonly CapabilityDescriptor[],
  ): AnalysisProviderCandidateStatus => ({
    ...candidate(provider, capabilities),
    availability: {
      status: "unavailable",
      code: "not_configured",
      reason: "Set the provider configuration.",
      remediation: "Configure the provider.",
      diagnostics: {},
    },
    selected: false,
  });
  const declarationsOf = async (
    candidates: readonly AnalysisProviderCandidateStatus[],
  ) =>
    operationStatusSchema
      .parse(
        await projectStatus([], candidates, {
          detail: "operation",
          operation: "search_strings",
          deepOperations: ["search_strings"],
        }),
      )
      .operation_candidates.map(({ provider, availability, declaration }) => [
        provider.id,
        availability.code,
        declaration.operations,
      ]);

  it("does not report an unconfigured provider's declared operation as missing", async () => {
    // The capability repeats the provider's own readiness code, as IDA and
    // Kuna report while unconfigured.
    const gated = descriptor(providerA, "search_strings", [], {
      available: false,
      reason: "Set the provider configuration.",
      availabilityCode: "not_configured",
    });
    expect(await declarationsOf([unready(providerA, [gated])])).toEqual([
      [
        "provider-a",
        "not_configured",
        [{ operation: "search_strings", status: "available" }],
      ],
    ]);
  });

  it.each([
    ["an operation-specific limitation", undefined, false],
    ["a different rejection than the provider's", "runtime_unavailable", false],
    ["the same code while the provider is ready", "not_configured", true],
  ] as const)(
    "keeps %s as an unavailable declaration",
    async (_name, availabilityCode, providerReady) => {
      const limited = descriptor(providerB, "search_strings", [], {
        available: false,
        reason: "Search is limited for Provider B.",
        ...(availabilityCode === undefined ? {} : { availabilityCode }),
      });
      const status = providerReady
        ? candidate(providerB, [limited])
        : unready(providerB, [limited]);
      expect(await declarationsOf([status])).toEqual([
        [
          "provider-b",
          providerReady ? null : "not_configured",
          [
            {
              operation: "search_strings",
              status: "unavailable",
              reason: "Search is limited for Provider B.",
              availability_code: availabilityCode ?? null,
            },
          ],
        ],
      ]);
    },
  );
});
