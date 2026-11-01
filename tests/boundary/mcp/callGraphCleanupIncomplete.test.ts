import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { createAnalysisExecutionEvidence } from "../../../src/domain/analysisObservation.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  closeEnhancedToolResources,
  connect,
  jsonResult,
} from "./enhancedToolsHarness.js";

afterEach(closeEnhancedToolResources);

const provider = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1",
} as const;
const directions = [
  ["forward", "procedure_callees"],
  ["backward", "procedure_callers"],
] as const;
const tools = ["get_call_graph", "trace_call_path"] as const;
type Tool = (typeof tools)[number];
type Relationships = Readonly<
  Record<string, readonly string[] | AnalysisError>
>;

const childFailure = (operation: string, cleanup: boolean) =>
  new AnalysisCapabilityUnavailableError(
    provider.id,
    operation,
    "child failed",
    cleanup
      ? {
          cleanup: {
            reason: "worker cleanup failed",
            resources: ["owned worker"],
          },
        }
      : undefined,
  );

/** Answer each selector's relationship read and record every read in order. */
const relationshipPort = (
  relationships: Relationships,
  reads: string[],
): AnalysisOperationPort => ({
  execute: async (operation, parameters) => {
    const procedure = String(parameters.procedure);
    if (operation === "procedure_address")
      return ok(createAnalysisExecution(procedure, provider));
    if (operation !== "procedure_callees" && operation !== "procedure_callers")
      return ok(createAnalysisExecution(null, provider));
    reads.push(`${operation}:${procedure}`);
    const answer = relationships[procedure] ?? [];
    return answer instanceof AnalysisError
      ? err(answer)
      : ok(
          createAnalysisExecution(answer, provider, {
            relationshipCoverage: { status: "complete" },
          }),
        );
  },
});

const call = (
  tool: Tool,
  direction: (typeof directions)[number][0],
  goal = "0x4",
) => ({
  name: tool,
  arguments:
    tool === "get_call_graph"
      ? { address: "0x1", direction }
      : { start: "0x1", goal, direction },
});

describe.each(directions)("%s relationship reads", (direction, operation) => {
  it.each(tools)(
    "%s stops at unconfirmed cleanup and reports it with the admitted result",
    async (tool) => {
      const reads: string[] = [];
      const client = await connect(
        relationshipPort(
          {
            "0x1": ["0x2", "0x3"],
            "0x2": childFailure(operation, true),
            "0x3": ["0x4"],
          },
          reads,
        ),
      );

      const response = await client.callTool(call(tool, direction));

      expect(reads).toEqual([`${operation}:0x1`, `${operation}:0x2`]);
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          operation,
          cleanup: "incomplete",
          resources: ["owned worker"],
          cleanup_reason: "worker cleanup failed",
          execution_failure: "capability_unavailable",
        },
      });
      // Without an Evidence writer the admitted result stays inline.
      const partial = parseEvidence(error.details?.partial_observation);
      expect(partial).toMatchObject({
        operation: tool,
        confidence: "derived",
        parameters: call(tool, direction).arguments,
      });
      const stopped =
        "Traversal stopped at 0x2 because the provider did not confirm cleanup of resources it owns; 1 discovered procedure was not expanded.";
      if (tool === "get_call_graph")
        expect(partial.normalized_result).toEqual({
          graph: {
            "0": [
              {
                address: "0x1",
                status: "ok",
                calls: ["0x2", "0x3"],
                relationship_coverage: { status: "complete" },
              },
            ],
          },
          limitations: [stopped],
        });
      else
        expect(partial.normalized_result).toMatchObject({
          goal: "0x4",
          goal_status: "unknown",
          nodes: [
            { address: "0x1", depth: 0 },
            { address: "0x2", depth: 1 },
            { address: "0x3", depth: 1 },
          ],
          traversal_path: [],
          failures: [],
          relationship_coverage: { "0x1": { status: "complete" } },
          truncated: true,
          residual_unknowns: [stopped],
        });
    },
  );

  it.each(tools)(
    "%s keeps an ordinary expansion failure as a usable partial result",
    async (tool) => {
      const reads: string[] = [];
      const client = await connect(
        relationshipPort(
          {
            "0x1": ["0x2", "0x3"],
            "0x2": childFailure(operation, false),
            "0x3": ["0x4"],
          },
          reads,
        ),
      );

      const response = await client.callTool(call(tool, direction));

      expect(response.isError).not.toBe(true);
      expect(reads).toEqual([
        `${operation}:0x1`,
        `${operation}:0x2`,
        `${operation}:0x3`,
        ...(tool === "get_call_graph" ? [`${operation}:0x4`] : []),
      ]);
      const failed = {
        address: "0x2",
        error: {
          code: "capability_unavailable",
          details: { operation },
        },
      };
      expect(jsonResult(response)).toMatchObject(
        tool === "get_call_graph"
          ? {
              graph: {
                "1": [{ ...failed, status: "error" }, { address: "0x3" }],
              },
            }
          : {
              goal_status: "reached",
              traversal_path: ["0x1", "0x3", "0x4"],
              failures: [failed],
            },
      );
    },
  );
});

it.each(tools)(
  "%s keeps earlier ordinary failures and dispatches nothing after a later cleanup failure",
  async (tool) => {
    const reads: string[] = [];
    const client = await connect(
      relationshipPort(
        {
          "0x1": ["0x2", "0x3", "0x4"],
          "0x2": childFailure("procedure_callees", false),
          "0x3": childFailure("procedure_callees", true),
          "0x4": ["0x5"],
        },
        reads,
      ),
    );

    const response = await client.callTool(call(tool, "forward", "0x5"));

    expect(reads).toEqual([
      "procedure_callees:0x1",
      "procedure_callees:0x2",
      "procedure_callees:0x3",
    ]);
    const { error } = parseMcpToolError(response);
    expect(error).toMatchObject({
      code: "cleanup_incomplete",
      details: { resources: ["owned worker"] },
    });
    const partial = parseEvidence(error.details?.partial_observation);
    const stopped =
      "Traversal stopped at 0x3 because the provider did not confirm cleanup of resources it owns; 1 discovered procedure was not expanded.";
    const ordinary = {
      address: "0x2",
      error: { code: "capability_unavailable" },
    };
    expect(partial.normalized_result).toMatchObject(
      tool === "get_call_graph"
        ? {
            graph: {
              "0": [{ address: "0x1", status: "ok" }],
              "1": [{ ...ordinary, status: "error" }],
            },
            limitations: [stopped],
          }
        : {
            goal_status: "unknown",
            failures: [ordinary],
            residual_unknowns: [
              "Call relationships were unavailable for 0x2.",
              stopped,
            ],
          },
    );
  },
);

it.each(tools)(
  "%s retains the admitted result as session Evidence and references it",
  async (tool) => {
    const directory = await createTestTempDirectory("rea-call-graph-cleanup-");
    const target = join(directory, "fixture.com");
    await writeFile(target, Buffer.from([0xb8, 0x00, 0x4c, 0xcd, 0x21]));
    const reads: string[] = [];
    const port = relationshipPort(
      {
        "0x1": ["0x2", "0x3"],
        "0x2": childFailure("procedure_callees", true),
        "0x3": ["0x4"],
      },
      reads,
    );
    const session = createTestBinarySession(
      () => ({
        execute: (operation, parameters, options) =>
          port.execute(operation, parameters, options),
        close: async () => ok(null),
      }),
      {
        // A committed profile lets the session retain each admitted read.
        resolveAnalysisProfile: async () =>
          ok({ profile: createAnalysisProfile(provider, { fixture: true }) }),
      },
    );
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "call-graph-cleanup", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: target, format: "dos-com" },
      });
      expect(opened.isError).not.toBe(true);

      const response = await client.callTool(call(tool, "forward"));

      expect(reads).toEqual(["procedure_callees:0x1", "procedure_callees:0x2"]);
      const { error } = parseMcpToolError(response);
      expect(error).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: ["owned worker"],
          partial_observation: { kind: "retained-evidence" },
        },
      });
      const reference = error.details?.partial_observation as {
        readonly evidence_id: string;
      };
      const retained = session.evidenceForAnalysis(reference.evidence_id);
      expect(retained).toMatchObject({
        operation: tool,
        subject: { format: "dos-com" },
        normalized_result:
          tool === "get_call_graph"
            ? { graph: { "0": [{ address: "0x1", status: "ok" }] } }
            : { goal_status: "unknown", truncated: true },
      });
      // The admitted read stays linked as the partial result's source.
      expect(retained?.evidence_links).toHaveLength(1);
      expect(
        session.evidenceForAnalysis(retained?.evidence_links?.[0] ?? ""),
      ).toMatchObject({
        operation: "procedure_callees",
        parameters: { procedure: "0x1" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  },
);

it.each(tools)(
  "%s stops at a root read cleanup failure without dispatching more reads",
  async (tool) => {
    const reads: string[] = [];
    const client = await connect(
      relationshipPort(
        { "0x1": childFailure("procedure_callees", true), "0x4": [] },
        reads,
      ),
    );

    const { error } = parseMcpToolError(
      await client.callTool(call(tool, "forward")),
    );

    expect(reads).toEqual(["procedure_callees:0x1"]);
    expect(error.code).toBe("cleanup_incomplete");
    const stopped =
      "Traversal stopped at 0x1 because the provider did not confirm cleanup of resources it owns; 0 discovered procedures were not expanded.";
    expect(
      parseEvidence(error.details?.partial_observation).normalized_result,
    ).toMatchObject(
      tool === "get_call_graph"
        ? { graph: {}, limitations: [stopped] }
        : { goal_status: "unknown", residual_unknowns: [stopped] },
    );
  },
);

it("keeps a failed read's own partial observation instead of the workflow's", async () => {
  const failure = childFailure("procedure_callees", true);
  const own = createAnalysisExecutionEvidence(
    "procedure_callees",
    { procedure: "0x2" },
    createAnalysisExecution(["0x9"], provider),
    "observed",
  );
  failure.retainPartialObservation(own);
  const reads: string[] = [];
  const client = await connect(
    relationshipPort({ "0x1": ["0x2", "0x3"], "0x2": failure }, reads),
  );

  const { error } = parseMcpToolError(
    await client.callTool(call("get_call_graph", "forward")),
  );

  expect(reads).toEqual(["procedure_callees:0x1", "procedure_callees:0x2"]);
  expect(error.code).toBe("cleanup_incomplete");
  expect(parseEvidence(error.details?.partial_observation).evidence_id).toBe(
    own.evidence_id,
  );
});
