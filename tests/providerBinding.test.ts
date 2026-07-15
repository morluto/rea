import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisProvider,
  type AnalysisProviderCandidate,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../src/application/AnalysisProvider.js";
import { AnalysisProviderRegistry } from "../src/application/AnalysisProviderRegistry.js";
import { BinarySession } from "../src/application/BinarySession.js";
import { SessionProviderRouter } from "../src/application/SessionProviderRouter.js";
import { createAnalysisProfile } from "../src/domain/analysisProfile.js";
import {
  AnalysisCancelledError,
  ProviderAdapterError,
} from "../src/domain/errors.js";
import { err, ok } from "../src/domain/result.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("target-bound provider routing", () => {
  it("rejects provider identity and operation-family collisions at composition", () => {
    const alpha = deepProvider("alpha");
    const registry = new AnalysisProviderRegistry([alpha.provider]);
    expect(() =>
      SessionProviderRouter.selectable(registry, [auxiliaryProvider("alpha")]),
    ).toThrow(/Duplicate configured provider ID: alpha/u);
    expect(() =>
      SessionProviderRouter.selectable(registry, [
        auxiliaryProvider("auxiliary", "address_name"),
      ]),
    ).toThrow(
      /Deep and auxiliary providers both declare operation address_name/u,
    );
  });

  it("binds one overlapping provider, preserves provenance, and never falls back", async () => {
    const target = await databaseTarget();
    const alpha = deepProvider("alpha");
    const beta = deepProvider("beta");
    const auxiliary = auxiliaryProvider();
    const session = selectableSession(
      [beta.provider, alpha.provider],
      auxiliary,
    );

    const ambiguous = await session.open(target);
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok)
      expect(ambiguous.error).toMatchObject({ reason: "ambiguous" });
    expect(alpha.clients).toHaveLength(0);
    expect(beta.clients).toHaveLength(0);
    expect(session.activeTarget()).toBeUndefined();

    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    expect(bindingStatus(session)).toMatchObject({
      analysis_provider_binding: {
        provider: { id: "alpha", version: "1" },
        selection_source: "request",
      },
      analysis_provider_candidates: [
        { provider: { id: "alpha" }, selected: true },
        { provider: { id: "beta" }, selected: false },
      ],
    });
    expect(alpha.clients).toHaveLength(0);

    const observed = await session.execute("address_name", { address: "0x1" });
    expect(observed.ok).toBe(true);
    if (observed.ok)
      expect(observed.value).toMatchObject({
        provider: { id: "alpha", version: "1" },
        analysisProfile: { provider: { id: "alpha", version: "1" } },
        result: "alpha:address_name",
      });
    expect(alpha.clients).toHaveLength(1);
    expect(beta.clients).toHaveLength(0);

    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    expect(alpha.clients).toHaveLength(1);
    expect(alpha.clients[0]?.closed).toBe(false);

    const auxiliaryResult = await session.execute("inspect_macho", {});
    expect(auxiliaryResult.ok && auxiliaryResult.value.provider.id).toBe(
      "auxiliary",
    );

    alpha.available = false;
    expect((await session.open(target)).ok).toBe(true);
    expect(bindingStatus(session)).toMatchObject({
      analysis_provider_binding: { provider: { id: "alpha" } },
    });

    const unknown = await session.open(target, { providerId: "missing" });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(unknown.error).toMatchObject({ reason: "unknown_provider" });
    expect(bindingStatus(session)).toMatchObject({
      analysis_provider_binding: { provider: { id: "alpha" } },
    });

    expect((await session.open(target, { providerId: "beta" })).ok).toBe(true);
    expect(alpha.clients[0]?.closed).toBe(true);
    beta.fail = true;
    const failed = await session.execute("address_name", { address: "0x2" });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error._tag).toBe("ProviderAdapterError");
    expect(alpha.clients[0]?.calls).toEqual(["address_name"]);
    expect(bindingStatus(session)).toMatchObject({
      analysis_provider_binding: { provider: { id: "beta" } },
    });

    await session.close();
    expect(beta.clients[0]?.closed).toBe(true);
  });

  it("cancels a provider switch, closes its old client, and restores the binding", async () => {
    const target = await databaseTarget();
    const alpha = deepProvider("alpha");
    const beta = deepProvider("beta");
    const pending = deferred<ReturnType<typeof successfulExecution>>();
    alpha.pending = pending.promise;
    const session = selectableSession([alpha.provider, beta.provider]);
    expect((await session.open(target, { providerId: "alpha" })).ok).toBe(true);
    const running = session.execute("address_name", { address: "0x1" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const controller = new AbortController();
    const switching = session.open(target, {
      providerId: "beta",
      signal: controller.signal,
    });
    while (beta.profileResolutions === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    pending.resolve(successfulExecution("alpha"));

    expect(await running).toMatchObject({ ok: true });
    const cancelled = await switching;
    expect(cancelled).toEqual({
      ok: false,
      error: new AnalysisCancelledError("open_binary"),
    });
    expect(alpha.clients[0]?.closed).toBe(true);
    expect(beta.clients).toHaveLength(0);
    expect(bindingStatus(session)).toMatchObject({
      analysis_provider_binding: { provider: { id: "alpha" } },
    });

    alpha.pending = undefined;
    const restored = await session.execute("address_name", { address: "0x2" });
    expect(restored.ok && restored.value.provider.id).toBe("alpha");
    expect(alpha.clients).toHaveLength(2);
    await session.close();
    expect(alpha.clients[1]?.closed).toBe(true);
  });
});

interface ClientState {
  readonly calls: string[];
  closed: boolean;
}

interface DeepProviderFixture {
  provider: AnalysisProviderCandidate;
  readonly clients: ClientState[];
  available: boolean;
  fail: boolean;
  profileResolutions: number;
  pending: Promise<ReturnType<typeof successfulExecution>> | undefined;
}

const deepProvider = (id: string): DeepProviderFixture => {
  const identity: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: null,
  };
  const fixture: Omit<DeepProviderFixture, "provider"> = {
    clients: [],
    available: true,
    fail: false,
    profileResolutions: 0,
    pending: undefined,
  };
  const provider: AnalysisProviderCandidate = {
    identity: () => identity,
    capabilities: () => [capability(identity, "address_name")],
    inspectAvailability: () =>
      fixture.available
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
    inspectTargetSupport: () => ({
      status: "supported",
      code: null,
      reason: null,
      diagnostics: {},
    }),
    resolveAnalysisProfile: () => {
      fixture.profileResolutions += 1;
      return Promise.resolve(
        ok({
          profile: createAnalysisProfile(
            { id, name: identity.name, version: "1" },
            1,
            { provider: id },
          ),
          compatibility: {},
        }),
      );
    },
    createClient: (_target, profile): AnalysisClient => {
      const state: ClientState = { calls: [], closed: false };
      fixture.clients.push(state);
      return {
        execute: (operation) => {
          state.calls.push(operation);
          if (fixture.fail)
            return Promise.resolve(
              err(new ProviderAdapterError(id, operation)),
            );
          if (fixture.pending !== undefined) return fixture.pending;
          return Promise.resolve(successfulExecution(id, profile?.provider));
        },
        close: () => {
          state.closed = true;
          return Promise.resolve();
        },
      };
    },
  };
  return Object.assign(fixture, { provider });
};

const successfulExecution = (
  id: string,
  provider: ProviderIdentity = {
    id,
    name: `${id} provider`,
    version: "1",
  },
) => ok(createAnalysisExecution(`${id}:address_name`, provider));

const auxiliaryProvider = (
  id = "auxiliary",
  operation: "address_name" | "inspect_macho" = "inspect_macho",
): AnalysisProvider => {
  const identity = {
    id,
    name: `${id} provider`,
    version: "1",
  };
  return {
    identity: () => identity,
    capabilities: () => [capability(identity, operation)],
    createClient: () => ({
      execute: (operation) =>
        Promise.resolve(
          ok(createAnalysisExecution(`${operation}:auxiliary`, identity)),
        ),
      close: () => Promise.resolve(),
    }),
  };
};

const selectableSession = (
  providers: readonly AnalysisProviderCandidate[],
  auxiliary?: AnalysisProvider,
): BinarySession =>
  new BinarySession(
    SessionProviderRouter.selectable(
      new AnalysisProviderRegistry(providers),
      auxiliary === undefined ? [] : [auxiliary],
    ),
  );

const capability = (
  provider: ProviderIdentity,
  operation: "address_name" | "inspect_macho",
): CapabilityDescriptor => ({
  provider,
  operation,
  inputContractVersion: 1,
  outputContractVersion: 1,
  available: true,
  reason: null,
  pagination: "none",
  exhaustive: true,
  effects: {
    mutatesArtifact: false,
    launchesProcess: operation === "address_name",
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limits: { maxResults: null, maxPayloadBytes: 1_000, timeoutMs: 1_000 },
  limitations: [],
});

const databaseTarget = async (): Promise<string> => {
  directory = await mkdtemp(join(tmpdir(), "rea-provider-binding-"));
  const path = join(directory, "fixture.hop");
  await writeFile(path, "fixture");
  return path;
};

const bindingStatus = (session: BinarySession) =>
  z
    .object({
      analysis_provider_binding: z.unknown(),
      analysis_provider_candidates: z.array(z.unknown()),
    })
    .passthrough()
    .parse(session.status());

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

const deferred = <Value>(): Deferred<Value> => {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
};
