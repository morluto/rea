import { describe, expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  cancelledBy,
  isAborted,
} from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import {
  UPCOMING_DECOMPILES_WINDOW,
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../ports/AnalysisProvider.js";
import { EnhancedTools } from "./EnhancedTools.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

interface PseudocodeRequest {
  readonly procedure: string;
  readonly upcoming: readonly string[] | undefined;
}

/** Port that resolves `fn_N` to its address and rejects `nosuch`. */
const recordingPort = (onPseudocode?: (procedure: string) => void) => {
  const requests: PseudocodeRequest[] = [];
  const port: AnalysisOperationPort = {
    execute: async (operation, parameters, options) => {
      const selector = String(parameters.procedure ?? parameters.address);
      if (operation === "procedure_address") {
        if (selector === "nosuch")
          return err(new AnalysisInputError(operation));
        return ok(createAnalysisExecution(selector, provider));
      }
      if (operation === "address_name")
        return ok(createAnalysisExecution(`name_${selector}`, provider));
      if (operation === "procedure_pseudo_code") {
        requests.push({
          procedure: selector,
          upcoming: options?.upcomingDecompiles,
        });
        onPseudocode?.(selector);
        const signal = options?.signal;
        if (isAborted(signal)) return err(cancelledBy(operation, signal));
        return ok(createAnalysisExecution(`code ${selector}`, provider));
      }
      throw new Error(`Unexpected operation: ${operation}`);
    },
  };
  return { requests, tools: new EnhancedTools(port) };
};

const addresses = (count: number): string[] =>
  Array.from(
    { length: count },
    (_, index) => `0x${(0x1000 + index * 0x10).toString(16)}`,
  );

describe("batch_decompile read-ahead", () => {
  it("names each later item once, in windows that start with the carried request", async () => {
    // A duplicate and an unresolved selector stay in order; the provider
    // decides what it can prepare and every item still sends its own request.
    const selectors = [...addresses(40), "0x1000", "nosuch", ...addresses(3)];
    const { requests, tools } = recordingPort();

    const result = await tools.executeValidated({
      name: "batch_decompile",
      input: { addresses: selectors },
    });

    expect(result.ok, "the batch completes").toBe(true);
    expect(
      requests.map((request) => request.procedure),
      "every item sends its own decompile request in caller order",
    ).toEqual(selectors);
    const windows = requests.flatMap((request, index) =>
      request.upcoming === undefined ? [] : [{ index, ...request }],
    );
    expect(
      windows.map(({ index, upcoming }) => ({ index, upcoming })),
      "a window starts at the request that carries it and names the next items",
    ).toEqual([
      {
        index: 0,
        upcoming: selectors.slice(0, UPCOMING_DECOMPILES_WINDOW),
      },
      {
        index: UPCOMING_DECOMPILES_WINDOW,
        upcoming: selectors.slice(UPCOMING_DECOMPILES_WINDOW),
      },
    ]);
    for (const { procedure, upcoming } of windows)
      expect(upcoming?.[0], "the window's head is its own function").toBe(
        procedure,
      );
  });

  it("sends no window for a single item or the last item of a batch", async () => {
    const single = recordingPort();
    await single.tools.executeValidated({
      name: "batch_decompile",
      input: { addresses: addresses(1) },
    });
    expect(single.requests).toEqual([
      { procedure: "0x1000", upcoming: undefined },
    ]);

    const remainder = recordingPort();
    const selectors = addresses(UPCOMING_DECOMPILES_WINDOW + 1);
    await remainder.tools.executeValidated({
      name: "batch_decompile",
      input: { addresses: selectors },
    });
    expect(
      remainder.requests.at(-1),
      "a one-item remainder decompiles alone",
    ).toEqual({ procedure: selectors.at(-1), upcoming: undefined });
  });

  it("sends no further requests after cancellation during a window", async () => {
    const controller = new AbortController();
    const { requests, tools } = recordingPort(() => controller.abort());

    const result = await tools.executeValidated(
      { name: "batch_decompile", input: { addresses: addresses(10) } },
      controller.signal,
    );

    expect(result.ok, "the cancelled batch is not reported complete").toBe(
      false,
    );
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(controller.signal.reason);
    expect(
      requests.map((request) => request.procedure),
      "only the window's carrying request reached the provider",
    ).toEqual(["0x1000"]);
  });
});
