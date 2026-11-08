import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { expect, it, onTestFinished } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

it("advertises an object root for every tool output schema", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  // Ambient catalog, family, or output-profile settings could hide schemas;
  // the defaults advertise every tool with its full output schema.
  const server = createServer(
    { kind: "session", session },
    { environment: {} },
  );
  // 2026-07-28 advertises each projection unchanged. The 2025 codec wraps a
  // typeless root in {result}, which hides the defect from this listing while
  // clients that wrap only the schema reject the bare structured content.
  const client = new Client(
    { name: "advertised-output-roots", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => server, { transport: serverTransport });
  onTestFinished(async () => {
    await client.close();
    await serving.close();
    await session.close();
  });
  await client.connect(clientTransport);
  expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

  const tools = (await client.listTools()).tools;
  expect(tools.map(({ name }) => name).sort()).toEqual(
    TOOL_CONTRACTS.map(({ name }) => name).sort(),
  );
  // A union whose members are shared $defs references cannot be proven
  // object-shaped by the SDK; declare it with .meta({ type: "object" }).
  expect(
    tools.flatMap(({ name, outputSchema }) =>
      outputSchema?.type === "object" ? [] : [name],
    ),
  ).toEqual([]);
});
