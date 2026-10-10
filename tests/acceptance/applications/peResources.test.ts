import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { peResourcesSchema } from "../../../src/domain/native/peResources.js";
import { peResourceFixture } from "../../../src/native/pe/PeResources.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "inspects PE32/PE32+ resources through compiled CLI and real stdio MCP without an active target",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-resource-acceptance-");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "pe-resource-acceptance", version: "1" });
    const contract = toolContract("inspect_pe_resources");
    try {
      await client.connect(transport);
      const inventory = await client.listTools();
      expect(inventory.tools).toContainEqual(
        expect.objectContaining({
          name: contract.name,
          annotations: expect.objectContaining({
            readOnlyHint: false,
            openWorldHint: false,
          }),
        }),
      );
      const session = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(JSON.stringify(session.structuredContent)).toContain(
        "inspect_pe_resources",
      );
      for (const plus of [false, true]) {
        const fixture = peResourceFixture(plus);
        const path = join(root, plus ? "resource64.exe" : "resource32.exe");
        await writeFile(path, fixture.bytes);
        const result = await cli.run({
          arguments: ["inspect-pe-resources", path, "--json"],
        });
        expect(result.exitCode).toBe(0);
        const evidence = contract.outputSchema.parse(result.json);
        const report = peResourcesSchema.parse(evidence.normalized_result);
        expect(evidence.subject?.digest).toMatchObject({
          sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
        });
        expect(report.coverage).toMatchObject({
          status: "complete",
          resources: 5,
        });
        expect(report.resources[0]?.payload.sha256).toBe(
          createHash("sha256").update("ICON").digest("hex"),
        );
        expect(
          report.resources.find(({ name }) => name.kind === "name")?.name,
        ).toMatchObject({ kind: "name", name: "7", utf16le_hex: "3700" });
        expect(report.icon_groups[0]?.images).toMatchObject([
          {
            resource_id: 1,
            candidate_resource_indices: [0, 1],
            same_language_resource_index: 0,
          },
          {
            resource_id: 99,
            candidate_resource_indices: [],
            same_language_resource_index: null,
          },
        ]);
        const response = await client.callTool({
          name: contract.name,
          arguments: { path },
        });
        expect(response.isError).not.toBe(true);
        const mcp = contract.outputSchema.parse(response.structuredContent);
        expect(mcp.evidence_id).toBe(evidence.evidence_id);
        expect(mcp.normalized_result).toEqual(evidence.normalized_result);
        const text = response.content.find(({ type }) => type === "text");
        if (text?.type !== "text") throw new Error("Missing MCP text Evidence");
        expect(
          contract.outputSchema.parse(JSON.parse(text.text)).evidence_id,
        ).toBe(evidence.evidence_id);
        expect(await readFile(path)).toEqual(fixture.bytes);
      }
      const absent = peResourceFixture();
      absent.bytes.fill(0, absent.directoryAt, absent.directoryAt + 8);
      const path = join(root, "absent.exe");
      await writeFile(path, absent.bytes);
      const empty = await client.callTool({
        name: contract.name,
        arguments: { path },
      });
      expect(empty.isError).not.toBe(true);
      expect(
        contract.outputSchema.parse(empty.structuredContent).normalized_result,
      ).toMatchObject({
        directory: null,
        resources: [],
        coverage: { status: "complete", resources: 0 },
      });
      for (const arguments_ of [
        { path, max_file_bytes: 64 },
        { path: "relative.exe" },
        { path, extra: true },
      ]) {
        const rejected = await client.callTool({
          name: contract.name,
          arguments: arguments_,
        });
        expect(rejected.isError).toBe(true);
        expect(
          contract.outputSchema.safeParse(rejected.structuredContent).success,
        ).toBe(false);
      }
      const damaged = peResourceFixture();
      damaged.bytes.writeUInt32LE(17, damaged.directoryAt + 4);
      const badPath = join(root, "damaged.exe");
      await writeFile(badPath, damaged.bytes);
      const rejected = await client.callTool({
        name: contract.name,
        arguments: { path: badPath },
      });
      expect(rejected.isError).toBe(true);
      expect(
        contract.outputSchema.safeParse(rejected.structuredContent).success,
      ).toBe(false);
      await client.ping();
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
  },
  30_000,
);
