import { expect, it, vi } from "vitest";
import { HopperRegexSearch } from "./HopperRegexSearch.js";
import {
  hopperReplySchemas,
  parseHopperReply,
} from "./HopperReplyContracts.js";
import { err, ok } from "../domain/result.js";
import {
  AnalysisCapabilityUnavailableError,
  OwnerCancellation,
} from "../domain/analysisErrorCore.js";
import {
  HopperRemoteError,
  HopperTimeoutError,
  HopperProcessError,
} from "./HopperErrors.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { parseConfig } from "../config/parseConfig.js";
import { silentLogger } from "../logger.js";
import { HopperClient } from "./HopperClient.js";
import { HopperProvider } from "./HopperProvider.js";
import { releaseOwnedCleanup } from "../../tests/support/cleanupRelease.js";

const regexMatch = vi.hoisted(() => ({
  afterSettle: undefined as (() => void) | undefined,
}));
vi.mock("../process/RegexMatcher.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../process/RegexMatcher.js")>();
  return {
    ...actual,
    matchRegexValues: async (
      request: Parameters<typeof actual.matchRegexValues>[0],
    ) => {
      const result = await actual.matchRegexValues(request);
      regexMatch.afterSettle?.();
      return result;
    },
  };
});

it.each([
  {
    operation: "search_strings" as const,
    pattern: "^matched$",
    expectedMethod: "search_strings" as const,
    expectedArgs: { pattern: "matched", mode: "literal", case_sensitive: true },
  },
  {
    operation: "search_strings" as const,
    pattern: "^(?:matched|absent)$",
    expectedMethod: "list_strings" as const,
    expectedArgs: {},
  },
  {
    operation: "search_procedures" as const,
    pattern: "^matched$",
    expectedMethod: "search_procedures" as const,
    expectedArgs: { pattern: "matched", mode: "literal", case_sensitive: true },
  },
  {
    operation: "search_procedures" as const,
    pattern: "^(?:matched|absent)$",
    expectedMethod: "list_procedures" as const,
    expectedArgs: {},
  },
])(
  "preserves selected source metadata through the $operation ($expectedMethod) regex boundary",
  async ({ operation, pattern, expectedMethod, expectedArgs }) => {
    const config = parseConfig({});
    if (!config.ok) throw config.error;
    const metadata =
      operation === "search_strings"
        ? {
            provider_value: "short display",
            string: {
              encoding: "utf-8",
              encoding_status: "observed",
              termination: "present_or_not_required",
              byte_length: 7,
            },
          }
        : {
            procedure: { external: false, thunk: true, thunk_target: "0x2" },
          };
    const selected = {
      address: "0x1",
      value: "matched",
      ...metadata,
      provider_metadata: { empty: "", absent: null, zero: 0, flag: false },
    };
    const source = [
      { address: "0x1", value: "different" },
      selected,
      { ...selected, value: "matched alternative" },
    ];
    const originalSource = structuredClone(source);
    const callTool = vi
      .spyOn(HopperClient.prototype, "callTool")
      .mockResolvedValue(ok(source));
    const provider = new HopperProvider(
      config.value,
      silentLogger,
      {},
      "linux",
    );
    const client = provider.createClient({
      path: "/tmp/fixture.hop",
      sha256: "a".repeat(64),
      kind: "database",
      format: "analysis-database",
      databaseEngine: "hopper",
    });
    try {
      const result = await client.execute(operation, {
        pattern,
        mode: "regex",
        case_sensitive: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.result).toEqual([originalSource[1]]);
      expect(callTool).toHaveBeenCalledOnce();
      expect(callTool.mock.calls[0]?.[0]).toBe(expectedMethod);
      expect(callTool.mock.calls[0]?.[1]).toEqual(expectedArgs);
      expect(source).toEqual(originalSource);
    } finally {
      await client.close();
      callTool.mockRestore();
    }
  },
);

it.each([
  { operation: "search_strings" as const, pattern: "matched" },
  { operation: "search_strings" as const, pattern: "^[a-z]+$" },
  { operation: "search_procedures" as const, pattern: "matched" },
  { operation: "search_procedures" as const, pattern: "^[a-z]+$" },
])(
  "rejects malformed canonical metadata in the $operation ($pattern) inventory",
  async ({ operation, pattern }) => {
    // The client validates each reply against its method contract.
    const search = new HopperRegexSearch({
      callTool: async (method, _arguments, options) =>
        parseHopperReply(
          hopperReplySchemas,
          method,
          [
            {
              address: "0x1",
              value: "matched",
              ...(operation === "search_strings"
                ? { string: { encoding: false } }
                : { procedure: { external: "unknown" } }),
            },
          ],
          options?.operation ?? method,
        ),
    });
    try {
      expect(
        await search.execute(operation, {
          pattern,
          mode: "regex",
          case_sensitive: true,
        }),
      ).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisOutputError", operation },
      });
    } finally {
      await search.close();
    }
  },
);

it.each(
  (["search_strings", "search_procedures"] as const).flatMap((operation) =>
    (["remote", "capability", "timeout", "process"] as const).flatMap(
      (family) =>
        (["pushdown", "fallback"] as const).map((route) => ({
          operation,
          family,
          route,
        })),
    ),
  ),
)(
  "attributes $family $route inventory failure to accepted $operation with live cleanup",
  async ({ operation, family, route }) => {
    const inventory =
      route === "pushdown"
        ? operation
        : operation === "search_strings"
          ? "list_strings"
          : "list_procedures";
    const pattern = route === "pushdown" ? "fixture" : "fixture|other";
    const diagnostics = {
      provider_request: { operation: inventory, request_id: 17 },
    };
    const context = {
      diagnostics,
      cleanup: {
        reason: "controlled close refusal",
        resources: ["exact-owner"],
      },
      capturedOutput: {
        stdout: "retained stdout",
        stderr: "retained stderr",
        truncated: false,
      },
    };
    const original = {
      remote: () =>
        new HopperRemoteError(-32000, "fixture inventory unavailable", {
          ...context,
          operation: inventory,
          requestId: 17,
          diagnosticType: "bridge_exception",
        }),
      capability: () =>
        new AnalysisCapabilityUnavailableError(
          "hopper",
          inventory,
          "fixture API unavailable",
          context,
        ),
      timeout: () =>
        new HopperTimeoutError(
          42,
          inventory,
          17,
          "busy",
          "analysis",
          undefined,
          context,
        ),
      process: () =>
        new HopperProcessError(7, {
          ...context,
          operation: inventory,
          requestId: 17,
          providerState: "exited",
          stage: "analysis",
        }),
    }[family]();
    const search = new HopperRegexSearch({
      callTool: async (name) => {
        expect(name).toBe(inventory);
        return err(original);
      },
    });
    try {
      const result = await search.execute(operation, {
        pattern,
        mode: "regex",
        case_sensitive: false,
      });
      if (result.ok) throw new Error("Expected inventory failure");
      expect(projectAnalysisError(result.error).details).toMatchObject({
        operation,
      });
      expect(result.error._tag).toBe(original._tag);
      if (original instanceof AnalysisCapabilityUnavailableError)
        expect(result.error.diagnostics).toEqual(diagnostics);
      else
        expect(result.error.diagnostics).toMatchObject({
          provider_request: { operation: inventory, request_id: 17 },
          provider_diagnostics: diagnostics,
        });
      expect(result.error.capturedOutput).toEqual(context.capturedOutput);
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toEqual(["exact-owner"]);
      if (result.error instanceof HopperRemoteError)
        expect(result.error).toMatchObject({
          code: -32000,
          safeMessage: "fixture inventory unavailable",
          diagnosticType: "bridge_exception",
          requestId: 17,
        });
      if (result.error instanceof HopperTimeoutError)
        expect(result.error).toMatchObject({
          timeoutMs: 42,
          requestId: 17,
          providerState: "busy",
          stage: "analysis",
        });
      if (result.error instanceof HopperProcessError)
        expect(result.error).toMatchObject({
          exitCode: 7,
          requestId: 17,
          providerState: "exited",
          stage: "analysis",
        });
      expect(original.operation).toBe(inventory);
      releaseOwnedCleanup(original);
      expect(result.error.cleanupIncomplete).toBe(false);
    } finally {
      await search.close();
    }
  },
);

it.each([false, true])(
  "joins an active search on close and preserves earlier caller cancellation: %s",
  async (callerFirst) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const search = new HopperRegexSearch({
      callTool: async () => {
        await gate;
        return ok([]);
      },
    });
    const pending = search.execute(
      "search_strings",
      { pattern: "fixture", mode: "regex", case_sensitive: false },
      { signal: controller.signal },
    );
    if (callerFirst) controller.abort("caller stopped");
    let finished = false;
    const closing = search.close().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    expect(await pending).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        cause: callerFirst ? "caller stopped" : OwnerCancellation.ownerClosed,
      },
    });
    await closing;
    expect(finished).toBe(true);
  },
);

it.each(
  [null, "caller stopped", { requested: "stop" }].flatMap((reason) =>
    (["inventory", "progress"] as const).map((stage) => ({ reason, stage })),
  ),
)(
  "keeps the exact reason at $stage completion cancellation",
  async ({ reason, stage }) => {
    const controller = new AbortController();
    const search = new HopperRegexSearch({
      callTool: async () => {
        if (stage === "inventory") controller.abort(reason);
        return ok([]);
      },
    });
    try {
      expect(
        await search.execute(
          "search_strings",
          { pattern: "fixture", mode: "regex", case_sensitive: false },
          {
            signal: controller.signal,
            progress: {
              report: async () => {
                if (stage === "progress") controller.abort(reason);
              },
            },
          },
        ),
      ).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisCancelledError", cause: reason },
      });
    } finally {
      await search.close();
    }
  },
);

it("preserves an inventory failure when cancellation arrives after the physical outcome", async () => {
  const controller = new AbortController();
  const failure = new HopperRemoteError(-32000, "inventory failed", {
    operation: "list_strings",
    requestId: 17,
    diagnosticType: "bridge_exception",
  });
  const search = new HopperRegexSearch({
    callTool: async () => {
      controller.abort("late cancellation");
      return err(failure);
    },
  });
  try {
    const result = await search.execute(
      "search_strings",
      { pattern: "fixture", mode: "regex", case_sensitive: false },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "HopperRemoteError",
        operation: "search_strings",
        cause: failure,
      },
    });
  } finally {
    await search.close();
  }
});

it("returns cancellation when the caller aborts after the regex worker settles", async () => {
  const controller = new AbortController();
  const reason = { request: "stop search" };
  regexMatch.afterSettle = () => controller.abort(reason);
  const search = new HopperRegexSearch({
    callTool: async () => ok([{ address: "0x1000", value: "fixture" }]),
  });
  try {
    const result = await search.execute(
      "search_strings",
      { pattern: "fixture", mode: "regex", case_sensitive: false },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
  } finally {
    regexMatch.afterSettle = undefined;
    await search.close();
  }
});

it("selects sparse matched inventory rows by direct index without altering row identity or order", async () => {
  const rows = Array.from({ length: 256 }, (_, index) => ({
    address: `0x${(0x1000 + index * 4).toString(16)}`,
    value:
      index === 3 || index === 127 || index === 250
        ? `target_hit_${index}`
        : "unrelated_entry",
    provider_value: `display_${index}`,
  }));
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const search = new HopperRegexSearch({
    callTool: async (method, args) => {
      calls.push({ method, args });
      return ok(rows);
    },
  });
  try {
    const matched = await search.execute("search_strings", {
      pattern: "^target_hit_\\d+$",
      mode: "regex",
      case_sensitive: true,
    });
    expect(matched.ok).toBe(true);
    if (matched.ok) {
      const selected = matched.value as typeof rows;
      expect(selected).toHaveLength(3);
      expect(selected[0]).toBe(rows[3]);
      expect(selected[1]).toBe(rows[127]);
      expect(selected[2]).toBe(rows[250]);
    }
    expect(calls[0]).toEqual({
      method: "search_strings",
      args: { pattern: "target_hit_", mode: "literal", case_sensitive: true },
    });
    const empty = await search.execute("search_strings", {
      pattern: "^[0-9]+$",
      mode: "regex",
      case_sensitive: true,
    });
    expect(empty).toEqual(ok([]));
    expect(calls[1]).toEqual({ method: "list_strings", args: {} });
  } finally {
    await search.close();
  }
});
