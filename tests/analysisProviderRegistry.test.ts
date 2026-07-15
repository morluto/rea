import { describe, expect, it } from "vitest";

import {
  AnalysisProviderRegistry,
  type AnalysisProviderBinding,
} from "../src/application/AnalysisProviderRegistry.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderAvailability,
  type ProviderIdentity,
  type ProviderTargetSupport,
} from "../src/application/AnalysisProvider.js";
import { createAnalysisProfile } from "../src/domain/analysisProfile.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import {
  ProviderAdapterError,
  ProviderSelectionError,
  projectAnalysisError,
} from "../src/domain/errors.js";
import { err, ok } from "../src/domain/result.js";

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

describe("analysis provider registry", () => {
  it("admits overlapping operations, sorts discovery, and rejects duplicate IDs", () => {
    const alpha = candidate("alpha");
    const beta = candidate("beta");
    const registry = new AnalysisProviderRegistry([
      beta.provider,
      alpha.provider,
    ]);

    expect(registry.identities().map(({ id }) => id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(
      registry.candidates().map(({ provider, targetSupport }) => ({
        id: provider.id,
        support: targetSupport.status,
      })),
    ).toEqual([
      { id: "alpha", support: "unknown" },
      { id: "beta", support: "unknown" },
    ]);
    expect(alpha.created).toEqual([]);
    expect(beta.created).toEqual([]);
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
              capability({
                ...alpha.provider.identity(),
                name: "mismatched provider",
              }),
            ],
          },
        ]),
    ).toThrow(/published mismatched capability provenance/u);
    expect(
      () => new AnalysisProviderRegistry([candidate("auto").provider]),
    ).toThrow(/Invalid analysis provider ID: auto/u);
  });

  it("selects the sole usable candidate without creating a client", async () => {
    const alpha = candidate("alpha");
    const beta = candidate("beta", { available: false });
    const registry = new AnalysisProviderRegistry([
      beta.provider,
      alpha.provider,
    ]);

    const selected = await registry.select(DATABASE_TARGET);
    expect(selected.ok).toBe(true);
    if (!selected.ok || selected.value.binding === null) return;
    expect(bindingProjection(selected.value.binding)).toEqual({
      id: "alpha",
      source: "auto-single-candidate",
      version: "1",
    });
    expect(selected.value.candidates).toMatchObject([
      { provider: { id: "alpha", version: "1" }, selected: true },
      {
        provider: { id: "beta" },
        selected: false,
        availability: { status: "unavailable", code: "runtime_missing" },
      },
    ]);
    expect(alpha.created).toEqual([]);
    expect(beta.created).toEqual([]);
  });

  it("makes auto ambiguity explicit and honors request over environment", async () => {
    const alpha = candidate("alpha");
    const beta = candidate("beta");
    const registry = new AnalysisProviderRegistry(
      [alpha.provider, beta.provider],
      "beta",
    );

    const environment = await registry.select(DATABASE_TARGET);
    expect(environment.ok).toBe(true);
    if (environment.ok)
      expect(environment.value.binding?.selectionSource).toBe("environment");
    expect(environment.ok && environment.value.binding?.identity.id).toBe(
      "beta",
    );

    const request = await registry.select(DATABASE_TARGET, "alpha");
    expect(request.ok && request.value.binding?.identity.id).toBe("alpha");
    if (request.ok)
      expect(request.value.binding?.selectionSource).toBe("request");

    const automatic = await registry.select(DATABASE_TARGET, "auto");
    expect(automatic.ok).toBe(false);
    if (automatic.ok) return;
    expect(automatic.error).toMatchObject({
      reason: "ambiguous",
      requestedProviderId: "auto",
      candidateIds: ["alpha", "beta"],
    });
    expect(projectAnalysisError(automatic.error)).toMatchObject({
      code: "capability_unavailable",
      details: {
        selection_reason: "ambiguous",
        candidate_ids: ["alpha", "beta"],
      },
    });
    expect(alpha.created).toEqual([]);
    expect(beta.created).toEqual([]);
  });

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
    expect(unsupported.ok).toBe(false);
    if (
      !unsupported.ok &&
      unsupported.error instanceof ProviderSelectionError
    ) {
      expect(unsupported.error).toMatchObject({ reason: "target_unsupported" });
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
    expect(explicit.ok).toBe(false);
    if (!explicit.ok && explicit.error instanceof ProviderSelectionError)
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
    expect(explicit.ok).toBe(false);
    if (!explicit.ok && explicit.error instanceof ProviderSelectionError)
      expect(explicit.error.rejections).toMatchObject([
        {
          providerId: "failed",
          code: "version_unresolved",
          diagnostics: { error_tag: "ProviderAdapterError" },
        },
      ]);
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
                  1,
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
  inputContractVersion: 1,
  outputContractVersion: 1,
  available: true,
  reason: null,
  pagination: "none",
  exhaustive: true,
  effects: {
    mutatesArtifact: false,
    launchesProcess: true,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limits: { maxResults: null, maxPayloadBytes: 1_000, timeoutMs: 1_000 },
  limitations: [],
});

const bindingProjection = (binding: AnalysisProviderBinding) => ({
  id: binding.identity.id,
  source: binding.selectionSource,
  version: binding.identity.version,
});
