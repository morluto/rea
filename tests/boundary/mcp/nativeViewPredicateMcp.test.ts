import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

const fixture = FUNCTION_COMPARISON_EXAMPLE.left;
if (fixture.subject === null)
  throw new Error("Expected artifact-bound fixture");
const subject = {
  path: fixture.subject.local_path,
  sha256: fixture.subject.digest.sha256,
  format: fixture.subject.format,
};
const selected = (
  operation: string,
  result: Evidence["normalized_result"],
  predicateType: string,
) =>
  createEvidence(subject, fixture.provider, {
    operation,
    parameters: {},
    result,
    predicateType,
    confidence: "observed",
    authority: "shipped-artifact",
  });

const wrongMatchingPredicate = (matching: Evidence) =>
  createEvidence(undefined, matching.provider, {
    operation: matching.operation,
    parameters: matching.parameters,
    result: matching.normalized_result,
    predicateType: "rea.analysis",
    confidence: matching.confidence,
    authority: matching.authority,
    evidenceLinks: matching.evidence_links,
  });

it.each(["full", "compact"] as const)(
  "validates native parent predicates across public sources (%s schema)",
  async (profile) => {
    const session = createTestBinarySession(() => {
      throw new Error("No provider should start");
    });
    const server = createServer(
      { kind: "session", session },
      {
        environment: { ...process.env, REA_MCP_OUTPUT_SCHEMA_PROFILE: profile },
      },
    );
    const client = new Client({ name: "native-view-identity", version: "1" });
    const validation = createMcpSchemaValidation();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const root = await createTestTempDirectory("rea-native-view-identity-");
    try {
      await server.connect(st);
      await client.connect(ct);
      const definitions = new Map(
        (await client.listTools()).tools.map((tool) => [tool.name, tool]),
      );
      const viewTool = definitions.get("inspect_analysis_view");
      if (viewTool?.outputSchema === undefined)
        throw new Error("Missing advertised view schema");
      expect(validation.assertions.validateSchema(viewTool.outputSchema)).toBe(
        true,
      );
      const call = (name: string, args: Record<string, unknown>) => {
        const toolDefinition = definitions.get(name);
        if (toolDefinition === undefined) throw new Error(`Missing ${name}`);
        return client.callTool({ name, arguments: args }, { toolDefinition });
      };
      const inventory = selected(
        "list_procedures",
        [{ address: "0x1000", value: "main" }],
        "rea.analysis",
      );
      const matchingResult = await call("match_native_functions", {
        left: inventory,
        right: inventory,
        detail: "complete",
      });
      expect(
        matchingResult.isError,
        JSON.stringify(matchingResult.content),
      ).not.toBe(true);
      const matching = parseEvidence(matchingResult.structuredContent);
      expect(matching.predicate_type).toBe("rea.native-function-matching");
      const wrongMatching = wrongMatchingPredicate(matching);
      const graph = {
        graph: {
          "0": [
            {
              address: "0x1000",
              status: "ok",
              calls: [],
              relationship_coverage: { status: "complete" },
            },
          ],
        },
        limitations: [],
      };
      const cases = [
        {
          good: selected(
            "analyze_function",
            fixture.normalized_result,
            "rea.analysis",
          ),
          bad: selected(
            "analyze_function",
            fixture.normalized_result,
            "rea.unrelated",
          ),
          view: { kind: "summary" },
        },
        {
          good: inventory,
          bad: selected(
            "list_procedures",
            inventory.normalized_result,
            "rea.unrelated",
          ),
          view: { kind: "native-inventory", offset: 0, limit: 1 },
        },
        {
          good: selected("procedure_address", "0x1000", "rea.analysis"),
          bad: selected("procedure_address", "0x1000", "rea.unrelated"),
          view: { kind: "native-observation", offset: 0, limit: 1 },
        },
        {
          good: selected("get_call_graph", graph, "rea.analysis"),
          bad: selected("get_call_graph", graph, "rea.unrelated"),
          view: { kind: "native-observation", offset: 0, limit: 1 },
        },
        { good: matching, bad: wrongMatching, view: { kind: "summary" } },
      ];
      for (const [index, { good, bad, view }] of cases.entries()) {
        expect(session.recordEvidence(good).ok).toBe(true);
        expect(session.recordEvidence(bad).ok).toBe(true);
        const goodReply = await call("inspect_analysis_view", {
          source: { kind: "retained-evidence", evidence_id: good.evidence_id },
          view,
        });
        expect(goodReply.isError, JSON.stringify(goodReply.content)).not.toBe(
          true,
        );
        expect(
          validation.assertions.validate(
            viewTool.outputSchema,
            goodReply.structuredContent,
          ),
          JSON.stringify(validation.assertions.errors),
        ).toBe(true);
        const goodView = parseEvidence(goodReply.structuredContent);
        expect(goodView.evidence_links).toContain(good.evidence_id);
        const raw = join(root, `${index}.json`),
          bundle = join(root, `${index}-bundle.json`);
        await writeFile(raw, JSON.stringify(bad));
        await writeFile(bundle, JSON.stringify(createEvidenceBundle([bad])));
        for (const source of [
          { kind: "inline", evidence: bad },
          { kind: "retained-evidence", evidence_id: bad.evidence_id },
          { kind: "evidence-file", path: raw },
          { kind: "evidence-file", path: bundle },
        ]) {
          const reply = await call("inspect_analysis_view", { source, view });
          expect(parseMcpToolError(reply).error).toMatchObject({
            code: "invalid_request",
            details: {
              issues: [
                expect.objectContaining({
                  path: ["source", "predicate_type"],
                  reason: "invalid_value",
                }),
              ],
            },
          });
        }
      }
      expect(session.activeTarget()).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
      await session.close();
      validation.clear();
    }
  },
);
