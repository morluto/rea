import { describe, expect, it } from "vitest";

import { runDerivedOperation } from "./runDerivedOperation.js";
import { EvidenceIntegrityError } from "../domain/evidenceErrors.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../contracts/functionComparisonExample.js";
import { EvidenceLedger } from "../application/investigation/EvidenceLedger.js";
import { retainAnalysisResultSources } from "../application/investigation/recordEvidenceSources.js";

const context = (
  controller: AbortController,
  notifications: unknown[] = [],
) => ({
  mcpReq: {
    signal: controller.signal,
    _meta: { progressToken: "derived-test" },
    notify: (notification: unknown) => {
      notifications.push(notification);
      return Promise.resolve();
    },
  },
});

describe("derived MCP operation boundary", () => {
  it("retains completed Evidence when cancellation wins during terminal progress delivery", async () => {
    const controller = new AbortController();
    const reason = { requested: "completed-evidence-stop" };
    const source = FUNCTION_COMPARISON_EXAMPLE.left;
    const completed = {
      evidence: FUNCTION_COMPARISON_EXAMPLE.right,
      sources: [source],
    };
    const result = await runDerivedOperation(
      {
        mcpReq: {
          ...context(controller).mcpReq,
          notify: async (notification) => {
            if (notification.params?.message !== "complete: Completed compare")
              return;
            await Promise.resolve();
            controller.abort(reason);
          },
        },
      },
      "compare",
      () => completed,
      (value) => value,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "compare",
        cause: reason,
        partialObservation: completed.evidence,
      },
      sourceEvidence: [source],
    });
    const ledger = new EvidenceLedger();
    const retained = retainAnalysisResultSources(
      "compare",
      ledger.record.bind(ledger),
      result,
    );
    expect(retained.ok).toBe(false);
    expect(ledger.has(source.evidence_id)).toBe(true);
    expect(retained.ok ? undefined : retained.error.cause).toBe(reason);
  });
});

describe("derived MCP operation progress and cancellation", () => {
  it("cancels before computation and never evaluates the operation", async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ requested: "pre-compute-stop" });
    controller.abort(reason);
    let computed = false;
    const result = await runDerivedOperation(
      context(controller),
      "compare",
      () => {
        computed = true;
        return "impossible";
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(result.ok ? undefined : result.error.cause).toBe(reason);
    expect(computed).toBe(false);
  });

  it("preserves the request's abort reason when cancellation wins after computation", async () => {
    const controller = new AbortController();
    const reason = Object.freeze({ requested: "post-compute-stop" });
    const result = await runDerivedOperation(
      context(controller),
      "compare",
      () => {
        controller.abort(reason);
        return "must-not-publish";
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(result.ok ? undefined : result.error.cause).toBe(reason);
  });

  it("emits monotonic progress with one terminal state", async () => {
    const controller = new AbortController();
    const notifications: Array<{
      params?: { progress?: number; total?: number; message?: string };
    }> = [];
    const result = await runDerivedOperation(
      context(controller, notifications),
      "compare",
      () => "complete",
    );

    expect(result).toEqual({ ok: true, value: "complete" });
    const messages = notifications.map(({ params }) => params?.message);
    expect(messages[0]).toBe("prepare: Preparing compare");
    expect(messages.slice(1, -1)).toEqual(
      messages.length === 3 ? ["compute: Computed compare"] : [],
    );
    expect(messages.at(-1)).toBe("complete: Completed compare");
    expect(notifications.map(({ params }) => params?.progress)).toEqual(
      notifications.map((_notification, index) => index + 1),
    );
    expect(
      notifications.every(({ params }) => params?.total === undefined),
    ).toBe(true);
  });

  it.each([
    new TypeError("internal type failure"),
    new Error("internal computation failure"),
  ])(
    "preserves an untagged computation failure without calling it invalid input: $name",
    async (cause) => {
      await expect(
        runDerivedOperation(
          context(new AbortController()),
          "compare_artifacts",
          () => {
            throw cause;
          },
        ),
      ).rejects.toBe(cause);
    },
  );

  it("preserves a tagged integrity failure instead of replacing it with invalid input", async () => {
    const failure = new EvidenceIntegrityError(
      "Source Evidence does not match its digest",
    );
    const result = await runDerivedOperation(
      context(new AbortController()),
      "compare_artifacts",
      () => {
        throw failure;
      },
    );
    expect(result).toEqual({ ok: false, error: failure });
  });
});
