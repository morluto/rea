import { describe, expect, it } from "vitest";

import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import {
  expandProviderCapabilities,
  type ProviderCapabilitySet,
} from "../../contracts/toolOutputSchemaPrimitives.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import type { AnalysisProviderCandidateStatus } from "./AnalysisProviderRegistry.js";
import type {
  SessionProviderRoute,
  SessionProviderRouter,
} from "./SessionProviderRouter.js";
import { binarySessionStatus } from "./BinarySessionStatus.js";

type ProjectedStatus = {
  capabilities: ProviderCapabilitySet[];
  analysis_provider_candidates: {
    provider: ProviderIdentity;
    availability: unknown;
    target_support: unknown;
    selected: boolean;
    capabilities: ProviderCapabilitySet[];
  }[];
};

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
      readonly availabilityCode?: "architecture_unsupported";
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

const project = (
  routeCapabilities: readonly CapabilityDescriptor[],
  candidates: readonly AnalysisProviderCandidateStatus[],
  runtimeUnavailability: ReadonlyMap<
    string,
    { readonly reason: string }
  > = new Map(),
): ProjectedStatus => {
  const route = {
    capabilities: new Map(
      routeCapabilities.map((capability) => [capability.operation, capability]),
    ),
    binding: null,
  } as unknown as SessionProviderRoute;
  const router = {
    candidateStatuses: () => candidates,
  } as unknown as SessionProviderRouter;
  return binarySessionStatus({
    target: undefined,
    route,
    router,
    runtimeUnavailability,
    runId: undefined,
    runtimeLineageSnapshots: [],
    requestActivitySnapshots: [],
  }) as unknown as ProjectedStatus;
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
  it("preserves provider scope and route overlays while factoring exact prefixes", () => {
    const selectedBefore = structuredClone(selectedCapabilities);
    const otherBefore = structuredClone(otherCapabilities);
    const status = project(
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

  it("keeps empty route and candidate capability collections empty", () => {
    const status = project([], [candidate(providerA, [])]);
    expect(status.capabilities).toEqual([]);
    expect(status.analysis_provider_candidates[0]?.capabilities).toEqual([]);
  });

  it("preserves repeated limitations in their original order", () => {
    const capabilities = [
      descriptor(providerA, "procedure_info", [
        "Repeated",
        "Repeated",
        "left detail",
      ]),
      descriptor(providerA, "xrefs", ["Repeated", "Repeated", "right detail"]),
    ];
    const status = project(capabilities, []);

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
