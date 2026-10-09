import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { createIdaMcpConnection } from "../../../src/ida/IdaMcpConnection.js";
import type { IdaMcpConnection } from "../../../src/ida/IdaMcpConnection.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z
    .object({
      protocolVersion: z.string().optional(),
      cursor: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
const fixture = async (redirectUrl?: string, cycle = false) => {
  const methods: string[] = [];
  const headers: (string | undefined)[] = [];
  const server = createServer(async (request, response) => {
    if (redirectUrl !== undefined) {
      response.writeHead(307, { Location: redirectUrl });
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const input = requestSchema.parse(JSON.parse(body));
    methods.push(input.method);
    headers.push(request.headers.authorization);
    if (input.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result =
      input.method === "initialize"
        ? {
            protocolVersion: input.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
              name: "ida-transport-fixture",
              version: "observed-server-version",
            },
          }
        : input.method === "tools/list"
          ? {
              tools: [
                {
                  name: input.params?.cursor === undefined ? "first" : "second",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
              ...(input.params?.cursor === undefined
                ? { nextCursor: "next-page" }
                : cycle
                  ? {
                      nextCursor:
                        input.params.cursor === "next-page"
                          ? "other-page"
                          : "next-page",
                    }
                  : {}),
            }
          : { content: [], structuredContent: { observed: true } };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing HTTP fixture address");
  const connection: IdaMcpConnection = createIdaMcpConnection(
    {
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: { Authorization: "Bearer transport-fixture-secret" },
      mode: "headless",
      timeoutMs: 2000,
    },
    {},
  );
  cleanups.push(() => connection.close());
  return {
    connection,
    methods,
    headers,
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
};

it("uses the pinned SDK for a local Streamable HTTP handshake, paged discovery, structured results, and configured authentication", async () => {
  const { connection, methods, headers } = await fixture();
  expect(await connection.connect()).toEqual(["first", "second"]);
  expect(connection.serverInfo()).toEqual({
    name: "ida-transport-fixture",
    version: "observed-server-version",
  });
  expect(await connection.call("first", {})).toEqual({ observed: true });
  expect(methods).toContain("notifications/initialized");
  expect(methods.filter((name) => name === "tools/list")).toHaveLength(2);
  expect(
    headers.every((value) => value === "Bearer transport-fixture-secret"),
  ).toBe(true);
});

it("rejects redirects instead of forwarding transport credentials to another endpoint", async () => {
  const destination = await fixture();
  const { connection } = await fixture(destination.url);
  await expect(connection.connect()).rejects.toThrow();
  expect(destination.headers).toEqual([]);
});

it("rejects nonterminating SDK pagination instead of returning a partial tool catalog", async () => {
  const { connection, methods } = await fixture(undefined, true);
  await expect(connection.connect()).rejects.toThrow(
    "pagination did not terminate",
  );
  expect(
    methods.filter((method) => method === "tools/list").length,
  ).toBeGreaterThan(2);
});
