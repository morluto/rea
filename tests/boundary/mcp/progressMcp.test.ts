import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

import { withVerifierCleanup } from "../../../scripts/lib/verifier-cleanup.mjs";

import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../src/ports/AnalysisProvider.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { err, ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { ToolResultDelivery } from "../../../src/server/ToolResultDelivery.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { phaseGate } from "../../support/lifecycleHarness.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const testClient = (name: string) =>
  new Client(
    { name, version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );

it.each(["current_address", "analyze_function"] as const)(
  "reports failed when %s completes analysis but its response cannot be delivered",
  async (name) => {
    const analysis: AnalysisOperationPort = {
      execute: async (operation, _parameters, options) => {
        await options?.progress?.report({
          phase: "native",
          completed: 1,
          total: 1,
          message: "observation complete",
          terminal: true,
        });
        return observed(
          operation === "analyze_function"
            ? FUNCTION_COMPARISON_EXAMPLE.left.normalized_result
            : "0x1000",
        );
      },
    };
    const server = createServer(
      { kind: "fixed", analysis },
      { delivery: new ToolResultDelivery(1024) },
    );
    const client = testClient("delivery-progress-test");
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const messages: Array<string | undefined> = [];
    await withVerifierCleanup(async () => {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool(
        {
          name,
          arguments:
            name === "analyze_function"
              ? { procedure: "main", detail: "complete" }
              : {},
        },
        { onprogress: ({ message }) => messages.push(message) },
      );
      expect(response.isError).toBe(true);
      expect(messages).toContain("native: observation complete");
      expect(messages.at(-1)).toBe(`${name}: failed`);
    }, [() => client.close(), () => server.close()]);
  },
);

describe("ordinary MCP progress and cancellation", () => {
  it("advances MCP progress when provider waiting does not advance completed work", async () => {
    const analysis: AnalysisOperationPort = {
      execute: async (_operation, _parameters, options) => {
        for (const message of ["import pending", "analysis pending"]) {
          await delay(120);
          await options?.progress?.report({
            phase: "ghidra_startup",
            completed: 0,
            total: null,
            message,
          });
        }
        return observed("0x1000");
      },
    };
    const server = createServer({ kind: "fixed", analysis });
    const client = testClient("progress-test");
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const progress: {
      progress: number;
      total?: number | undefined;
      message?: string | undefined;
    }[] = [];
    await withVerifierCleanup(async () => {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool(
        { name: "current_address", arguments: {} },
        { onprogress: (update) => progress.push(update) },
      );

      expect(result.isError).not.toBe(true);
      expect(progress[0]?.progress).toBe(1);
      expect(progress.map((update) => update.message)).toEqual(
        expect.arrayContaining([
          "ghidra_startup: import pending",
          "ghidra_startup: analysis pending",
        ]),
      );
      expect(progress.at(-1)?.message).toContain("completed");
      progress.forEach((update, index) => {
        expect(update.progress).toBeGreaterThan(
          progress[index - 1]?.progress ?? 0,
        );
        expect(update.total).toBeUndefined();
      });
    }, [() => client.close(), () => server.close()]);
  });

  it("keeps analyze_function progress strictly increasing from start to completion", async () => {
    const analysis: AnalysisOperationPort = {
      execute: (operation) =>
        Promise.resolve(
          ok(
            createAnalysisExecution(
              operation === "analyze_function"
                ? FUNCTION_COMPARISON_EXAMPLE.left.normalized_result
                : "0x1000",
              { id: "fixture", name: "Fixture", version: "1" },
            ),
          ),
        ),
    };
    const server = createServer({ kind: "fixed", analysis });
    const client = testClient("function-progress-test");
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const progress: number[] = [];
    await withVerifierCleanup(async () => {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool(
        {
          name: "analyze_function",
          arguments: { procedure: "main", detail: "complete" },
        },
        { onprogress: (update) => progress.push(update.progress) },
      );

      expect(result.isError).not.toBe(true);
      expect(progress.length).toBeGreaterThanOrEqual(2);
      progress.forEach((value, index) => {
        expect(value).toBeGreaterThan(progress[index - 1] ?? 0);
      });
    }, [() => client.close(), () => server.close()]);
  });

  it("propagates client cancellation to the active provider request", async () => {
    let providerObservedCancellation = false;
    let providerWasStarted = false;
    let markProviderFinished!: () => void;
    const providerFinished = new Promise<void>((resolve) => {
      markProviderFinished = resolve;
    });
    const providerRequest = phaseGate();
    const analysis: AnalysisOperationPort = {
      execute: async (operation, _parameters, options) => {
        const onAbort = () => {
          providerObservedCancellation = true;
          providerRequest.release();
        };
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        providerWasStarted = true;
        try {
          await providerRequest.hold();
          return err(new AnalysisCancelledError(operation));
        } finally {
          options?.signal?.removeEventListener("abort", onAbort);
          markProviderFinished();
        }
      },
    };
    const server = createServer({ kind: "fixed", analysis });
    const client = testClient("cancellation-test");
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const controller = new AbortController();
    await withVerifierCleanup(async () => {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const request = client.callTool(
        { name: "current_address", arguments: {} },
        { signal: controller.signal },
      );
      await providerRequest.reached(request, "provider request");
      controller.abort();
      await expect(request).rejects.toThrow(/abort/iu);
      await expect.poll(() => providerObservedCancellation).toBe(true);
    }, [
      async () => {
        providerRequest.release();
        if (providerWasStarted) await providerFinished;
      },
      () => client.close(),
      () => server.close(),
    ]);
  });
});
