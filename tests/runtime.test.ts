import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/fakeLauncher.mjs", import.meta.url),
);

describe("production stdio runtime", () => {
  it("starts the built entrypoint, lists 79 tools, calls one, and shuts down", async () => {
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
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(79);
      const result = await client.callTool({
        name: "current_document",
        arguments: {},
      });
      expect(result.isError === true).toBe(process.platform === "linux");
    } finally {
      await client.close();
      await transport.close();
    }
    const records = stderr
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line: string): unknown => JSON.parse(line));
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

  it("honors the configured kind for an initial database target", async () => {
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
    const client = new Client({ name: "database-runtime", version: "1.0.0" });

    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(79);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 15_000);
});
