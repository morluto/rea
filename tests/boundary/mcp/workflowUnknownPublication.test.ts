import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
} from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["compact", "full"] as const)(
  "reports the committed Unknown prefix and retained trace through MCP (%s)",
  async (profile) => {
    const directory = await createTestTempDirectory("rea-unknown-publication-");
    const target = join(directory, "fixture.com");
    await writeFile(target, Buffer.from([0xb8, 0x00, 0x4c, 0xcd, 0x21]));
    const session = new BinarySession(
      createTestProviderRouter(() => ({
        execute: async (name) => {
          switch (name) {
            case "health":
              return observed(null);
            case "search_strings":
              return observed([]);
            case "search_procedures":
              return observed([{ address: "0x10", value: "goal" }]);
            case "xrefs":
              return observed(["0x20", "0x30", "0x40"]);
            case "resolve_containing_procedure":
              return err(
                new AnalysisCapabilityUnavailableError(
                  "fixture",
                  name,
                  "not supported",
                ),
              );
            default:
              throw new Error(`Unexpected operation ${name}`);
          }
        },
        close: async () => ({ ok: true, value: null }),
      })),
      new InvestigationRecords(),
    );
    const original = session.recordUnknown.bind(session);
    let attempts = 0;
    vi.spyOn(session, "recordUnknown").mockImplementation((input) => {
      attempts += 1;
      return attempts === 2
        ? err(
            new AnalysisResourceConstraintError(
              "record_unknown",
              "capacity",
              "fixture limit",
              null,
            ),
          )
        : original(input);
    });
    const { client } = await createApplicationMcpHarness({
      session,
      serverOptions: {
        environment: {
          ...process.env,
          REA_MCP_INPUT_SCHEMA_PROFILE: profile,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
        },
      },
    });
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: target, format: "dos-com" },
    });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const progress: string[] = [];
    const reply = await client.callTool(
      { name: "trace_feature", arguments: { query: "goal" } },
      {
        onprogress: (update) => {
          if (update.message) progress.push(update.message);
        },
      },
    );
    const projected = parseMcpToolError(reply).error;
    expect(projected.code).toBe("resource_constraint");
    expect(projected.details?.workflow_unknown_publication).toMatchObject({
      evidence_retention: "retained",
      total_questions: 3,
      created_questions: 1,
      existing_questions: 0,
      next_question_index: 1,
    });
    expect(projected.remediation.action).toContain("get_evidence_bundle");
    expect(progress.at(-1)).toContain("failed");
    const retained = session.exportEvidenceBundle();
    const trace = retained.records.find(
      (record) => record.operation === "trace_feature",
    );
    expect(trace).toBeDefined();
    expect(projected.details?.workflow_unknown_publication).toMatchObject({
      evidence_id: trace?.evidence_id,
    });
    expect(trace?.normalized_result).toMatchObject({
      references: expect.arrayContaining([
        expect.objectContaining({ source_address: "0x20" }),
        expect.objectContaining({ source_address: "0x30" }),
        expect.objectContaining({ source_address: "0x40" }),
      ]),
    });
    expect(session.listUnknowns()).toHaveLength(1);
  },
);
