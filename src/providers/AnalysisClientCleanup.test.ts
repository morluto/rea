import { expect, it } from "vitest";

import {
  projectAnalysisError,
  projectAnalysisErrorWithoutCapturedOutput,
} from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok } from "../domain/result.js";
import type { AnalysisClient } from "../ports/AnalysisProvider.js";
import { closeAnalysisClient } from "./AnalysisClientCleanup.js";
import { AnalysisClientCreation } from "./AnalysisClientCreation.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { releaseOwnedCleanup } from "../../tests/support/cleanupRelease.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";

const clientClosingWith = (cause: unknown): AnalysisClient => ({
  execute: () => Promise.resolve(err(new ProviderCleanupError("x", [], {}))),
  close: () => Promise.reject(cause),
});

it("keeps the leftover resources a typed cleanup failure names", async () => {
  const leftover = "/tmp/rea-ghidra-fixture";
  const failure = new ProviderCleanupError("ghidra", [leftover], {
    reason: "runtime directory retained",
  });

  const closed = await closeAnalysisClient(
    clientClosingWith(failure),
    "ghidra",
  );

  expect(closed.ok).toBe(false);
  if (!closed.ok)
    expect(projectAnalysisError(closed.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: [leftover] },
    });
});

it("still reports an untyped close rejection as the provider client", async () => {
  const closed = await closeAnalysisClient(
    clientClosingWith(new Error("unexpected")),
    "ghidra",
  );

  expect(closed.ok).toBe(false);
  if (!closed.ok)
    expect(projectAnalysisError(closed.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: ["provider-client"] },
    });
});

it("preserves the original explanation and collected output alongside cleanup uncertainty", () => {
  const primary = new ProviderAdapterError("fixture", "capture", {
    userMessage: "Select the running target process and retry the capture.",
    capturedOutput: {
      stdout: "partial observation",
      stderr: "native reason",
      truncated: false,
    },
  });
  const cleanup = new ProviderCleanupError("fixture", ["owned-process"], {
    reason: "Process termination was not confirmed",
  });
  const combined = analysisErrorWithCleanupFailure(primary, cleanup);
  const projected = projectAnalysisError(combined);
  expect(projected).toMatchObject({
    code: "cleanup_incomplete",
    message: primary.userMessage,
    details: {
      resources: ["owned-process"],
      captured_output: primary.capturedOutput,
      diagnostics: {
        primary_error: projectAnalysisErrorWithoutCapturedOutput(primary),
        cleanup_error: projectAnalysisError(cleanup),
      },
    },
  });
  expect(projected).not.toHaveProperty(
    "details.diagnostics.primary_error.details.captured_output",
  );
  expect(JSON.stringify(projected).split("partial observation")).toHaveLength(
    2,
  );
  expect(JSON.stringify(projected).split("native reason")).toHaveLength(2);
  expect(combined.cause).toBeInstanceOf(AggregateError);
  expect(combined.cause).toMatchObject({
    cause: primary,
    errors: [primary, cleanup],
  });
});

it.each(["return", "reject"] as const)(
  "reports a nested owner's failure once when close also %ss it",
  async (outcome) => {
    const failure = new ProviderCleanupError("fixture", ["owned-process"], {});
    const notifications: unknown[] = [];
    const child: AnalysisClient = {
      execute: clientClosingWith(failure).execute,
      close: (options) => {
        options?.onCleanupFailure?.(failure);
        return outcome === "return"
          ? Promise.resolve(err(failure))
          : Promise.reject(failure);
      },
    };
    const parent: AnalysisClient = {
      execute: child.execute,
      close: (options) => closeAnalysisClient(child, "fixture", options),
    };

    const closed = await closeAnalysisClient(parent, "composite", {
      onCleanupFailure: (error) => notifications.push(error),
    });

    expect(closed).toEqual(err(failure));
    expect(notifications).toEqual([failure]);
  },
);

it("reports distinct failures during final cleanup and reports again on retry", async () => {
  const first = new ProviderCleanupError("first", ["first-resource"], {});
  const final = new ProviderCleanupError("second", ["second-resource"], {});
  const notifications: unknown[] = [];
  const client: AnalysisClient = {
    execute: clientClosingWith(first).execute,
    close: (options) => {
      options?.onCleanupFailure?.(first);
      return Promise.resolve(err(final));
    },
  };
  const options = {
    onCleanupFailure: (error: unknown) => notifications.push(error),
  };

  expect(await closeAnalysisClient(client, "composite", options)).toEqual(
    err(final),
  );
  expect(notifications).toEqual([first, final]);
  expect(await closeAnalysisClient(client, "composite", options)).toEqual(
    err(final),
  );
  expect(notifications).toEqual([first, final, first, final]);
});

it("does not reuse a stale cleanup lease across replacement clients after external cleanup settlement", async () => {
  const innerCleanup = new ProviderCleanupError("fixture", ["client-a"], {});
  const clientACleanup = new ProviderCleanupError(
    "fixture",
    ["client-a"],
    {},
  ).bindCleanupDependencies([innerCleanup]);
  let clientAClosed = 0;
  let clientBClosed = 0;
  const clientA: AnalysisClient = {
    execute: () =>
      Promise.resolve(err(new ProviderAdapterError("fixture", "execute", {}))),
    close: async () => {
      clientAClosed += 1;
      return err(clientACleanup);
    },
  };
  const clientB: AnalysisClient = {
    execute: () =>
      Promise.resolve(err(new ProviderAdapterError("fixture", "execute", {}))),
    close: async () => {
      clientBClosed += 1;
      return ok(null);
    },
  };
  let created = 0;
  const controller = new AbortController();
  const creation = new AnalysisClientCreation("fixture", async () => {
    created += 1;
    if (created === 1) {
      controller.abort("cancel first attempt");
      return clientA;
    }
    return clientB;
  });

  const first = await creation.acquire("op1", controller.signal);
  expect(first.ok).toBe(false);
  if (!first.ok) expect(first.error.cleanupIncomplete).toBe(true);
  expect(clientAClosed).toBe(1);

  // External owner resolves innerCleanup/clientACleanup even though clientLease.released is still false.
  releaseOwnedCleanup(innerCleanup);

  const second = await creation.acquire("op2");
  expect(second).toEqual(ok(clientB));

  const closed = await creation.close();
  expect(closed).toEqual(ok(null));
  expect(clientBClosed).toBe(1);
});

it("retains the latest close options across concurrent close() calls", async () => {
  const gate = phaseGate();
  const seenOptions: unknown[] = [];
  const client: AnalysisClient = {
    execute: () =>
      Promise.resolve(err(new ProviderAdapterError("fixture", "execute", {}))),
    close: async (options) => {
      seenOptions.push(options);
      return ok(null);
    },
  };
  const creation = new AnalysisClientCreation("fixture", async () => {
    await gate.hold();
    return client;
  });
  const acquiring = creation.acquire("op1");
  await gate.reached(acquiring, "client creation");
  const options1 = { retainDocument: true };
  const options2 = { retainDocument: false };
  const close1 = creation.close(options1);
  const close2 = creation.close(options2);
  gate.release();
  await Promise.all([acquiring, close1, close2]);
  expect(seenOptions).toEqual([options2]);
});

it("keeps the client's own close advice and limit on the retained close failure", async () => {
  const advice = "Close again to discard the unsaved edits.";
  const limit = {
    control_kind: "environment",
    environment: "REA_FIXTURE_WAIT_MS",
    effective_value: 100,
    unit: "ms",
    minimum: 50,
    maximum: 1_000,
    default_value: 500,
    applies_at: "next_startup",
  } as const;
  const refused = new ProviderCleanupError(
    "fixture",
    ["client"],
    {},
    { remediationAction: advice, limit },
  );
  let closes = 0;
  const creation = new AnalysisClientCreation("fixture", async () => ({
    execute: clientClosingWith(refused).execute,
    close: async () => ((closes += 1) === 1 ? err(refused) : ok(null)),
  }));
  expect((await creation.acquire("open")).ok).toBe(true);
  const closed = await creation.close();
  if (closed.ok) throw new Error("the refused close unexpectedly succeeded");
  expect(closed.error).toMatchObject({ remediationAction: advice });
  const projected = projectAnalysisError(closed.error);
  expect(projected.remediation.action).toContain(advice);
  expect(projected.details?.limit).toEqual(limit);
  expect(await creation.close()).toEqual(ok(null));
});
