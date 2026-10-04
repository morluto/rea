import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";

import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { HopperRemoteError } from "../../../src/domain/errors.js";
import { err } from "../../../src/domain/result.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
});

const connect = async (analysis: AnalysisOperationPort) => {
  const server = createServer(analysis);
  const client = new Client({
    name: "integration-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const text = (result: CallToolResult): string => {
  const content = result.content.find((item) => item.type === "text");
  if (content?.type !== "text") throw new Error("missing text result");
  return content.text;
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return Object.fromEntries(Object.entries(result.structuredContent));
};

it("projects remote failures without provider or bridge details", async () => {
  const client = await connect({
    execute: () =>
      Promise.resolve(err(new HopperRemoteError(-32000, "bridge timeout"))),
  });

  const result = await client.callTool({
    name: "list_documents",
    arguments: {},
  });
  expect(result.isError).toBe(true);
  expect(structured(result)).toMatchObject({
    error: {
      category: "execution_failure",
    },
  });
  expect(text(result)).toBe(JSON.stringify(result.structuredContent));
});

it("lets the SDK validate a tool call before invoking its handler", async () => {
  let invocations = 0;
  const client = await connect({
    execute: () => {
      invocations += 1;
      return Promise.resolve(ok([]));
    },
  });

  const malformed = await client.callTool({
    name: "procedure_info",
    arguments: {},
  });

  expect(malformed.isError).toBe(true);
  expect(invocations).toBe(0);

  const valid = await client.callTool({
    name: "list_documents",
    arguments: {},
  });
  expect(valid.isError).not.toBe(true);
  expect(invocations).toBe(1);
});

it("preserves distinct results across concurrent tool calls", async () => {
  const payloads = new Map([
    ["list_procedures", [{ address: "0x1000", value: "fixture_main" }]],
    ["list_strings", [{ address: "0x2000", value: "fixture text" }]],
    ["list_names", [{ address: "0x3000", value: "fixture_global" }]],
  ]);
  const pending = new Map<string, () => void>();
  let allStarted: () => void = () => {
    throw new Error("start gate missing");
  };
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  const client = await connect({
    execute: async (name) => {
      const payload = payloads.get(name);
      if (payload === undefined)
        throw new Error(`Unexpected operation: ${name}`);
      await new Promise<void>((resolve) => {
        pending.set(name, resolve);
        if (pending.size === payloads.size) allStarted();
      });
      return ok(payload);
    },
  });
  const names = [...payloads.keys()];
  const requests = names.map((name) =>
    client.callTool({ name, arguments: {} }),
  );
  await started;
  for (const name of [...names].reverse()) {
    const release = pending.get(name);
    if (release === undefined)
      throw new Error("request did not reach provider");
    release();
  }
  const results = await Promise.all(requests);
  results.forEach((result, index) => {
    expect(result.isError).not.toBe(true);
    expect(structured(result)).toMatchObject({
      result: payloads.get(names[index] ?? ""),
    });
  });
});
