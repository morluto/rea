import { createHash } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect } from "vitest";

import { artifactMcpCall } from "../../scripts/lib/artifact-e2e.mjs";
import { parseEvidence } from "../../src/domain/evidence.js";
import { managedMemberInspectionSchema } from "../../src/domain/managed/managedArtifact.js";
import { analysisViewResultSchema } from "../../src/domain/analysisView/analysisViewResult.js";
import { fileIdentity } from "../fixtures/evidenceSubject.js";
import {
  managedSwitchFixture,
  managedSwitchInstruction,
} from "../fixtures/managedSwitchTargets.js";
import { createMcpSchemaValidation } from "../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "CLI and stdio MCP preserve switch destinations in retained method evidence",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-switch-");
    const path = join(root, "switch.dll");
    const bytes = managedSwitchFixture(
      Buffer.concat([
        Buffer.from([0x00, 0x02]),
        managedSwitchInstruction([0, -19, 0]),
        Buffer.from([0x2a]),
      ]),
    );
    const expectedAnchor = {
      il_offset: 2,
      opcode: "switch",
      operand_kind: "switch",
      operand: "3",
      switch_targets: [19, 0, 19],
      switch_fallthrough: 19,
    };
    await writeFile(path, bytes);
    const output = await cli.run({
      arguments: [
        "inspect-managed-members",
        path,
        "--detail",
        "complete",
        "--json",
      ],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const cliEvidence = parseEvidence(output.json);
    const cliReport = managedMemberInspectionSchema.parse(
      cliEvidence.normalized_result,
    );
    expect(cliReport.methods[0]?.body.anchors[2]).toEqual(expectedAnchor);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        REA_LOG_LEVEL: "silent",
        ...(process.platform === "win32"
          ? {
              SystemRoot: process.env.SystemRoot ?? "",
              TEMP: tmpdir(),
              TMP: tmpdir(),
            }
          : {}),
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    const client = new Client(
      { name: "managed-switch-targets", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    try {
      await client.connect(transport);
      const response = await artifactMcpCall(client, {
        name: "inspect_managed_members",
        arguments: { path, detail: "complete" },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const parent = parseEvidence(response.structuredContent);
      expect(parent.normalized_result).toEqual(cliEvidence.normalized_result);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      expect(fileIdentity(parent.subject).sha256).toBe(sha256);
      expect(fileIdentity(cliEvidence.subject).sha256).toBe(sha256);
      await unlink(path);

      const reply = await artifactMcpCall(client, {
        name: "inspect_analysis_view",
        arguments: {
          source: {
            kind: "retained-evidence",
            evidence_id: parent.evidence_id,
          },
          view: {
            kind: "managed-members",
            collection: "methods",
            fields: ["body"],
            offset: 0,
            limit: 1,
          },
        },
      });
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const pageEvidence = parseEvidence(reply.structuredContent);
      expect(pageEvidence.evidence_links).toEqual([parent.evidence_id]);
      const page = analysisViewResultSchema.parse(
        pageEvidence.normalized_result,
      );
      expect(page).toMatchObject({
        parent_evidence_id: parent.evidence_id,
        page: {
          rows: [
            {
              source_index: 0,
              token: "0x06000001",
              body: { anchors: expect.arrayContaining([expectedAnchor]) },
            },
          ],
        },
      });
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
  },
);
