import {
  createServer as createHttpServer,
  type IncomingMessage,
} from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";
import { binaryNinjaFixture } from "../../../src/binaryNinja/BinaryNinja.fixture.js";
import { BinaryNinjaProvider } from "../../../src/binaryNinja/BinaryNinjaProvider.js";
import { parseConfig } from "../../../src/config.js";
import { AnalysisProviderRegistry } from "../../../src/application/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/BinarySessionComposition.js";
import { createServer } from "../../../src/server/createServer.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const exec = promisify(execFile);

it("serves Binary Ninja-backed queries and Evidence through REA's public MCP server", async () => {
  const fixture = await binaryNinjaFixture();
  cleanup.push(fixture.close);
  const session = composeBinarySession(
    new AnalysisProviderRegistry([fixture.provider], "binary-ninja"),
    [],
  );
  cleanup.push(() => session.close().then(() => undefined));
  const server = createServer(session, session);
  const client = new Client({ name: "bn-rea-boundary-test", version: "1" });
  cleanup.push(
    () => server.close(),
    () => client.close(),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  expect(
    (
      await client.callTool({
        name: "open_binary",
        arguments: { path: fixture.target.path, provider_id: "binary-ninja" },
      })
    ).isError,
  ).not.toBe(true);
  const response = await client.callTool({
    name: "procedure_pseudo_code",
    arguments: { procedure: "main" },
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(JSON.stringify(response)).toContain("int main() { return 0; }");
  expect(JSON.stringify(response)).toContain("binary-ninja");
  const overview = await client.callTool({
    name: "binary_overview",
    arguments: {},
  });
  expect(overview.isError).not.toBe(true);
  expect(JSON.stringify(overview)).toContain('"procedure_count":2');
  const dossier = await client.callTool({
    name: "analyze_function",
    arguments: { procedure: "main" },
  });
  expect(dossier.isError).not.toBe(true);
  expect(JSON.stringify(dossier)).toContain("unobserved");
  expect(
    (await client.callTool({ name: "close_binary", arguments: {} })).isError,
  ).not.toBe(true);
  expect(
    fixture.calls.filter(({ name }) => name === "bn_open_item_close"),
  ).toHaveLength(1);
});

const requestFor = async (
  incoming: IncomingMessage,
  url: string,
): Promise<Request> => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected HTTP body chunk");
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers))
    if (value !== undefined)
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  const method = incoming.method ?? "GET";
  return new Request(url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD"
      ? {}
      : { body: Buffer.concat(chunks).toString("utf8") }),
  });
};

it("connects over actual Streamable HTTP with bearer authentication", async () => {
  const fixture = await binaryNinjaFixture();
  cleanup.push(fixture.close);
  const authorizations: Array<string | undefined> = [];
  const http = createHttpServer((incoming, outgoing) => {
    const handle = async () => {
      authorizations.push(incoming.headers.authorization);
      if (incoming.headers.authorization !== "Bearer test-auth-token") {
        outgoing.writeHead(401);
        outgoing.end();
        return;
      }
      const mcpServer = fixture.makeServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);
      try {
        const response = await transport.handleRequest(
          await requestFor(
            incoming,
            `http://127.0.0.1${incoming.url ?? "/mcp"}`,
          ),
        );
        outgoing.writeHead(
          response.status,
          Object.fromEntries(response.headers),
        );
        outgoing.end(await response.text());
      } finally {
        await mcpServer.close();
      }
    };
    handle().catch((error: unknown) => {
      outgoing.writeHead(500);
      outgoing.end(error instanceof Error ? error.message : String(error));
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanup.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((accept, reject) =>
      http.close((error) => (error === undefined ? accept() : reject(error))),
    );
  });
  const bound = http.address();
  if (bound === null || typeof bound === "string")
    throw new Error("No HTTP address");
  const parsed = parseConfig({
    REA_BINARY_NINJA_MCP_URL: `http://127.0.0.1:${bound.port}/mcp`,
    REA_BINARY_NINJA_MCP_TOKEN: "test-auth-token",
    REA_BINARY_NINJA_MCP_TIMEOUT_MS: "2000",
  });
  if (!parsed.ok) throw parsed.error;
  const provider = new BinaryNinjaProvider(parsed.value);
  const resolved = await provider.resolveAnalysisProfile(fixture.target);
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.error));
  if (resolved.value.profile === null) throw new Error("Missing profile");
  const client = provider.createClient(fixture.target, resolved.value.profile);
  cleanup.push(() => client.close());
  expect(
    await client.execute("procedure_pseudo_code", { procedure: "main" }),
  ).toMatchObject({ ok: true, value: { result: "int main() { return 0; }" } });
  expect(authorizations.length).toBeGreaterThan(0);
  expect(
    authorizations.every((value) => value === "Bearer test-auth-token"),
  ).toBe(true);
});

it("selects the backend from environment and decompiles through the packaged CLI over stdio", async () => {
  const fixture = await binaryNinjaFixture();
  cleanup.push(fixture.close);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("REA_BINARY_NINJA_"),
    ),
  );
  const { stdout } = await exec(
    process.execPath,
    [
      "scripts/rea.mjs",
      "decompile",
      fixture.target.path,
      "0x401000",
      "--provider",
      "binary-ninja",
      "--json",
    ],
    {
      cwd: resolve("."),
      timeout: 15_000,
      env: {
        ...env,
        REA_ANALYSIS_PROVIDER: "binary-ninja",
        REA_BINARY_NINJA_MCP_COMMAND: process.execPath,
        REA_BINARY_NINJA_MCP_ARGS_JSON: JSON.stringify([
          resolve("tests/fixtures/binary-ninja-mcp-server.mjs"),
        ]),
        REA_LOG_LEVEL: "silent",
      },
    },
  );
  const result = jsonObjectSchema.parse(JSON.parse(stdout));
  expect(JSON.stringify(result)).toContain("int main() { return 0; }");
  expect(JSON.stringify(result)).toContain("binary-ninja");
});
