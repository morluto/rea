import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, expect } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createServer } from "../../../src/server/createServer.js";
import { silentLogger } from "../../../src/logger.js";
import { itWithCaptureCapability } from "./processCaptureCapability.js";

const processFixture = fileURLToPath(
  new URL("../../fixtures/processFidelity.mjs", import.meta.url),
);
const resources: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

itWithCaptureCapability(
  "records process residuals linked to capture Evidence",
  async () => {
    const session = createTestBinarySession(createCacheProvider([]));
    const server = createServer(
      { kind: "session", session },
      {
        logger: silentLogger,
      },
    );
    const mcp = new Client({ name: "process-unknown", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const captured = await mcp.callTool({
      name: "capture_process_scenario",
      arguments: {
        executable: process.execPath,
        arguments: [processFixture, "partial"],
      },
    });
    expect(captured.isError, JSON.stringify(captured.content)).not.toBe(true);
    const contract = toolContract("capture_process_scenario");
    const wire = (await mcp.listTools()).tools.find(
      ({ name }) => name === contract.name,
    );
    if (wire?.outputSchema === undefined)
      throw new Error("Missing process capture output schema");
    expect(
      new Ajv2020({ strict: false, validateFormats: false }).validate(
        z.record(z.string(), z.unknown()).parse(wire.outputSchema),
        captured.structuredContent,
      ),
    ).toBe(true);
    expect(
      contract.outputSchema.safeParse(captured.structuredContent).success,
    ).toBe(true);
    const listedUnknowns = await mcp.callTool({
      name: "list_unknowns",
      arguments: {},
    });
    expect(
      listedUnknowns.isError,
      JSON.stringify(listedUnknowns.content),
    ).not.toBe(true);
    const listed = z
      .object({
        result: z.object({
          items: z.array(
            z.object({
              question: z.string(),
              domain: z.string(),
            }),
          ),
        }),
      })
      .parse(listedUnknowns.structuredContent).result.items;
    expect(listed).toContainEqual(
      expect.objectContaining({
        question: "Was network behavior fully observed during capture?",
        domain: "process-network",
      }),
    );
  },
);
