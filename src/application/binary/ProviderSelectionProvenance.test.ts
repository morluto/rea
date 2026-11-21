import { expect, it } from "vitest";

import type { AnalysisProviderCandidateStatus } from "./AnalysisProviderRegistry.js";
import { selectionProvenanceForRoute } from "./ProviderSelectionProvenance.js";
import type { SessionProviderRoute } from "./SessionProviderRouter.js";

const candidate = (
  id: string,
  overrides: Partial<AnalysisProviderCandidateStatus> = {},
): AnalysisProviderCandidateStatus => ({
  provider: { id, name: `${id} provider`, version: "1.0" },
  availability: {
    status: "available",
    code: null,
    reason: null,
    diagnostics: {},
  },
  targetSupport: {
    status: "supported",
    code: null,
    reason: null,
    diagnostics: {},
  },
  selected: false,
  selectionSource: null,
  rejections: [],
  capabilities: [],
  ...overrides,
});

const ROUTE = (candidates: readonly AnalysisProviderCandidateStatus[]) =>
  ({
    identity: { id: "ghidra", name: "Ghidra", version: "11.2" },
    capabilities: new Map(),
    profile: null,
    binding: null,
    selection: { candidates },
  }) as unknown as SessionProviderRoute;

it("projects only the stable selection facts onto Evidence provenance", () => {
  const provenance = selectionProvenanceForRoute({
    ...ROUTE([
      candidate("ghidra", { selected: true, selectionSource: "environment" }),
      candidate("ida", {
        availability: {
          status: "unavailable",
          code: "executable_missing",
          reason: "IDA is not installed.",
          remediation: "Install IDA.",
          diagnostics: { searched: ["/Applications/IDA"] },
        },
        targetSupport: {
          status: "unknown",
          code: null,
          reason: "Readiness failed first.",
          diagnostics: {},
        },
        rejections: [
          {
            providerId: "ida",
            origin: "availability",
            code: "executable_missing",
            reason: "IDA is not installed.",
            remediation: "Install IDA.",
            diagnostics: { searched: ["/Applications/IDA"] },
          },
        ],
      }),
    ]),
    binding: {
      identity: { id: "ghidra", name: "Ghidra", version: "11.2" },
      selectionSource: "environment",
    } as unknown as NonNullable<SessionProviderRoute["binding"]>,
  });

  expect(provenance).toEqual({
    selection_source: "environment",
    candidates: [
      {
        provider: { id: "ghidra", name: "ghidra provider", version: "1.0" },
        selected: true,
        availability: "available",
        target_support: "supported",
        rejection_codes: [],
      },
      {
        provider: { id: "ida", name: "ida provider", version: "1.0" },
        selected: false,
        availability: "unavailable",
        target_support: "unknown",
        rejection_codes: ["executable_missing"],
      },
    ],
  });
  // Sealed session content is not copied: no reason, diagnostics or capabilities.
  expect(JSON.stringify(provenance)).not.toContain("/Applications/IDA");
});

it("reports no provenance for a session that bound no provider", () => {
  expect(selectionProvenanceForRoute(ROUTE([]))).toBeUndefined();
});
