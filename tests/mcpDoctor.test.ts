import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { compareInventory, runProductionMcpDoctor } from "../src/mcpDoctor.js";
import { CATALOG_IDENTITY } from "../src/catalogIdentity.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

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
          expected: CATALOG_IDENTITY.counts.mcp_tools,
          observed: CATALOG_IDENTITY.counts.mcp_tools,
          missing: [],
          unexpected: [],
        },
      },
      request_flow: { tool: "binary_session", ok: true },
    });
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
    temporary.push(root);
    const pidPath = join(root, "pid");
    const result = await runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpDoctorHang.mjs")],
      cwd: process.cwd(),
      environment: { ...process.env, REA_MCP_DOCTOR_PID_PATH: pidPath },
      deadlineMs: 250,
    });
    expect(result.healthy).toBe(false);
    const pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
    await expect(waitForExit(pid)).resolves.toBeUndefined();
  }, 10_000);
});

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (cause: unknown) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause as NodeJS.ErrnoException).code === "ESRCH"
      )
        return;
      throw cause;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`MCP doctor fixture process ${String(pid)} remained alive`);
};
