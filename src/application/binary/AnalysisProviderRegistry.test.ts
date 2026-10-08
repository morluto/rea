import { describe, expect, it } from "vitest";

import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderAvailability,
  type ProviderIdentity,
  type ProviderTargetSupport,
} from "../AnalysisProvider.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import type { BinaryTarget } from "../../domain/binaryTarget.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderSelectionError } from "../../domain/providerSelectionError.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { err, ok } from "../../domain/result.js";

const DATABASE_TARGET: BinaryTarget = {
  path: "/tmp/fixture.hop",
  sha256: "a".repeat(64),
  kind: "database",
  format: "analysis-database",
};
const ARTIFACT_TARGET: BinaryTarget = {
  path: "/tmp/app.asar",
  sha256: "b".repeat(64),
  kind: "archive",
  format: "asar",
};

it("rejects malformed provider capability declarations", () => {
  const alpha = candidate("alpha");
  expect(
    () => new AnalysisProviderRegistry([alpha.provider, alpha.provider]),
  ).toThrow(/Duplicate analysis provider ID: alpha/u);
  expect(
    () =>
      new AnalysisProviderRegistry([
        {
          ...alpha.provider,
          capabilities: () => {
            const descriptor = capability(alpha.provider.identity());
            return [descriptor, descriptor];
          },
        },
      ]),
  ).toThrow(/declares operation address_name more than once/u);
  expect(
    () =>
      new AnalysisProviderRegistry([
        {
          ...alpha.provider,
          capabilities: () => [
            capability({ ...alpha.provider.identity(), name: "forged" }),
          ],
        },
      ]),
  ).toThrow(/published mismatched capability provenance/u);
  expect(
    () => new AnalysisProviderRegistry([candidate("auto").provider]),
  ).toThrow(/Invalid analysis provider ID: auto/u);
});

it("selects the sole available provider and honors explicit selection precedence", async () => {
  const alpha = candidate("alpha");
  const beta = candidate("beta", { available: false });
  const sole = await new AnalysisProviderRegistry([
    beta.provider,
    alpha.provider,
  ]).select(DATABASE_TARGET);
  expect(sole).toMatchObject({
    ok: true,
    value: {
      binding: {
        identity: { id: "alpha" },
        selectionSource: "auto-single-candidate",
      },
    },
  });

  const selected = new AnalysisProviderRegistry(
    [alpha.provider, candidate("beta").provider],
    "beta",
  );
  expect(await selected.select(DATABASE_TARGET)).toMatchObject({
    ok: true,
    value: {
      binding: {
        identity: { id: "beta" },
        selectionSource: "environment",
      },
    },
  });
  expect(await selected.select(DATABASE_TARGET, "alpha")).toMatchObject({
    ok: true,
    value: {
      binding: {
        identity: { id: "alpha" },
        selectionSource: "request",
      },
    },
  });
});

describe("analysis provider registry: binding failures and cancellation", () => {
  it("returns actionable unknown, unavailable, and unsupported failures", async () => {
    const unavailable = candidate("alpha", { available: false });
    const registry = new AnalysisProviderRegistry([unavailable.provider]);

    const unknown = await registry.select(DATABASE_TARGET, "missing");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(projectAnalysisError(unknown.error)).toMatchObject({
        details: {
          selection_reason: "unknown_provider",
          requested_provider_id: "missing",
          candidate_ids: ["alpha"],
        },
      });

    const rejected = await registry.select(DATABASE_TARGET, "alpha");
    expect(rejected.ok).toBe(false);
    if (!rejected.ok)
      expect(projectAnalysisError(rejected.error)).toMatchObject({
        code: "provider_unavailable",
        details: {
          rejections: [
            {
              provider_id: "alpha",
              code: "runtime_missing",
              diagnostics: { executable_path: "/opt/alpha/bin/analyze" },
            },
          ],
        },
      });

    const unsupported = await new AnalysisProviderRegistry([
      candidate("alpha", { available: false }).provider,
    ]).select(ARTIFACT_TARGET, "alpha");
    if (unsupported.ok)
      throw new Error("expected unsupported target rejection");
    expect(unsupported.error).toBeInstanceOf(ProviderSelectionError);
    if (
      !unsupported.ok &&
      unsupported.error instanceof ProviderSelectionError
    ) {
      expect(unsupported.error).toMatchObject({
        reason: "target_unsupported",
      });
      expect(unsupported.error.rejections.map(({ code }) => code)).toEqual([
        "runtime_missing",
        "target_kind_unsupported",
      ]);
    }
  });

  it("keeps artifact-only targets unbound under auto or environment preference", async () => {
    const alpha = candidate("alpha");
    const environment = new AnalysisProviderRegistry([alpha.provider], "alpha");
    const automatic = new AnalysisProviderRegistry([alpha.provider]);

    for (const registry of [environment, automatic]) {
      const selected = await registry.select(ARTIFACT_TARGET);
      expect(selected).toMatchObject({
        ok: true,
        value: {
          binding: null,
          candidates: [
            {
              selected: false,
              targetSupport: {
                status: "unsupported",
                code: "target_kind_unsupported",
              },
            },
          ],
        },
      });
    }
    const explicit = await automatic.select(ARTIFACT_TARGET, "alpha");
    if (explicit.ok) throw new Error("expected provider selection rejection");
    expect(explicit.error).toBeInstanceOf(ProviderSelectionError);
    if (explicit.error instanceof ProviderSelectionError)
      expect(explicit.error.reason).toBe("target_unsupported");
  });

  it("does not bind a profile with unresolved version or adapter failure", async () => {
    const unresolved = candidate("unresolved", { profile: "missing" });
    const failed = candidate("failed", { profile: "error" });

    const automatic = await new AnalysisProviderRegistry([
      unresolved.provider,
    ]).select(DATABASE_TARGET);
    expect(automatic).toMatchObject({
      ok: true,
      value: {
        binding: null,
        candidates: [
          {
            availability: {
              status: "unavailable",
              code: "version_unresolved",
            },
          },
        ],
      },
    });

    const explicit = await new AnalysisProviderRegistry([
      failed.provider,
    ]).select(DATABASE_TARGET, "failed");
    if (explicit.ok) throw new Error("expected provider selection rejection");
    expect(explicit.error).toMatchObject({
      _tag: "ProviderAdapterError",
      providerId: "failed",
    });
  });

  it("cancels a pending profile probe even when the adapter ignores its signal", async () => {
    const alpha = candidate("alpha");
    let observedSignal: AbortSignal | undefined;
    const ignoresCancellation: AnalysisProviderCandidate = {
      ...alpha.provider,
      resolveAnalysisProfile: (_target, options) => {
        observedSignal = options?.signal;
        return new Promise<never>(() => undefined);
      },
    };
    const controller = new AbortController();
    const selecting = new AnalysisProviderRegistry([
      ignoresCancellation,
    ]).select(DATABASE_TARGET, "alpha", { signal: controller.signal });
    expect(observedSignal).toBe(controller.signal);

    controller.abort();

    await expect(selecting).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError", operation: "open_binary" },
    });
    expect(alpha.created).toEqual([]);
  });
});

interface CandidateFixture {
  readonly provider: AnalysisProviderCandidate;
  readonly created: string[];
}

const candidate = (
  id: string,
  options: {
    readonly available?: boolean;
    readonly profile?: "resolved" | "missing" | "error";
  } = {},
): CandidateFixture => {
  const identity: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: null,
  };
  const created: string[] = [];
  const available = options.available ?? true;
  const provider: AnalysisProviderCandidate = {
    identity: () => identity,
    capabilities: () => [capability(identity)],
    inspectAvailability: (): ProviderAvailability =>
      available
        ? {
            status: "available",
            code: null,
            reason: null,
            diagnostics: { executable_path: `/opt/${id}/bin/analyze` },
          }
        : {
            status: "unavailable",
            code: "runtime_missing",
            reason: `${id} runtime is unavailable`,
            diagnostics: { executable_path: `/opt/${id}/bin/analyze` },
          },
    inspectTargetSupport: (target): ProviderTargetSupport =>
      target.kind === "database"
        ? {
            status: "supported",
            code: null,
            reason: null,
            diagnostics: { target_kind: target.kind },
          }
        : {
            status: "unsupported",
            code: "target_kind_unsupported",
            reason: `${id} only accepts analysis databases in this fixture`,
            diagnostics: { target_kind: target.kind },
          },
    resolveAnalysisProfile: () => {
      if (options.profile === "error")
        return Promise.resolve(
          err(new ProviderAdapterError(id, "resolve_analysis_profile")),
        );
      return Promise.resolve(
        ok({
          profile:
            options.profile === "missing"
              ? null
              : createAnalysisProfile(
                  { id, name: identity.name, version: "1" },
                  { fixture: id },
                ),
          compatibility: {},
        }),
      );
    },
    createClient: (_target, profile): AnalysisClient => {
      created.push(id);
      const executionIdentity = profile?.provider ?? identity;
      return {
        execute: (operation) =>
          Promise.resolve(
            ok(
              createAnalysisExecution(
                operation === "health" ? null : `${id}:${operation}`,
                executionIdentity,
              ),
            ),
          ),
        close: () => Promise.resolve(),
      };
    },
  };
  return { provider, created };
};

const capability = (provider: ProviderIdentity): CapabilityDescriptor => ({
  provider,
  operation: "address_name",
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: true,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});
