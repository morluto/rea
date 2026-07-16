import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
} from "../src/contracts/javascriptApplicationWorkflowExamples.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";

describe("application workflow MCP parity", () => {
  it("traces and compares authenticated graph Evidence in the session", async () => {
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session);
    const client = new Client({
      name: "application-workflow-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const traced = await client.callTool({
        name: "trace_application_feature",
        arguments: JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      });
      expect(traced.isError).not.toBe(true);
      expect(traced.structuredContent).toMatchObject({
        operation: "trace_application_feature",
        provider: { id: "rea-javascript-application-workflows" },
        normalized_result: {
          schema_version: 1,
          coverage: { status: expect.any(String) },
        },
      });

      const compared = await client.callTool({
        name: "compare_application_versions",
        arguments: {
          ...JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
          unknown_registry_approved: true,
        },
      });
      expect(compared.isError).not.toBe(true);
      expect(compared.structuredContent).toMatchObject({
        operation: "compare_application_versions",
        normalized_result: {
          schema_version: 1,
          summary: { unknown: expect.any(Number) },
          coverage: { status: expect.any(String) },
        },
      });
      expect(session.exportEvidenceBundle().records.length).toBeGreaterThan(2);

      const spoofed = await client.callTool({
        name: "trace_application_feature",
        arguments: {
          ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
          application: {
            ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application,
            provider: { id: "spoofed", name: "spoofed", version: "1" },
          },
        },
      });
      expect(spoofed.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  });
});
