import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";
import { silentLogger } from "../../../src/logger.js";
import { registerGdbTools } from "../../../src/server/registerGdbTools.js";
import { registerRizinDebugTools } from "../../../src/server/registerRizinDebugTools.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";

const waitForFile = async (path: string): Promise<void> => {
  await expect
    .poll(() => readFile(path, "utf8").catch(() => ""))
    .toBe("started");
};

const validateStatusResponse = async (
  client: Client,
  name: "gdb_session_status" | "rizin_debug_session_status",
  sessionId: string,
): Promise<Record<string, unknown>> => {
  const listed = (await client.listTools()).tools.find(
    (tool) => tool.name === name,
  );
  if (listed?.outputSchema === undefined)
    throw new Error(`Missing advertised ${name} output schema`);
  const response = await client.callTool({
    name,
    arguments: { session_id: sessionId },
  });
  expect(response.isError).not.toBe(true);
  const contract = toolContract(name);
  const parsed = contract.outputSchema.parse(response.structuredContent);
  expect(
    new Ajv2020({ strict: false, validateFormats: false }).validate(
      z.record(z.string(), z.unknown()).parse(listed.outputSchema),
      parsed,
    ),
  ).toBe(true);
  return z.record(z.string(), z.unknown()).parse(parsed);
};

it.skipIf(process.platform === "win32")(
  "propagates MCP cancellation into a running GDB command",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-gdb-mcp-cancel-"));
    const provider = join(directory, "fake-gdb.mjs");
    const commandPath = join(directory, "command-started");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("(gdb)\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  for (const line of chunk.split("\\n")) {
    const match = /^(\\d+)/.exec(line);
    if (!match) continue;
    if (line.includes("auto-load off")) process.stdout.write(match[1] + "^done\\n");
    else await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(commandPath)}, "started"));
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new GdbSessionManager({
      environment: { REA_GDB_COMMAND: provider },
    });
    const server = new McpServer({ name: "gdb-cancellation", version: "1" });
    registerGdbTools(
      server,
      manager,
      silentLogger,
      createToolResultDelivery(undefined),
    );
    const client = new Client({ name: "gdb-cancellation", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const started = await client.callTool({
        name: "start_gdb_session",
        arguments: {},
      });
      const sessionId = z
        .object({ session_id: z.string().uuid() })
        .parse(started.structuredContent).session_id;
      const controller = new AbortController();
      const command = client.callTool(
        {
          name: "gdb_console",
          arguments: { session_id: sessionId, command: "shell sleep 600" },
        },
        { signal: controller.signal },
      );
      await waitForFile(commandPath);
      controller.abort();
      await expect(command).rejects.toThrow(/abort/iu);
      const status = await validateStatusResponse(
        client,
        "gdb_session_status",
        sessionId,
      );
      expect(status.state).toBe("closed");
      expect(status).toHaveProperty("diagnostics_truncated");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      await manager.closeAll().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "propagates MCP cancellation into a running Rizin debugger command",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-rizin-mcp-cancel-"));
    const provider = join(directory, "fake-rizin.mjs");
    const commandPath = join(directory, "command-started");
    await writeFile(
      provider,
      `#!/usr/bin/env node
process.stdout.write("\\0");
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  for (const line of chunk.split("\\n")) {
    if (line.startsWith("!echo ")) continue;
    await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(commandPath)}, "started"));
  }
});
`,
    );
    await chmod(provider, 0o700);
    const manager = new RizinDebugSessionManager({
      REA_RIZIN_COMMAND: provider,
    });
    const server = new McpServer({ name: "rizin-cancellation", version: "1" });
    registerRizinDebugTools(
      server,
      manager,
      silentLogger,
      createToolResultDelivery(undefined),
    );
    const client = new Client({ name: "rizin-cancellation", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const started = await client.callTool({
        name: "start_rizin_debug_session",
        arguments: { path: "/tmp/fixture.bin" },
      });
      const sessionId = z
        .object({ session_id: z.string().uuid() })
        .parse(started.structuredContent).session_id;
      const controller = new AbortController();
      const command = client.callTool(
        {
          name: "rizin_debug_command",
          arguments: { session_id: sessionId, command: "dr" },
        },
        { signal: controller.signal },
      );
      await waitForFile(commandPath);
      controller.abort();
      await expect(command).rejects.toThrow(/abort/iu);
      const status = await validateStatusResponse(
        client,
        "rizin_debug_session_status",
        sessionId,
      );
      expect(status.state).toBe("closed");
      expect(status).toHaveProperty("diagnostics_truncated");
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
      await manager.closeAll().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
