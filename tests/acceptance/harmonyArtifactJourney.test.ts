import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";

import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { harmonyApplicationProjectionResultSchema } from "../../src/domain/harmony/harmonyApplication.js";
import { workspaceCliTest as test } from "../support/cli/workspaceCliFixture.js";

test("preserves Harmony archive formats through the public CLI/MCP lifecycle", async ({
  cli,
  workspace,
}) => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "module.json",
    new TextReader('{"module":{"name":"fixture"}}'),
  );
  await writer.add(
    "ets/modules.abc",
    new TextReader("opaque bytecode fixture"),
  );
  const bytes = await writer.close();
  const environment = {
    PATH: process.env.PATH ?? "",
    HOME: workspace.root,
    USERPROFILE: workspace.root,
    XDG_CONFIG_HOME: workspace.path("config"),
    XDG_CACHE_HOME: workspace.path("cache"),
    XDG_STATE_HOME: workspace.path("state"),
    NODE_OPTIONS: "--max-old-space-size=512",
    REA_LOG_LEVEL: "silent",
  };
  const client = new Client({ name: "rea-harmony-acceptance", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("scripts/rea.mjs"), "mcp"],
    env: environment,
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    await client.listTools();
    for (const { suffix, format } of [
      { suffix: "hap", format: "hap" },
      { suffix: "hsp", format: "hsp" },
      { suffix: "app", format: "app-pack" },
    ]) {
      const path = workspace.path(`fixture.${suffix}`);
      await writeFile(path, bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const cliReply = await cli.run({
        arguments: ["inspect-artifact", path, "--format", "json"],
        environment,
      });
      expect(cliReply.exitCode, cliReply.stderr).toBe(0);
      const cliEvidence = parseEvidence(cliReply.json);
      const cliInventory = artifactInspectionResultSchema.parse(
        cliEvidence.normalized_result,
      );
      expect(cliInventory.subject).toMatchObject({
        root_format: format,
        root_sha256: sha256,
      });
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({
        result: { kind: "archive", format, sha256 },
      });
      const status = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(status.isError, JSON.stringify(status)).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        result: { open: true, kind: "archive", format, sha256 },
      });
      const inspected = await client.callTool({
        name: "inspect_artifact",
        arguments: {},
      });
      expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
      const inventoryEvidence = parseEvidence(inspected.structuredContent);
      expect(
        artifactInspectionResultSchema.parse(
          inventoryEvidence.normalized_result,
        ),
      ).toEqual(cliInventory);

      const projected = await client.callTool({
        name: "project_harmony_application_graph",
        arguments: { inventory_evidence: [inventoryEvidence] },
      });
      expect(projected.isError, JSON.stringify(projected)).not.toBe(true);
      const graph = harmonyApplicationProjectionResultSchema.parse(
        parseEvidence(projected.structuredContent).normalized_result,
      );
      expect(graph).toMatchObject({
        root_format: format,
        root_sha256: sha256,
        coverage: { status: "complete-within-inventory" },
      });
      expect(
        graph.components.manifests.map(({ path: member }) => member),
      ).toEqual(["module.json"]);
      expect(
        graph.components.bytecode.map(({ path: member }) => member),
      ).toEqual(["ets/modules.abc"]);
      const closed = await client.callTool({
        name: "close_binary",
        arguments: {},
      });
      expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
      const empty = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(empty.isError, JSON.stringify(empty)).not.toBe(true);
      expect(empty.structuredContent).toMatchObject({
        result: { open: false },
      });
      expect(await readFile(path)).toEqual(Buffer.from(bytes));
    }
  } finally {
    await client.close();
  }
}, 120_000);
