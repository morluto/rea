import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { onTestFinished } from "vitest";
import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import type { BinaryLayout } from "../../../src/domain/native/binaryLayout.js";
import { ok, type Result } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { analysisViewLayoutFixture } from "../../fixtures/analysisView.js";
import { BINARY_LAYOUT_TEST_PROVIDER } from "../../fixtures/binaryDiagnostics/layout.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

/** Connect an in-memory layout provider whose full result exceeds the minimum budget. */
export const connectBudgetedLayout = async (
  name: string,
  inspect: (layout: BinaryLayout) => Result<BinaryLayout, AnalysisError> = ok,
) => {
  const fixture = analysisViewLayoutFixture();
  // Enough symbol rows to exceed the smallest budget.
  const layout = {
    ...fixture,
    symbols: [
      ...fixture.symbols,
      ...Array.from({ length: 16 }, (_, index) => ({
        ...fixture.symbols[0]!,
        entry_index: fixture.symbols.length + index,
      })),
    ],
  };
  const session = createTestBinarySession(() => {
    throw new Error("Layout inspection must not start a deep provider");
  });
  const server = createServer(
    { kind: "session", session },
    {
      binaryLayout: new BinaryLayoutService({
        inspectAndClose(input, options) {
          return this.inspect(input, options);
        },
        identity: BINARY_LAYOUT_TEST_PROVIDER,
        inspect: () => Promise.resolve(inspect(layout)),
      }),
    },
  );
  const client = new Client(
    { name, version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, target: { path: layout.artifact.path } };
};
