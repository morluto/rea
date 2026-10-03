import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CATALOG_IDENTITY } from "../../../src/catalogIdentity.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";

const mainPath = fileURLToPath(
  new URL("../../../dist/main.js", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL("../../fixtures/fakeLauncher.mjs", import.meta.url),
);

const expectAvailableToolInventory = async (client: Client): Promise<void> => {
  const listed = await client.listTools();
  const status = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  const availability = z
    .object({
      result: z.object({
        tool_availability: z.array(
          z.object({ name: z.string(), available: z.boolean() }),
        ),
      }),
    })
    .parse(status.structuredContent).result.tool_availability;
  // This asserts the compiled entrypoint matches the source catalog. When it
  // fails, check that `dist/` is current (`npm run build:cached`) before
  // suspecting a registration bug -- a stale build is by far the likeliest
  // cause of a pure count mismatch here.
  expect(
    availability.length,
    "compiled tool inventory is stale; run npm run build:cached",
  ).toBe(CATALOG_IDENTITY.counts.mcp_tools);
  expect(new Set(listed.tools.map(({ name }) => name))).toEqual(
    new Set(TOOL_CONTRACTS.map(({ name }) => name)),
  );
};

/**
 * Parses complete newline-delimited records, dropping any partial trailing
 * line so a chunk boundary cannot turn into a JSON parse error.
 */
const completeStderrRecords = (stderr: string): unknown[] =>
  stderr
    .split("\n")
    .slice(0, -1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line): unknown => JSON.parse(line));

describe("production stdio runtime", () => {
  it("starts the built entrypoint, lists the catalog, calls one, and shuts down", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mainPath],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOPPER_LAUNCHER_PATH: process.execPath,
        HOPPER_TARGET_PATH: process.execPath,
        HOPPER_LOADER_ARGS_JSON: JSON.stringify([fixturePath]),
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: "runtime-smoke", version: "1.0.0" });

    try {
      await client.connect(transport);
      await expectAvailableToolInventory(client);
      const result = await client.callTool({
        name: "current_document",
        arguments: {},
      });
      expect(result.isError === true).toBe(process.platform === "linux");
    } finally {
      await client.close();
      await transport.close();
    }
    const records = completeStderrRecords(stderr);
    expect(records).toContainEqual(
      expect.objectContaining({
        application: "rea",
        mode: "mcp",
        layer: "server",
        tool: "current_document",
        status: process.platform === "linux" ? "error" : "ok",
      }),
    );
    expect(stderr).not.toContain("HOPPER_LOADER_ARGS_JSON");
    expect(stderr).not.toContain(fixturePath);
  }, 15_000);

  it("starts with a database-kind initial target without a fatal record", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mainPath],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOPPER_LAUNCHER_PATH: process.execPath,
        HOPPER_TARGET_PATH: new URL(import.meta.url).pathname,
        HOPPER_TARGET_KIND: "database",
        HOPPER_LOADER_ARGS_JSON: JSON.stringify([fixturePath]),
      },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    const client = new Client({ name: "database-runtime", version: "1.0.0" });

    try {
      await client.connect(transport);
      // The catalog itself is already proven against the compiled entrypoint
      // above, so this test asserts the part that is unique to a database-kind
      // initial target: the server comes up and serves tools without a fatal
      // startup record.
      const listed = await client.listTools();
      expect(listed.tools.length).toBeGreaterThan(0);
      // A database-kind initial target must also serve a tool. Merely listing
      // the catalog starts no bridge work, so without this call the child
      // writes no startup records at all and the fatal-record assertion below
      // would pass without observing anything.
      await expect(
        client.callTool({ name: "current_document", arguments: {} }),
      ).resolves.toBeDefined();
    } finally {
      await client.close();
      await transport.close();
    }
    // The transport has closed, so the stderr pipe has ended and every record
    // the child wrote has been delivered. Reading while the child is still
    // running races the pipe and can observe an empty or partial buffer, which
    // would silently miss the fatal record this test exists to catch.
    const records = completeStderrRecords(stderr);
    expect(
      records.length,
      "no startup records were observed, so the fatal-record check is vacuous",
    ).toBeGreaterThan(0);
    const fatal = records.filter(
      (record): record is { level: number } =>
        typeof record === "object" &&
        record !== null &&
        "level" in record &&
        typeof record.level === "number" &&
        record.level >= 50,
    );
    expect(fatal).toEqual([]);
  }, 15_000);
});
