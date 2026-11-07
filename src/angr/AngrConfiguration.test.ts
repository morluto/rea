import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
import {
  readAngrConfiguration,
  type AngrConfigurationSources,
} from "./AngrConfiguration.js";
import { decodeAngrToolResult } from "./AngrMcpConnection.js";

const resourceScope: RetainedResourceScope = {
  retain: () => undefined,
  run: (operation) => operation(),
};
const read = (sources: AngrConfigurationSources) =>
  readAngrConfiguration(sources, { resourceScope });

describe("angr registration and MCP result boundaries", () => {
  it("expands an interpreter path into an owned stdio registration", async () => {
    expect(await read({ pythonPath: process.execPath })).toMatchObject({
      ok: true,
      value: {
        command: process.execPath,
        args: ["-m", "angr.mcp", "--transport", "stdio"],
        mode: "headless",
        autoLoadLibs: false,
      },
    });
    expect(await read({ pythonPath: "python3" })).toMatchObject({
      ok: false,
      error: { settings: [{ setting: "REA_ANGR_PYTHON" }] },
    });
    expect(
      await read({ pythonPath: join(tmpdir(), "missing-python") }),
    ).toMatchObject({ ok: false });
    expect(await read({})).toMatchObject({
      ok: false,
      error: { settings: [{ setting: "REA_ANGR_MCP_CONFIG" }] },
    });
  });
  it("reads direct or mcpServers registrations and prefers the explicit file", async () => {
    const root = await createTestTempDirectory("rea-angr-config-");
    const path = join(root, "mcp.json");
    for (const input of [
      { command: "python", args: ["-m", "angr.mcp"] },
      {
        mcpServers: {
          angr: { command: "python", args: ["-m", "angr.mcp"] },
          unrelated: { command: "untouched" },
        },
      },
    ]) {
      await writeFile(path, JSON.stringify(input));
      expect(
        await read({ mcpConfigPath: path, pythonPath: process.execPath }),
      ).toMatchObject({
        ok: true,
        value: {
          command: "python",
          args: ["-m", "angr.mcp"],
          mode: "headless",
        },
      });
    }
    await writeFile(
      path,
      JSON.stringify({ url: "http://127.0.0.1:8000/mcp", timeoutMs: 5 }),
    );
    expect(await read({ mcpConfigPath: path })).toMatchObject({
      ok: true,
      value: { url: "http://127.0.0.1:8000/mcp", mode: "attached" },
    });
  });
  it("rejects remote endpoints, owned HTTP servers, credentials, and malformed files", async () => {
    const root = await createTestTempDirectory("rea-angr-config-");
    const path = join(root, "mcp.json");
    for (const input of [
      { url: "https://example.com/mcp" },
      { url: "http://user:secret@127.0.0.1:8000/mcp" },
      { url: "http://127.0.0.1:8000/mcp", mode: "headless" },
      { command: "" },
      { command: "python", unexpected: true },
      [],
    ]) {
      await writeFile(path, JSON.stringify(input));
      const parsed = await read({ mcpConfigPath: path });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok)
        expect(parsed.error.settings).toEqual([
          expect.objectContaining({ setting: "REA_ANGR_MCP_CONFIG" }),
        ]);
    }
    await writeFile(path, "{not json");
    expect((await read({ mcpConfigPath: path })).ok).toBe(false);
    expect((await read({ mcpConfigPath: join(root, "absent.json") })).ok).toBe(
      false,
    );
    await writeFile(path, " ".repeat(65_537));
    expect(await read({ mcpConfigPath: path })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("64 KiB") },
    });
  });
  it.skipIf(process.platform === "win32")(
    "refuses a FIFO registration without waiting for a writer",
    async () => {
      const root = await createTestTempDirectory("rea-angr-config-");
      const fifo = join(root, "mcp.json");
      await promisify(execFile)("mkfifo", [fifo]);
      expect(await read({ mcpConfigPath: fifo })).toMatchObject({
        ok: false,
        error: {
          message: expect.stringContaining("must select a regular JSON file"),
          settings: [{ setting: "REA_ANGR_MCP_CONFIG" }],
        },
      });
    },
  );
  it("decodes FastMCP structured results and reports tool errors", () => {
    expect(
      decodeAngrToolResult({
        content: [{ type: "text", text: '{"a":1}' }],
        structuredContent: { a: 1 },
      }),
    ).toEqual({ a: 1 });
    expect(
      decodeAngrToolResult({
        content: [{ type: "text", text: "3" }],
        structuredContent: { result: 3 },
      }),
    ).toBe(3);
    expect(
      decodeAngrToolResult({ content: [{ type: "text", text: '{"b":[]}' }] }),
    ).toEqual({ b: [] });
    expect(() =>
      decodeAngrToolResult({
        isError: true,
        content: [{ type: "text", text: "No function named 'x'." }],
      }),
    ).toThrow(/No function named/u);
    expect(() =>
      decodeAngrToolResult({ content: [{ type: "text", text: "{oops" }] }),
    ).toThrow(/malformed JSON/u);
    expect(() => decodeAngrToolResult({ content: [] })).toThrow(/omitted/u);
  });
});
