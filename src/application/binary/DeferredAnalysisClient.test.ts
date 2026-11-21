import { expect, it } from "vitest";
import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";
import {
  phaseArrival,
  phaseGate,
} from "../../../tests/support/lifecycleHarness.js";
import { DeferredAnalysisClient } from "../../providers/DeferredAnalysisClient.js";
import {
  createAnalysisExecution,
  type AnalysisClient,
} from "../../ports/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { resolvedAnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok } from "../../domain/result.js";
import { releaseOwnedCleanup } from "../../../tests/support/cleanupRelease.js";

const identity = { id: "controlled", name: "Controlled client", version: "1" };

it.each([
  new AnalysisAccessDeniedError(
    "ghidra:installation",
    "/selected/properties",
    "EACCES",
  ),
  new AnalysisArtifactChangedError(
    "ghidra:installation",
    "/selected/properties",
    "selected name changed",
  ),
  new AnalysisResourceConstraintError(
    "ghidra:installation",
    "file-size",
    "metadata budget",
    { maximum_bytes: 1024 },
    { retryable: false },
  ),
])(
  "attributes prerequisite $_tag to the requested operation without changing its facts",
  async (physical) => {
    const client = new DeferredAnalysisClient(async () => {
      throw physical;
    }, identity.id);
    try {
      const result = await client.execute("analyze_function", {});
      if (result.ok) throw new Error("Expected prerequisite failure");
      expect(result.error).toMatchObject({
        _tag: physical._tag,
        operation: "analyze_function",
      });
      expect(result.error.cause).toBe(physical);
      if (physical instanceof AnalysisResourceConstraintError)
        expect(result.error).toMatchObject({
          resource: "file-size",
          reportedLimits: { maximum_bytes: 1024 },
          retryable: false,
        });
      else expect(result.error).toMatchObject({ path: "/selected/properties" });
    } finally {
      await client.close();
    }
  },
);
const child = (
  close: AnalysisClient["close"] = async () => ok(null),
): AnalysisClient => ({
  execute: async () => ok(createAnalysisExecution(null, identity)),
  close,
  operationHealthSnapshot: () => ({
    state: "idle",
    stage: null,
    retryAction: null,
    exitCode: null,
    requests: [],
  }),
});

it("refuses dispatch when close starts after a ready client was acquired", async () => {
  let operations = 0;
  const acquired: AnalysisClient = {
    ...child(),
    execute: async () => {
      operations++;
      return ok(createAnalysisExecution(null, identity));
    },
  };
  const client = new DeferredAnalysisClient(async () => acquired, identity.id);
  expect((await client.execute("health", {})).ok).toBe(true);
  const pending = client.execute("analyze_function", {});
  const closing = client.close();
  try {
    expect(await pending).toMatchObject({
      ok: false,
      error: {
        _tag: "ProviderAdapterError",
        operation: "analyze_function",
        diagnostics: { reason: "client_closed" },
      },
    });
    expect(operations).toBe(1);
    expect(
      await client.executeIfReady?.("analyze_function", {}),
    ).toBeUndefined();
    expect(await closing).toEqual(ok(null));
  } finally {
    await pending;
    await closing;
    await client.close();
  }
});

it.each([
  null,
  "caller reason",
  new ProviderCleanupError("foreign", ["foreign resource"], {
    reason: "caller metadata",
  }),
])(
  "does not acquire or adopt resources for pre-aborted opaque reasons (%s)",
  async (reason) => {
    let creates = 0;
    const controller = new AbortController();
    controller.abort(reason);
    const client = new DeferredAnalysisClient(async () => {
      creates++;
      return child();
    }, identity.id);
    const result = await client.execute(
      "health",
      {},
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.cleanupResources).toEqual([]);
    expect(creates).toBe(0);
    expect(await client.close()).toEqual(ok(null));
  },
);

it("keeps a shared creation alive for an interested peer", async () => {
  const creation = phaseGate<void, AnalysisClient>();
  let observed: AbortSignal | undefined,
    creates = 0,
    closes = 0;
  const client = new DeferredAnalysisClient(async (signal) => {
    creates++;
    observed = signal;
    return creation.hold();
  }, identity.id);
  const controller = new AbortController(),
    reason = { request: "one peer leaves" };
  const first = client.execute("health", {}, { signal: controller.signal });
  const second = client.execute("health", {});
  await withVerifierCleanup(async () => {
    await creation.reached(first, "shared client creation");
    controller.abort(reason);
    const cancelled = await first;
    if (cancelled.ok) throw new Error("Expected peer cancellation");
    expect(cancelled.error.cause).toBe(reason);
    expect(observed?.aborted).toBe(false);
    creation.release(
      child(async () => {
        closes++;
        return ok(null);
      }),
    );
    expect((await second).ok).toBe(true);
    expect(creates).toBe(1);
    expect(await client.close()).toEqual(ok(null));
    expect(closes).toBe(1);
  }, [
    () => controller.abort(),
    () => creation.release(child()),
    async () => {
      await Promise.allSettled([first, second]);
    },
    async () => {
      const closed = await client.close();
      if (!closed.ok) throw closed.error;
    },
  ]);
});

it("joins a late acquired client's final cleanup before cancellation settles", async () => {
  const creation = phaseGate<void, AnalysisClient>(),
    childClose = phaseGate();
  let closes = 0,
    settled = false;
  const client = new DeferredAnalysisClient(async () => {
    return creation.hold();
  }, identity.id);
  const controller = new AbortController(),
    reason = { request: "late acquisition" };
  const pending = client
    .execute("analyze_function", {}, { signal: controller.signal })
    .then((result) => {
      settled = true;
      return result;
    });
  await withVerifierCleanup(async () => {
    await creation.reached(pending, "client creation");
    controller.abort(reason);
    creation.release(
      child(async () => {
        closes++;
        await childClose.hold();
        return ok(null);
      }),
    );
    await childClose.reached(pending, "client cleanup");
    expect(settled).toBe(false);
    expect(client.operationHealthSnapshot()?.state).toBe("idle");
    expect(client.reuseReadiness()).toBe("blocked");
    childClose.release();
    const result = await pending;
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error.cause).toBe(reason);
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(await client.close()).toEqual(ok(null));
    expect(closes).toBe(1);
  }, [
    () => controller.abort(),
    () => creation.release(child()),
    () => childClose.release(),
    async () => {
      await pending;
    },
    async () => {
      const closed = await client.close();
      if (!closed.ok) throw closed.error;
    },
  ]);
});

it("waits for abandoned creation cleanup before sharing a fresh client", async () => {
  const creation = phaseGate<void, AnalysisClient>(),
    childClose = phaseGate();
  let creates = 0;
  const client = new DeferredAnalysisClient(async () => {
    creates++;
    if (creates > 1) return child();
    return creation.hold();
  }, identity.id);
  const controller = new AbortController();
  const reason = { request: "first caller" };
  const first = client.execute("health", {}, { signal: controller.signal });
  let second: ReturnType<AnalysisClient["execute"]> | undefined;
  let third: ReturnType<AnalysisClient["execute"]> | undefined;
  await withVerifierCleanup(async () => {
    await creation.reached(first, "client creation");
    controller.abort(reason);
    creation.release(
      child(async () => {
        await childClose.hold();
        return ok(null);
      }),
    );
    await childClose.reached(first, "client cleanup");
    second = client.execute("health", {});
    third = client.execute("health", {});
    expect(creates).toBe(1);
    childClose.release();
    const cancelled = await first;
    if (cancelled.ok) throw new Error("Expected first caller cancellation");
    expect(cancelled.error.cause).toBe(reason);
    expect((await second).ok).toBe(true);
    expect((await third).ok).toBe(true);
    expect(creates).toBe(2);
  }, [
    () => controller.abort(),
    () => creation.release(child()),
    () => childClose.release(),
    async () => {
      await Promise.allSettled([first, second, third]);
    },
    async () => {
      const closed = await client.close();
      if (!closed.ok) throw closed.error;
    },
  ]);
});

it.each(["caller", "close", "cleanup", "physical"] as const)(
  "preserves %s while a new caller waits for abandoned creation",
  async (outcome) => {
    const entered = phaseArrival(),
      aborted = phaseArrival(),
      acquisition = phaseGate(),
      release = phaseGate();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const physical = new ProviderAdapterError(
      identity.id,
      "create_analysis_client",
      { diagnostics: { reason: "physical fixture fault" } },
    );
    let creates = 0;
    let denied = outcome === "cleanup";
    const client = new DeferredAnalysisClient(async (signal) => {
      creates++;
      signal.addEventListener("abort", () => aborted.arrive(), { once: true });
      entered.arrive();
      if (outcome === "physical") {
        await release.hold();
        throw physical;
      }
      await acquisition.hold();
      return child(async () => {
        await release.hold();
        return denied
          ? err(
              new ProviderCleanupError(identity.id, ["controlled child"], {
                reason: "close refused",
              }),
            )
          : ok(null);
      });
    }, identity.id);
    const first = client.execute(
      "health",
      {},
      { signal: firstController.signal },
    );
    let second: ReturnType<AnalysisClient["execute"]> | undefined;
    let closing: ReturnType<AnalysisClient["close"]> | undefined;
    await withVerifierCleanup(async () => {
      await entered.reached(first, "client creation");
      firstController.abort("first caller");
      await aborted.reached(first, "creation abort");
      if (outcome !== "physical") {
        acquisition.release();
        await release.reached(first, "client cleanup");
      }
      second = client.execute(
        "analyze_function",
        {},
        {
          signal: secondController.signal,
        },
      );
      if (outcome === "caller") secondController.abort("second caller");
      if (outcome === "close") closing = client.close();
      release.release();
      const result = await second;
      if (result.ok) throw new Error("Expected interrupted creation");
      if (outcome === "caller") {
        expect(result.error).toBeInstanceOf(AnalysisCancelledError);
        expect(result.error.cause).toBe("second caller");
      } else if (outcome === "close") {
        expect(result.error).toMatchObject({
          diagnostics: { reason: "client_closed" },
        });
        expect((await closing)?.ok).toBe(true);
      } else if (outcome === "cleanup") {
        expect(result.error.cleanupIncomplete).toBe(true);
        expect(result.error.cleanupResources).toContain("controlled child");
      } else {
        expect(result.error).toMatchObject({
          diagnostics: { reason: "physical fixture fault" },
        });
        expect(result.error.cause).toBe(physical);
      }
      expect((await first).ok).toBe(false);
      expect(creates).toBe(1);
    }, [
      () => firstController.abort(),
      () => secondController.abort(),
      () => acquisition.release(),
      () => release.release(),
      async () => {
        await Promise.allSettled([first, second, closing]);
      },
      async () => {
        denied = false;
        const closed = await client.close();
        if (!closed.ok) throw closed.error;
      },
    ]);
  },
);

it("keeps a producer-authored physical failure primary even when it is the caller's abort reason", async () => {
  const creation = phaseGate();
  const physical = new ProviderAdapterError(
    identity.id,
    "create_analysis_client",
    { diagnostics: { reason: "physical fixture fault" } },
  );
  const client = new DeferredAnalysisClient(async () => {
    await creation.hold();
    throw physical;
  }, identity.id);
  const controller = new AbortController();
  const pending = client.execute(
    "analyze_function",
    {},
    { signal: controller.signal },
  );
  await withVerifierCleanup(async () => {
    await creation.reached(pending, "client creation");
    controller.abort(physical);
    creation.release();
    const result = await pending;
    if (result.ok) throw new Error("Expected physical failure");
    expect(result.error).toMatchObject({
      _tag: "ProviderAdapterError",
      operation: "analyze_function",
      diagnostics: {
        reason: "physical fixture fault",
      },
    });
    expect(result.error.cause).toBe(physical);
    expect(physical.cause).toBeUndefined();
    expect(projectAnalysisError(result.error).code).toBe("execution_failure");
  }, [
    () => controller.abort(),
    () => creation.release(),
    async () => {
      await pending;
    },
    async () => {
      const closed = await client.close();
      if (!closed.ok) throw closed.error;
    },
  ]);
});

it("retains a failed late client's exact close owner and restores cancellation after confirmed retry", async () => {
  let denied = true,
    closes = 0;
  const controller = new AbortController(),
    reason = { request: "late cleanup refusal" };
  const client = new DeferredAnalysisClient(async () => {
    controller.abort(reason);
    return child(async () => {
      closes++;
      return denied
        ? err(
            new ProviderCleanupError(identity.id, ["controlled child"], {
              reason: "controlled close refusal",
            }),
          )
        : ok(null);
    });
  }, identity.id);
  const result = await client.execute(
    "analyze_function",
    {},
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected cancellation with cleanup");
  try {
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toEqual(["controlled child"]);
    expect(client.reuseReadiness()).toBe("blocked");
    const firstClose = await client.close();
    if (firstClose.ok) throw new Error("Expected retained close failure");
    expect(firstClose.error.cleanupIncomplete).toBe(true);
    expect(closes).toBe(2);
    denied = false;
    expect(await client.close()).toEqual(ok(null));
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(firstClose.error.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(result.error).code).toBe("cancelled");
    expect(resolvedAnalysisError(result.error).cause).toBe(reason);
    expect(await client.close()).toEqual(ok(null));
    expect(closes).toBe(3);
  } finally {
    denied = false;
    await client.close();
  }
});

it("retains a failed prerequisite owner without creating a native client", async () => {
  let denied = true,
    releases = 0;
  const cleanup = new ProviderCleanupError(
    identity.id,
    ["controlled prerequisite"],
    { reason: "controlled refusal" },
  );
  const reason = { request: "prerequisite finalization" };
  const client = new DeferredAnalysisClient(async (_signal, resources) => {
    resources.retain(
      {
        close: async () => {
          releases++;
          if (denied) throw cleanup;
          releaseOwnedCleanup(cleanup);
        },
      },
      "controlled prerequisite",
    );
    throw new AnalysisCancelledError("create_analysis_client", {
      cause: reason,
      cleanup: {
        reason: "controlled refusal",
        resources: cleanup.cleanupResources,
      },
    }).bindCleanupDependencies([cleanup]);
  }, identity.id);
  const result = await client.execute("analyze_function", {});
  if (result.ok) throw new Error("Expected prerequisite failure");
  try {
    expect(result.error.cleanupIncomplete).toBe(true);
    expect((await client.close()).ok).toBe(false);
    denied = false;
    expect(await client.close()).toEqual(ok(null));
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(projectAnalysisError(result.error).code).toBe("cancelled");
    expect(resolvedAnalysisError(result.error).cause).toBe(reason);
    expect(releases).toBe(3);
  } finally {
    denied = false;
    await client.close();
  }
});

it("retries only unresolved prerequisite and native owners across mixed cleanup outcomes", async () => {
  let denyPrerequisite = true,
    denyChild = true,
    prerequisites = 0,
    closes = 0;
  const prerequisiteFailure = new ProviderCleanupError(
    identity.id,
    ["mixed prerequisite"],
    { reason: "controlled prerequisite refusal" },
  );
  const client = new DeferredAnalysisClient(async (_signal, resources) => {
    resources.retain(
      {
        close: async () => {
          prerequisites++;
          if (denyPrerequisite) throw prerequisiteFailure;
          releaseOwnedCleanup(prerequisiteFailure);
        },
      },
      "mixed prerequisite",
    );
    return child(async () => {
      closes++;
      return denyChild
        ? err(
            new ProviderCleanupError(identity.id, ["mixed child"], {
              reason: "controlled child refusal",
            }),
          )
        : ok(null);
    });
  }, identity.id);
  const result = await client.execute("analyze_function", {});
  if (result.ok)
    throw new Error("Expected mixed initialization cleanup failure");
  try {
    expect(result.error.cleanupResources).toEqual(
      expect.arrayContaining(["mixed prerequisite", "mixed child"]),
    );
    expect(client.reuseReadiness()).toBe("blocked");
    denyPrerequisite = false;
    const first = await client.close();
    expect(first.ok).toBe(false);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toEqual(["mixed child"]);
    expect(prerequisites).toBe(2);
    denyChild = false;
    expect(await client.close()).toEqual(ok(null));
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(prerequisites).toBe(2);
    expect(closes).toBe(3);
  } finally {
    denyPrerequisite = false;
    denyChild = false;
    await client.close();
  }
});

it("settles deferred client close failure when the underlying owned resource lease releases", async () => {
  let released = false;
  const underlyingOwner = {
    get cleanupResources() {
      return released ? [] : ["owned-descriptor"];
    },
  };
  const underlyingClaim = {
    get cleanupReleased() {
      return released;
    },
  };
  const client = new DeferredAnalysisClient(
    async () =>
      child(async () => {
        if (released) return ok(null);
        return err(
          new ProviderCleanupError(identity.id, ["owned-descriptor"], {
            reason: "descriptor close denied",
          })
            .bindCleanupResourceOwner(underlyingOwner)
            .bindCleanupReleaseClaim(underlyingClaim),
        );
      }),
    identity.id,
  );
  const executed = await client.execute("analyze_function", {});
  expect(executed.ok).toBe(true);
  const closed = await client.close();
  if (closed.ok) throw new Error("Expected retained close failure");
  expect(closed.error.cleanupIncomplete).toBe(true);
  expect(closed.error.cleanupResources).toEqual(["owned-descriptor"]);
  released = true;
  expect(closed.error.cleanupIncomplete).toBe(false);
  expect(closed.error.cleanupResources).toEqual([]);
});
