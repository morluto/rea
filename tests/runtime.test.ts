import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

const mainPath = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const fixturePath = fileURLToPath(
  new URL("./fixtures/fakeLauncher.mjs", import.meta.url),
);

describe("production stdio runtime", () => {
  it("starts the built entrypoint, lists 42 tools, calls one, and shuts down", async () => {
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
      expect(tools.tools).toHaveLength(42);
      const result = await client.callTool({
        name: "current_document",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
    expect(stderr).toBe("");
  });
});
