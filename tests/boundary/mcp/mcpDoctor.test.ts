import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  compareInventory,
  runProductionMcpDoctor,
} from "../../../src/mcpDoctor.js";
import { CATALOG_IDENTITY } from "../../../src/catalogIdentity.js";

afterEach(() => vi.useRealTimers());

describe("production MCP doctor", () => {
  it("connects to the production stdio child and verifies the canonical catalog", async () => {
    const result = await runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      environment: process.env,
    });

    expect(result).toMatchObject({
      healthy: true,
      adapter: "production-stdio",
      inventory: {
        tools: {
          expected: expect.any(Number),
          observed: expect.any(Number),
          missing: [],
          unexpected: [],
        },
      },
      request_flow: { tool: "binary_session", ok: true },
    });
    expect(result.inventory?.tools.expected).toBe(
      result.inventory?.tools.observed,
    );
    expect(result.inventory?.tools.expected).toBe(
      CATALOG_IDENTITY.counts.mcp_tools,
    );
  }, 30_000);

  it("rejects a schema-invalid probe while retaining the discovered inventory", async () => {
    const root = await createTestTempDirectory("rea-mcp-doctor-reply-");
    const snapshotPath = join(root, "reply.json");
    const environment = { PATH: process.env.PATH ?? "" };
    const client = new Client({ name: "doctor-reply-capture", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: environment,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const prompts = await client.listPrompts();
      const toolDefinition = tools.tools.find(
        ({ name }) => name === "binary_session",
      );
      if (toolDefinition === undefined)
        throw new Error("Production binary_session contract is missing");
      const reply = await client.callTool(
        { name: "binary_session", arguments: {} },
        { toolDefinition },
      );
      await writeFile(
        snapshotPath,
        JSON.stringify({
          serverInfo: client.getServerVersion(),
          protocolVersion: client.getNegotiatedProtocolVersion(),
          tools,
          prompts,
          reply,
        }),
      );
    } finally {
      await client.close();
      await transport.close();
    }
    // Replay real production metadata through a synthetic stdio producer.
    for (const mode of ["valid", "invalid"]) {
      const result = await runProductionMcpDoctor({
        command: process.execPath,
        args: [
          resolve("tests/fixtures/mcpDoctorReply.mjs"),
          snapshotPath,
          mode,
        ],
        cwd: process.cwd(),
        environment,
      });
      expect(result.healthy).toBe(mode === "valid");
      expect(result.inventory?.tools.observed).toBe(
        CATALOG_IDENTITY.counts.mcp_tools,
      );
      expect(result.inventory?.prompts.observed).toBe(
        CATALOG_IDENTITY.counts.mcp_prompts,
      );
      expect(result.checks).toContainEqual({
        name: "initialize",
        ok: true,
        detail: expect.any(String),
      });
      if (mode === "invalid")
        expect(result.checks).toContainEqual({
          name: "request-flow",
          ok: false,
          detail: expect.stringMatching(/output schema/iu),
        });
    }
  }, 30_000);

  it("reports exact missing, unexpected, and duplicate inventory names", () => {
    expect(compareInventory(["a", "b"], ["b", "c", "c"])).toEqual({
      expected: 2,
      observed: 3,
      missing: ["a"],
      unexpected: ["c"],
      duplicates: ["c"],
    });
  });

  it("captures startup exit diagnostics", async () => {
    const result = await runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpDoctorExit.mjs")],
      cwd: process.cwd(),
      environment: process.env,
      deadlineMs: 2_000,
    });
    expect(result).toMatchObject({
      healthy: false,
      checks: [{ name: "transport", ok: false }],
      diagnostics: { stderr: expect.stringContaining("startup exit") },
    });
  });

  it("kills a child that misses the absolute startup deadline", async () => {
    const root = await createTestTempDirectory("rea-mcp-doctor-");
    const pidPath = join(root, "pid");
    // Keep filesystem/process I/O real. Advance only the deadline timers,
    // after the fixture proves it started and published its PID.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpDoctorHang.mjs")],
      cwd: process.cwd(),
      environment: { ...process.env, REA_MCP_DOCTOR_PID_PATH: pidPath },
      deadlineMs: 60_000,
    });
    const pid = await vi.waitFor(
      async () => {
        const value = Number.parseInt(await readFile(pidPath, "utf8"), 10);
        expect(Number.isSafeInteger(value) && value > 0).toBe(true);
        return value;
      },
      { timeout: 10_000 },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await vi.waitFor(() => pending, { timeout: 10_000 });
    vi.useRealTimers();
    expect(result.healthy).toBe(false);
    expect(result.checks[0]?.detail).toMatch(/deadline|abort|timed/iu);
    await expect(waitForExit(pid)).resolves.toBeUndefined();
  }, 10_000);
});

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
        return;
      throw cause;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`MCP doctor fixture process ${String(pid)} remained alive`);
};
