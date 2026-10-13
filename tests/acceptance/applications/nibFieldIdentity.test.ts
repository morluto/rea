import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";

import { encodeNibArchiveFixture } from "../../../src/artifacts/apple/NibArchive.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { interfaceBuilderAnalysisSchema } from "../../../src/domain/apple/interfaceBuilderGraph.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves literal NIB fields and UTF-8 names through CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nib-field-identity-");
    const app = join(root, "Fixture.app");
    const contents = join(app, "Contents");
    await mkdir(join(contents, "Resources"), { recursive: true });
    await mkdir(join(contents, "MacOS"));
    await writeFile(
      join(contents, "MacOS/App"),
      thinMach(0xfeedfacf, 0x0100000c),
    );
    await writeFile(
      join(contents, "Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key><string>App</string><key>CFBundleIdentifier</key><string>dev.rea.nib-fields</string></dict></plist>",
    );
    const archive = encodeNibArchiveFixture({
      classes: ["UIView", "\uFEFFCustomView"],
      objects: [
        {
          classIndex: 0,
          values: {
            ["__proto__"]: { ref: 1 },
            constructor: 7,
            enabled: true,
            "\uFEFFenabled": false,
          },
        },
        { classIndex: 1, values: { ["__proto__"]: 23 } },
      ],
    });
    const path = join(contents, "Resources/Panel.nib");
    await writeFile(path, archive);
    const result = await cli.run({
      arguments: ["decode-interface-builder", app, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const contract = toolContract("decode_interface_builder");
    const evidence = contract.outputSchema.parse(result.json);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      env: {
        PATH: process.env.PATH ?? "",
        REA_LOG_LEVEL: "silent",
        REA_ANALYSIS_PROVIDER: "auto",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "nib-field-identity", version: "1" });
    try {
      await client.connect(transport);
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: app },
      });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const response = await client.callTool({
        name: contract.name,
        arguments: {},
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const mcp = contract.outputSchema.parse(response.structuredContent);
      expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
    const report = interfaceBuilderAnalysisSchema.parse(
      evidence.normalized_result,
    );
    expect(report.documents[0]?.archive_sha256).toBe(
      createHash("sha256").update(archive).digest("hex"),
    );
    const objects = report.graph.nodes.filter(
      ({ attributes }) => attributes.interface_builder_object_id !== undefined,
    );
    expect(objects).toHaveLength(2);
    expect(objects[0]?.attributes.nibValues).toEqual({
      ["__proto__"]: { objectID: "1" },
      constructor: 7,
      enabled: true,
      "\uFEFFenabled": false,
    });
    expect(objects[1]?.attributes).toMatchObject({
      class_name: "\uFEFFCustomView",
      nibValues: { ["__proto__"]: 23 },
    });
    expect(await readFile(path)).toEqual(archive);
  },
  60_000,
);
