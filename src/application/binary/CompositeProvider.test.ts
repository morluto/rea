import { expect, it, vi } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisOperation,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ProviderIdentity,
} from "../../ports/AnalysisProvider.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { AnalysisCleanupRelease } from "../../domain/analysisCleanupRelease.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { err, ok } from "../../domain/result.js";
import { CompositeProvider } from "./CompositeProvider.js";
import { closeAnalysisClient } from "../../providers/AnalysisClientCleanup.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";

const identity = (id: string): ProviderIdentity => ({
  id,
  name: id,
  version: "1",
});

const operationCapability = (
  provider: ProviderIdentity,
  operation: Exclude<AnalysisOperation, "health">,
): CapabilityDescriptor => ({
  provider,
  operation,
  available: true,
  reason: null,
  effects: {
    mutatesArtifact: false,
    launchesProcess: false,
    mayShowUi: false,
    mayAccessNetwork: false,
    mayWriteFilesystem: false,
    changesPermissions: false,
    requiresRoot: false,
  },
  limitations: [],
});

const failingProvider = (
  id: string,
  operation: Exclude<AnalysisOperation, "health">,
  resource: string,
) => {
  const providerIdentity = identity(id);
  const cleanupError = new ProviderCleanupError(
    id,
    [resource],
    {
      reason: `${id} cleanup is unresolved`,
      child_marker: `${id}-detail`,
    },
    { remediationAction: `Resolve ${resource} before retrying ${id}.` },
  );
  const close = vi.fn<AnalysisClient["close"]>(async () => err(cleanupError));
  const provider: AnalysisProvider = {
    identity: () => providerIdentity,
    capabilities: () => [operationCapability(providerIdentity, operation)],
    createClient: (): AnalysisClient => ({
      execute: (name) =>
        Promise.resolve(
          ok(createAnalysisExecution(`${id}:${name}`, providerIdentity)),
        ),
      close,
    }),
  };
  return { provider, close, cleanupError };
};

const executableTarget = {
  path: "/tmp/fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
} as const;

it("does not create a previously unused child after the composite closes", async () => {
  const child = failingProvider("provider-only", "address_name", "one-db");
  const create = vi.spyOn(child.provider, "createClient");
  const client = new CompositeProvider([child.provider]).createClient(
    executableTarget,
  );
  expect(await client.close()).toEqual(ok(null));
  expect(client.reuseReadiness?.()).toBe("blocked");
  expect(await client.executeIfReady?.("address_name", {})).toBeUndefined();
  expect(await client.execute("address_name", {})).toMatchObject({
    ok: false,
    error: {
      _tag: "ProviderAdapterError",
      diagnostics: { reason: "client_closed" },
    },
  });
  expect(create).not.toHaveBeenCalled();
  expect(child.close).not.toHaveBeenCalled();
});

it("retains child diagnostics across retries and returns the last typed failure unchanged", async () => {
  const left = failingProvider("provider-left", "address_name", "left-db");
  const right = failingProvider("provider-right", "procedure_info", "right-db");
  const client = new CompositeProvider([
    left.provider,
    right.provider,
  ]).createClient(executableTarget);

  expect((await client.execute("address_name", {})).ok).toBe(true);
  expect((await client.execute("procedure_info", {})).ok).toBe(true);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const closed = await client.close();
    if (closed.ok) throw new Error("Expected composite cleanup failure");
    expect(closed.error).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: ["left-db", "right-db"],
      diagnostics: {
        failures: [
          { provider_id: "provider-left", resources: ["left-db"] },
          { provider_id: "provider-right", resources: ["right-db"] },
        ],
      },
    });
    expect(closed.error).toBeInstanceOf(ProviderCleanupError);
    const projected = projectAnalysisError(closed.error);
    expect(projected.remediation.action).toContain(
      "Resolve left-db before retrying provider-left.",
    );
    expect(projected.remediation.action).toContain(
      "Resolve right-db before retrying provider-right.",
    );
    expect(closed.error.diagnostics).toMatchObject({
      failures: [
        {
          diagnostics: { reason: "provider-left cleanup is unresolved" },
        },
        {
          diagnostics: { reason: "provider-right cleanup is unresolved" },
        },
      ],
    });
  }

  expect(left.close).toHaveBeenCalledTimes(2);
  expect(right.close).toHaveBeenCalledTimes(2);

  left.close.mockResolvedValue(ok(null));
  const remaining = await client.close();
  if (remaining.ok) throw new Error("Expected remaining child cleanup failure");
  expect(remaining.error).toBe(right.cleanupError);
  right.close.mockResolvedValue(ok(null));
  expect(await client.close()).toEqual(ok(null));
  expect(left.close).toHaveBeenCalledTimes(3);
  expect(right.close).toHaveBeenCalledTimes(4);
});

it.each(["live", "released", "unknown"] as const)(
  "follows the second child's %s close outcome",
  async (outcome) => {
    const left = failingProvider("left", "address_name", "left-db");
    const right = failingProvider("right", "procedure_info", "right-db");
    const leftRelease = new AnalysisCleanupRelease();
    const rightRelease = new AnalysisCleanupRelease();
    leftRelease.bind(left.cleanupError);
    if (outcome !== "unknown") rightRelease.bind(right.cleanupError);
    else
      right.close.mockResolvedValue(
        err(new ProviderAdapterError("right", "close_binary", {})),
      );
    if (outcome === "released") rightRelease.confirm();
    const client = new CompositeProvider([
      left.provider,
      right.provider,
    ]).createClient(executableTarget);
    await client.execute("address_name", {});
    await client.execute("procedure_info", {});
    const closed = await client.close();
    if (closed.ok) throw new Error("Expected both child closes to fail");
    expect(closed.error.cleanupIncomplete).toBe(true);
    leftRelease.confirm();
    expect(closed.error.cleanupIncomplete).toBe(outcome !== "released");
    expect(closed.error.cleanupResources).toEqual(
      outcome === "live" ? ["right-db"] : [],
    );
    rightRelease.confirm();
    expect(closed.error.cleanupIncomplete).toBe(outcome === "unknown");
    left.close.mockResolvedValue(ok(null));
    right.close.mockResolvedValue(ok(null));
    expect(await client.close()).toEqual(ok(null));
    expect(closed.error.cleanupIncomplete).toBe(false);
  },
);

it("waits for each unconfirmed child to close on retry", async () => {
  const left = failingProvider("left", "address_name", "left-db");
  const right = failingProvider("right", "procedure_info", "right-db");
  for (const child of [left, right])
    child.close.mockResolvedValue(
      err(
        new ProviderAdapterError(child.provider.identity().id, "close_binary"),
      ),
    );
  const client = new CompositeProvider([
    left.provider,
    right.provider,
  ]).createClient(executableTarget);
  await client.execute("address_name", {});
  await client.execute("procedure_info", {});
  const first = await client.close();
  if (first.ok) throw new Error("Expected both child closes to fail");
  expect(first.error.cleanupIncomplete).toBe(true);
  left.close.mockResolvedValue(ok(null));
  expect((await client.close()).ok).toBe(false);
  expect(first.error.cleanupIncomplete).toBe(true);
  right.close.mockResolvedValue(ok(null));
  expect(await client.close()).toEqual(ok(null));
  expect(first.error.cleanupIncomplete).toBe(false);
});

it.each(["opaque", "already released", "still owned"] as const)(
  "follows selective composite retries when a child throws (%s)",
  async (origin) => {
    const left = failingProvider("left", "address_name", "left-db");
    const right = failingProvider("right", "procedure_info", "right-db");
    const leftRelease = new AnalysisCleanupRelease();
    const rightRelease = new AnalysisCleanupRelease();
    leftRelease.bind(left.cleanupError);
    rightRelease.bind(right.cleanupError);
    if (origin === "already released") rightRelease.confirm();
    const physical =
      origin === "opaque"
        ? new Error("right close rejected")
        : right.cleanupError;
    right.close
      .mockRejectedValueOnce(physical)
      .mockRejectedValueOnce(physical)
      .mockResolvedValue(ok(null));
    const client = new CompositeProvider([
      left.provider,
      right.provider,
    ]).createClient(executableTarget);
    await client.execute("address_name", {});
    await client.execute("procedure_info", {});
    const initial = await client.close();
    if (initial.ok || !(initial.error.cause instanceof AggregateError))
      throw new Error("expected both failed children");
    const stillOwned = origin === "still owned";
    const [, rejected] = initial.error.cause.errors;
    if (stillOwned) expect(rejected).toBe(physical);
    else expect(rejected.cause).toBe(physical);
    leftRelease.confirm();
    left.close.mockResolvedValue(ok(null));
    expect((await client.close()).ok).toBe(false);
    expect(initial.error.cleanupIncomplete).toBe(true);
    expect(initial.error.cleanupResources).toEqual([
      stillOwned ? "right-db" : "provider-client",
    ]);
    expect(await client.close()).toEqual(ok(null));
    expect(left.close).toHaveBeenCalledTimes(2);
    expect(right.close).toHaveBeenCalledTimes(3);
    // Only a child's own cleanup claim can release the typed owner it reported.
    expect(initial.error.cleanupIncomplete).toBe(stillOwned);
    rightRelease.confirm();
    expect(initial.error.cleanupIncomplete).toBe(false);
    expect(initial.error.cleanupResources).toEqual([]);
  },
);

it("does not close an already released child again when retry options change", async () => {
  const first = failingProvider("provider-first", "address_name", "first-db");
  const second = failingProvider(
    "provider-second",
    "procedure_info",
    "second-db",
  );
  first.close.mockResolvedValue(ok(null));
  second.close
    .mockResolvedValueOnce(err(second.cleanupError))
    .mockResolvedValue(ok(null));
  const client = new CompositeProvider([
    first.provider,
    second.provider,
  ]).createClient(executableTarget);
  await client.execute("address_name", {});
  await client.execute("procedure_info", {});

  expect((await client.close({ retainDocument: true })).ok).toBe(false);
  expect((await client.close()).ok).toBe(true);
  expect((await client.close({ retainDocument: true })).ok).toBe(true);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(second.close).toHaveBeenCalledTimes(2);
});

it.each(["busy", "unknown", "idle", undefined] as const)(
  "keeps partial health truthful with child state %s and an unobserved peer",
  async (state) => {
    const observedIdentity = identity("provider-observed");
    const unobservedIdentity = identity("provider-unobserved");
    const observed: AnalysisProvider = {
      identity: () => observedIdentity,
      capabilities: () => [
        operationCapability(observedIdentity, "address_name"),
      ],
      createClient: () => ({
        execute: async () =>
          ok(createAnalysisExecution(null, observedIdentity)),
        operationHealthSnapshot: () =>
          state === undefined
            ? undefined
            : {
                state,
                stage: state === "idle" ? null : "analysis",
                retryAction:
                  state === "busy"
                    ? "wait"
                    : state === "idle"
                      ? null
                      : "unknown",
                exitCode: null,
                requests: [],
              },
        close: async () => ok(null),
      }),
    };
    const unobserved: AnalysisProvider = {
      identity: () => unobservedIdentity,
      capabilities: () => [
        operationCapability(unobservedIdentity, "procedure_info"),
      ],
      createClient: () => ({
        execute: async () =>
          ok(createAnalysisExecution(null, unobservedIdentity)),
        close: async () => ok(null),
      }),
    };
    const client = new CompositeProvider([observed, unobserved]).createClient(
      executableTarget,
    );
    await client.execute("address_name", {});
    await client.execute("procedure_info", {});

    if (state === "idle" || state === undefined)
      expect(client.operationHealthSnapshot?.()).toBeUndefined();
    else expect(client.operationHealthSnapshot?.()).toMatchObject({ state });
    expect((await client.close()).ok).toBe(true);
  },
);

it.each([1, 2])(
  "reports early cleanup failures once across a deferred %s-child composite and retries",
  async (childCount) => {
    let release!: () => void;
    const finalization = new Promise<void>((resolve) => {
      release = resolve;
    });
    const children = [
      failingProvider("provider-left", "address_name", "left-db"),
      failingProvider("provider-right", "procedure_info", "right-db"),
    ].slice(0, childCount);
    for (const child of children) {
      let attempts = 0;
      child.close.mockImplementation(async (options) => {
        attempts += 1;
        if (attempts > 2) return ok(null);
        // The resource owner discovers its failure while final cleanup is
        // still pending, before the composite can return its result.
        options?.onCleanupFailure?.(child.cleanupError);
        await finalization;
        return err(child.cleanupError);
      });
    }
    const client = new CompositeProvider(
      children.map((child) => child.provider),
    ).createClient(executableTarget);
    await client.execute("address_name", {});
    if (childCount === 2) await client.execute("procedure_info", {});
    const notifications: AnalysisError[] = [];
    const options = {
      onCleanupFailure: (failure: AnalysisError) => notifications.push(failure),
    };
    let settled = false;
    const closing = closeAnalysisClient(client, "composite", options).then(
      (result) => {
        settled = true;
        return result;
      },
    );
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(notifications).toEqual(
        children.map((child) => child.cleanupError),
      );
    } finally {
      release();
    }
    const first = await closing;
    if (first.ok) throw new Error("Expected retained child cleanup");
    expect(notifications).toEqual([
      ...children.map((child) => child.cleanupError),
      ...(childCount === 2 ? [first.error] : []),
    ]);
    expect(first.error.cleanupResources).toEqual(
      children.flatMap((child) => child.cleanupError.cleanupResources),
    );

    notifications.length = 0;
    const retried = await closeAnalysisClient(client, "composite", options);
    if (retried.ok) throw new Error("Expected failed cleanup retry");
    expect(notifications).toEqual([
      ...children.map((child) => child.cleanupError),
      ...(childCount === 2 ? [retried.error] : []),
    ]);
    if (childCount === 2) expect(retried.error).not.toBe(first.error);

    notifications.length = 0;
    expect(await closeAnalysisClient(client, "composite", options)).toEqual(
      ok(null),
    );
    expect(notifications).toEqual([]);
    for (const child of children) expect(child.close).toHaveBeenCalledTimes(3);
    expect(await closeAnalysisClient(client, "composite", options)).toEqual(
      ok(null),
    );
    for (const child of children) expect(child.close).toHaveBeenCalledTimes(3);
  },
);
