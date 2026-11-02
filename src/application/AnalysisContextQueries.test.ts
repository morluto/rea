import { describe, expect, it } from "vitest";
import { createDeferred } from "../../tests/fixtures/binarySession.js";

import {
  getNavigationContext,
  inspectAddressContext,
} from "./AnalysisContextQueries.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "./AnalysisProvider.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  primaryAnalysisError,
  type AnalysisError,
} from "../domain/analysisErrorBase.js";
import type { AnalysisExecution } from "./AnalysisProvider.js";
import type { Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

const registerNavigationSelectionValidationTests = (): void => {
  it.each([
    [null, "0x401000", "current_document"],
    ["fixture", null, "current_address"],
  ] as const)(
    "rejects malformed %s / %s provider selection before returning success",
    async (document, address, operation) => {
      const analysis: AnalysisOperationPort = {
        execute: async (name) =>
          ok(
            createAnalysisExecution(
              name === "current_document" ? document : address,
              provider,
            ),
          ),
      };
      const result = await getNavigationContext(analysis, {});
      expect(result).toEqual(
        err(
          new AnalysisOutputError(
            operation,
            operation === "current_document"
              ? "expected a document identity string"
              : "expected an address string",
          ),
        ),
      );
    },
  );
};

describe("analysis context queries: navigation", () => {
  registerNavigationSelectionValidationTests();

  it("aggregates volatile navigation and treats a missing procedure as null", async () => {
    const calls: {
      operation: string;
      parameters: Readonly<Record<string, unknown>>;
    }[] = [];
    const analysis: AnalysisOperationPort = {
      execute: (operation, parameters) => {
        calls.push({ operation, parameters });
        if (operation === "current_document")
          return Promise.resolve(
            ok(createAnalysisExecution("fixture", provider)),
          );
        if (operation === "current_address")
          return Promise.resolve(
            ok(createAnalysisExecution("0x401000", provider)),
          );
        if (operation === "resolve_containing_procedure")
          return Promise.resolve(
            ok(
              createAnalysisExecution(
                {
                  query_address: "0x401000",
                  found: false,
                  procedure: null,
                  reason: "not_in_procedure",
                },
                provider,
              ),
            ),
          );
        return Promise.resolve(
          err(new AnalysisProtocolError(`unexpected ${operation}`)),
        );
      },
    };

    await expect(getNavigationContext(analysis, {})).resolves.toEqual(
      ok({
        document: "fixture",
        address: "0x401000",
        procedure: null,
      }),
    );
    expect(calls).toContainEqual({
      operation: "current_document",
      parameters: {},
    });
    expect(calls).toContainEqual({
      operation: "resolve_containing_procedure",
      parameters: { document: "fixture", address: "0x401000" },
    });
  });

  it("preserves empty string selections accepted by the output contract", async () => {
    const analysis: AnalysisOperationPort = {
      execute: async (operation) =>
        ok(
          createAnalysisExecution(
            operation === "resolve_containing_procedure"
              ? {
                  query_address: "",
                  found: false,
                  procedure: null,
                  reason: "not_in_procedure",
                }
              : "",
            provider,
          ),
        ),
    };
    await expect(getNavigationContext(analysis, {})).resolves.toEqual(
      ok({ document: "", address: "", procedure: null }),
    );
  });

  it.each<JsonValue>([
    null,
    {},
    { found: false, procedure: null },
    { query_address: "0x401000", found: true, procedure: null },
  ])(
    "keeps malformed containing-procedure output unknown: %j",
    async (value) => {
      const analysis: AnalysisOperationPort = {
        execute: async (operation) =>
          ok(
            createAnalysisExecution(
              operation === "resolve_containing_procedure"
                ? value
                : operation === "current_document"
                  ? "fixture"
                  : "0x401000",
              provider,
            ),
          ),
      };
      expect(await getNavigationContext(analysis, {})).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisOutputError",
          operation: "resolve_containing_procedure",
        },
      });
    },
  );

  it("does not infer procedure absence from a provider error message", async () => {
    const failure = new AnalysisProtocolError(
      "not in a procedure: malformed reply",
    );
    const analysis: AnalysisOperationPort = {
      execute: async (operation) =>
        operation === "resolve_containing_procedure"
          ? err(failure)
          : ok(createAnalysisExecution("0x401000", provider)),
    };
    expect(
      await getNavigationContext(analysis, { document: "fixture" }),
    ).toEqual(err(failure));
  });

  it("uses an explicit document without passing it to current_document and preserves procedure failures", async () => {
    const calls: string[] = [];
    const failure = new AnalysisProtocolError("provider response malformed");
    const analysis: AnalysisOperationPort = {
      execute: (operation) => {
        calls.push(operation);
        if (operation === "current_address")
          return Promise.resolve(
            ok(createAnalysisExecution("0x401000", provider)),
          );
        return Promise.resolve(err(failure));
      },
    };

    await expect(
      getNavigationContext(analysis, { document: "fixture" }),
    ).resolves.toEqual(err(failure));
    expect(calls).not.toContain("current_document");
    expect(calls).toContain("resolve_containing_procedure");
  });
});

describe("navigation procedure admission", () => {
  it.each([
    { condition: "missing result", value: null },
    { condition: "missing discriminator", value: {} },
    {
      condition: "missing query identity",
      value: { found: false, procedure: null, reason: "not_in_procedure" },
    },
    {
      condition: "missing procedure facts",
      value: {
        query_address: "0x401000",
        found: true,
        procedure: { address: "0x401000", name: "main" },
      },
    },
  ])(
    "rejects $condition instead of reporting no procedure",
    async ({ value }) => {
      const result = await getNavigationContext(
        {
          execute: async (operation) =>
            ok(
              createAnalysisExecution(
                operation === "current_address" ? "0x401000" : value,
                provider,
              ),
            ),
        },
        { document: "fixture" },
      );
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisOutputError",
          operation: "resolve_containing_procedure",
        },
      });
    },
  );

  it.each(["no procedure exists", "not in a procedure"])(
    "preserves a provider failure containing %s",
    async (message) => {
      const failure = new AnalysisProtocolError(`Provider failed: ${message}`);
      const result = await getNavigationContext(
        {
          execute: async (operation) =>
            operation === "current_address"
              ? ok(createAnalysisExecution("0x401000", provider))
              : err(failure),
        },
        { document: "fixture" },
      );
      expect(result).toEqual(err(failure));
      if (result.ok) throw new Error("expected original provider failure");
      expect(result.error).toBe(failure);
    },
  );

  it("returns a validated containing procedure name", async () => {
    const result = await getNavigationContext(
      {
        execute: async (operation) =>
          ok(
            createAnalysisExecution(
              operation === "current_address"
                ? "0x401000"
                : {
                    query_address: "0x401000",
                    found: true,
                    procedure: {
                      address: "0x401000",
                      name: "main",
                      classification: null,
                      body: {
                        available: false,
                        reason: "Fixture has no body ranges",
                      },
                    },
                  },
              provider,
            ),
          ),
      },
      { document: "fixture" },
    );
    expect(result).toEqual(
      ok({ document: "fixture", address: "0x401000", procedure: "main" }),
    );
  });
});

describe("analysis context queries: address facets", () => {
  it("keeps unsupported address facets local and filters bookmarks", async () => {
    const bookmarkInputs: Readonly<Record<string, unknown>>[] = [];
    const analysis: AnalysisOperationPort = {
      execute: (operation, input) => {
        if (operation === "current_document")
          return Promise.resolve(
            ok(createAnalysisExecution("fixture", provider)),
          );
        if (operation === "comment")
          return Promise.resolve(
            err(new AnalysisProtocolError("comments unavailable")),
          );
        switch (operation) {
          case "address_name":
            return Promise.resolve(
              ok(createAnalysisExecution("entry", provider)),
            );
          case "resolve_containing_procedure":
            return Promise.resolve(
              ok(
                createAnalysisExecution(
                  {
                    query_address: "0x401000",
                    found: true,
                    procedure: {
                      address: "0x401000",
                      name: "main",
                      classification: null,
                      body: {
                        available: false,
                        reason: "Fixture omits body ranges.",
                      },
                    },
                  },
                  provider,
                ),
              ),
            );
          case "inline_comment":
            return Promise.resolve(ok(createAnalysisExecution(null, provider)));
          case "list_bookmarks":
            bookmarkInputs.push(input);
            return Promise.resolve(
              ok(
                createAnalysisExecution(
                  [
                    { address: "0x401000", name: "review" },
                    { address: "0x402000", name: "other" },
                  ],
                  provider,
                ),
              ),
            );
          default:
            return Promise.resolve(
              err(new AnalysisProtocolError(`unexpected ${operation}`)),
            );
        }
      },
    };

    const result = await inspectAddressContext(analysis, {
      address: "401000",
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        document: "fixture",
        name: { state: "available", value: "entry" },
        comment: {
          state: "unavailable",
          reason: "comments unavailable",
        },
        bookmarks: {
          state: "available",
          value: [{ address: "0x401000", name: "review" }],
        },
      },
    });
    expect(bookmarkInputs).toEqual([{ document: "fixture" }]);
  });

  it("propagates cancellation instead of degrading it to an unavailable facet", async () => {
    const cancelled = new AnalysisCancelledError("comment");
    const analysis: AnalysisOperationPort = {
      execute: (operation) =>
        Promise.resolve(
          operation === "comment"
            ? err(cancelled)
            : ok(createAnalysisExecution(null, provider)),
        ),
    };

    await expect(
      inspectAddressContext(analysis, {
        address: "0x401000",
        document: "fixture",
      }),
    ).resolves.toEqual(err(cancelled));
  });

  it("reports malformed bookmark output as unavailable instead of empty", async () => {
    const analysis: AnalysisOperationPort = {
      execute: (operation) =>
        Promise.resolve(
          operation === "list_bookmarks"
            ? ok(createAnalysisExecution({ malformed: true }, provider))
            : ok(createAnalysisExecution(null, provider)),
        ),
    };

    await expect(
      inspectAddressContext(analysis, {
        address: "0x401000",
        document: "fixture",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        bookmarks: {
          state: "unavailable",
          reason: expect.stringContaining("malformed"),
        },
      },
    });
  });
});

it("does not start address facets after document selection completes under cancellation", async () => {
  const controller = new AbortController();
  const reason = { request: "cancelled after document selection" };
  const calls: string[] = [];
  const result = await inspectAddressContext(
    {
      execute: async (operation) => {
        calls.push(operation);
        controller.abort(reason);
        return ok(createAnalysisExecution("fixture", provider));
      },
    },
    { address: "0x401000" },
    controller.signal,
  );
  if (result.ok) throw new Error("expected cancelled selection");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(calls).toEqual(["current_document"]);
});

it("retains both facet cleanup owners until their independent retries succeed", async () => {
  const first = new AnalysisCapabilityUnavailableError(
    provider.id,
    "comment",
    "failed",
    {
      cleanup: { reason: "first release failed", resources: ["first-owner"] },
    },
  );
  const second = new AnalysisCapabilityUnavailableError(
    provider.id,
    "inline_comment",
    "failed",
    {
      cleanup: { reason: "second release failed", resources: ["second-owner"] },
    },
  );
  let firstRetryAllowed = false;
  const firstLease = new AnalysisCleanupLease(async () => {
    if (!firstRetryAllowed) throw new Error("still owned");
  }, ["first-owner"]);
  const secondLease = new AnalysisCleanupLease(async () => {}, [
    "second-owner",
  ]);
  firstLease.bindCleanupError(first);
  secondLease.bindCleanupError(second);
  const result = await inspectAddressContext(
    {
      execute: async (operation) =>
        operation === "comment"
          ? err(first)
          : operation === "inline_comment"
            ? err(second)
            : ok(createAnalysisExecution(null, provider)),
    },
    { address: "0x401000", document: "fixture" },
  );
  if (result.ok) throw new Error("expected retained cleanup failures");
  expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
  expect(result.error.cleanupResources).toEqual(
    expect.arrayContaining(["first-owner", "second-owner"]),
  );
  await expect(firstLease.release()).rejects.toThrow("still owned");
  expect(result.error.cleanupResources).toEqual(
    expect.arrayContaining(["first-owner", "second-owner"]),
  );
  await secondLease.release();
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(["first-owner"]);
  firstRetryAllowed = true;
  await firstLease.release();
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(result.error.cleanupResources).toEqual([]);
  expect(projectAnalysisError(result.error).code).toBe(
    "capability_unavailable",
  );
});

it("waits for late facet cleanup after cancellation and retains its owner", async () => {
  const controller = new AbortController();
  const started = createDeferred<void>();
  const late = createDeferred<Result<AnalysisExecution, AnalysisError>>();
  const failure = new AnalysisCapabilityUnavailableError(
    provider.id,
    "comment",
    "failed",
    {
      cleanup: { reason: "late cleanup failed", resources: ["late-owner"] },
    },
  );
  const lease = new AnalysisCleanupLease(async () => {}, ["late-owner"]);
  lease.bindCleanupError(failure);
  const analysis: AnalysisOperationPort = {
    execute: (operation) => {
      if (operation === "comment") {
        started.resolve();
        return late.promise;
      }
      return Promise.resolve(ok(createAnalysisExecution(null, provider)));
    },
  };
  let settled = false;
  const pending = inspectAddressContext(
    analysis,
    { address: "0x401000", document: "fixture" },
    controller.signal,
  ).then((result) => {
    settled = true;
    return result;
  });
  await started.promise;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  late.resolve(err(failure));
  const result = await pending;
  if (result.ok) throw new Error("expected cancellation with cleanup failure");
  expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
  expect(result.error.cleanupResources).toEqual(["late-owner"]);
  await lease.release();
  expect(projectAnalysisError(result.error).code).toBe("cancelled");
});

it("reports cancellation after a late successful facet that ignored its signal", async () => {
  const controller = new AbortController();
  const started = createDeferred<void>();
  const late = createDeferred<Result<AnalysisExecution, AnalysisError>>();
  const pending = inspectAddressContext(
    {
      execute: (operation) => {
        if (operation === "comment") {
          started.resolve();
          return late.promise;
        }
        return Promise.resolve(ok(createAnalysisExecution(null, provider)));
      },
    },
    { address: "0x401000", document: "fixture" },
    controller.signal,
  );
  await started.promise;
  controller.abort();
  late.resolve(ok(createAnalysisExecution("finished", provider)));
  const result = await pending;
  if (result.ok) throw new Error("expected cancellation");
  expect(projectAnalysisError(result.error).code).toBe("cancelled");
});

it("does not start facets for an already-cancelled explicit document", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls: string[] = [];
  const result = await inspectAddressContext(
    {
      execute: async (operation) => {
        calls.push(operation);
        return ok(createAnalysisExecution(null, provider));
      },
    },
    { address: "0x401000", document: "fixture" },
    controller.signal,
  );
  if (result.ok) throw new Error("expected cancellation");
  expect(projectAnalysisError(result.error).code).toBe("cancelled");
  expect(calls).toEqual([]);
});

it("preserves a provider's cancellation for the same signal", async () => {
  const controller = new AbortController();
  const started = createDeferred<void>();
  const reason = { request: "controlled cancellation" };
  let providerCancellation: AnalysisCancelledError | undefined;
  const pending = inspectAddressContext(
    {
      execute: (operation) => {
        if (operation !== "address_name")
          return Promise.resolve(ok(createAnalysisExecution(null, provider)));
        started.resolve();
        return new Promise((resolve) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              providerCancellation = new AnalysisCancelledError(operation, {
                cause: controller.signal.reason,
                diagnostics: { owner: "controlled provider" },
              });
              resolve(err(providerCancellation));
            },
            { once: true },
          );
        });
      },
    },
    { address: "0x401000", document: "fixture" },
    controller.signal,
  );
  await started.promise;
  controller.abort(reason);
  const result = await pending;
  if (result.ok) throw new Error("expected cancellation");
  expect(result.error).toBe(providerCancellation);
  expect(projectAnalysisError(result.error).details).toMatchObject({
    diagnostics: { owner: "controlled provider" },
  });
});

it.each([false, true])(
  "keeps an earlier cleanup failure primary when cancellation arrives later (cancellation cleanup=%s)",
  async (cancelCleanup) => {
    const controller = new AbortController();
    const firstDone = createDeferred<void>();
    const failure = new AnalysisCapabilityUnavailableError(
      provider.id,
      "comment",
      "failed",
      {
        cleanup: { reason: "cleanup failed", resources: ["first-owner"] },
      },
    );
    const lease = new AnalysisCleanupLease(async () => {}, ["first-owner"]);
    lease.bindCleanupError(failure);
    const cancelled = new AnalysisCancelledError(
      "address_name",
      cancelCleanup
        ? {
            cleanup: {
              reason: "cancel cleanup failed",
              resources: ["cancel-owner"],
            },
          }
        : undefined,
    );
    const cancellationLease = new AnalysisCleanupLease(async () => {}, [
      "cancel-owner",
    ]);
    if (cancelCleanup) cancellationLease.bindCleanupError(cancelled);
    const analysis: AnalysisOperationPort = {
      execute: async (operation) => {
        if (operation === "address_name")
          return new Promise((resolve) => {
            controller.signal.addEventListener(
              "abort",
              () => resolve(err(cancelled)),
              { once: true },
            );
          });
        if (operation === "comment") {
          firstDone.resolve();
          return err(failure);
        }
        return ok(createAnalysisExecution(null, provider));
      },
    };
    const pending = inspectAddressContext(
      analysis,
      { address: "0x401000", document: "fixture" },
      controller.signal,
    );
    await firstDone.promise;
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const result = await pending;
    if (result.ok) throw new Error("expected retained cleanup failure");
    expect(primaryAnalysisError(result.error)).toBe(failure);
    expect(failure.secondaryFailures).toContain(cancelled);
    expect(projectAnalysisError(result.error).code).toBe("cleanup_incomplete");
    await lease.release();
    if (cancelCleanup) {
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toEqual(["cancel-owner"]);
      await cancellationLease.release();
    }
    expect(projectAnalysisError(result.error).code).toBe(
      "capability_unavailable",
    );
  },
);
