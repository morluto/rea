import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../src/application/AnalysisProvider.js";
import { AnalysisCancelledError } from "../src/domain/errors.js";
import { err } from "../src/domain/result.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";

describe("ordinary MCP progress and cancellation", () => {
  it("emits bounded progress for a normal tool request", async () => {
    const analysis: AnalysisOperationPort = {
      execute: () => Promise.resolve(observed("0x1000")),
    };
    const server = createServer(analysis);
    const client = new Client({ name: "progress-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const progress: number[] = [];
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool(
        { name: "current_address", arguments: {} },
        { onprogress: (update) => progress.push(update.progress) },
      );

      expect(result.isError).not.toBe(true);
      expect(progress).toEqual([0, 1]);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("propagates client cancellation to the active provider request", async () => {
    let providerObservedCancellation = false;
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const analysis: AnalysisOperationPort = {
      execute: async (operation, _parameters, options) => {
        markProviderStarted?.();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              providerObservedCancellation = true;
              resolve();
            },
            { once: true },
          );
        });
        return err(new AnalysisCancelledError(operation));
      },
    };
    const server = createServer(analysis);
    const client = new Client({ name: "cancellation-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const controller = new AbortController();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const request = client.callTool(
        { name: "current_address", arguments: {} },
        { signal: controller.signal },
      );
      await providerStarted;
      controller.abort();
      await expect(request).rejects.toThrow(/abort/iu);
      await expect.poll(() => providerObservedCancellation).toBe(true);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
