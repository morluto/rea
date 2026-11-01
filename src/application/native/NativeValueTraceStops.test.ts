import { describe, expect, it } from "vitest";
import type { AnalysisOperationPort } from "../AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import { nativeValueTraceSchema } from "../../domain/native/nativeValueTrace.js";
import {
  CLEANUP_STOPPED_VALUE_TRACE,
  traceNativeValues,
} from "./NativeValueTrace.js";
import {
  failingValueTraceReads,
  valueTraceDiamond,
  valueTraceProvider as provider,
  VALUE_TRACE_DIAMOND_READS,
  type ValueTraceDiamondRead,
} from "./NativeValueTrace.fixture.js";

describe("native value trace child stops", () => {
  const cleanup = {
    cleanup: { reason: "cleanup proof refused", resources: ["owned worker"] },
  };
  const operationOf = (read: ValueTraceDiamondRead) =>
    read.startsWith("analyze_function")
      ? "analyze_function"
      : "resolve_native_call_targets";
  const childReads = [
    "resolve_native_call_targets:0x1004",
    "analyze_function:0x2000",
  ] as const;
  const readsThrough = (read: ValueTraceDiamondRead) =>
    VALUE_TRACE_DIAMOND_READS.slice(
      0,
      VALUE_TRACE_DIAMOND_READS.indexOf(read) + 1,
    );

  it.each(childReads)(
    "returns a cancelled %s read without a partial trace",
    async (read) => {
      const cancelled = new AnalysisCancelledError(operationOf(read));
      const { port, reads } = failingValueTraceReads(valueTraceDiamond().port, {
        [read]: cancelled,
      });

      const result = await traceNativeValues(port, {
        procedure: "0x1000",
        max_depth: 1,
      });

      expect(result).toStrictEqual({ ok: false, error: cancelled });
      expect(reads).toEqual(readsThrough(read));
    },
  );

  it.each(
    childReads.flatMap((read) =>
      (["caller abort", "cancelled read"] as const).map((race) => ({
        read,
        race,
      })),
    ),
  )(
    "keeps unconfirmed cleanup primary over a $race at $read",
    async ({ read, race }) => {
      const controller = new AbortController();
      const failure =
        race === "cancelled read"
          ? new AnalysisCancelledError(operationOf(read), cleanup)
          : new AnalysisCapabilityUnavailableError(
              provider.id,
              operationOf(read),
              "controlled child failure",
              cleanup,
            );
      const { port, reads } = failingValueTraceReads(valueTraceDiamond().port, {
        [read]: failure,
      });
      // The caller aborts while the failing read settles.
      const aborting: AnalysisOperationPort = {
        execute: async (operation, parameters, options) => {
          const selector = `${operation}:${String(parameters.procedure ?? parameters.address)}`;
          if (selector === read) controller.abort("caller stopped the trace");
          return port.execute(operation, parameters, options);
        },
      };

      const result = await traceNativeValues(
        aborting,
        { procedure: "0x1000", max_depth: 1 },
        controller.signal,
      );

      expect(reads).toEqual(readsThrough(read));
      if (result.ok || !("partialResult" in result))
        throw new Error("Expected a stopped trace with its admitted result");
      expect(result.error).toBe(failure);
      expect(nativeValueTraceSchema.parse(result.partialResult)).toMatchObject({
        procedures: [{ address: "0x1000" }],
        traversal: { status: "truncated", reasons: ["cleanup_incomplete"] },
        truncated: true,
      });
    },
  );

  it("records the stop as a located unknown in the admitted trace", async () => {
    const failure = new AnalysisCapabilityUnavailableError(
      provider.id,
      "resolve_native_call_targets",
      "controlled child failure",
      cleanup,
    );
    const { port } = failingValueTraceReads(valueTraceDiamond().port, {
      "resolve_native_call_targets:0x1008": failure,
    });

    const result = await traceNativeValues(port, {
      procedure: "0x1000",
      max_depth: 1,
    });

    if (result.ok || !("partialResult" in result))
      throw new Error("Expected a stopped trace with its admitted result");
    const admitted = nativeValueTraceSchema.parse(result.partialResult);
    // 0x2000 was queued from 0x1004 but never analyzed; the stop, not a depth
    // limit, accounts for it, and the admitted call edge to it remains.
    expect(admitted.traversal).toEqual({
      status: "truncated",
      reasons: ["cleanup_incomplete"],
    });
    expect(admitted.unknowns.filter(({ address }) => address !== null)).toEqual(
      [
        {
          procedure: "0x1000",
          address: "0x1008",
          reason: CLEANUP_STOPPED_VALUE_TRACE,
        },
      ],
    );
    expect(admitted.edges).toContainEqual(
      expect.objectContaining({ kind: "call", target: "0x2000" }),
    );
  });
});
