import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";

import { createApplicationMcpHarness } from "../fixtures/applicationMcpHarness.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { createCli } from "../../src/cli.js";
import { createEvidence, parseEvidence } from "../../src/domain/evidence.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { analysisCliErrorEnvelopeSchema } from "../../src/contracts/errorSchemas.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { javaScriptSemanticTraceResultSchema } from "../../src/domain/javascript/javascriptSemanticTraceSchemas.js";
import { resolveJavaScriptSemanticEvidence } from "../../src/domain/javascript/javascriptSemanticGraph.js";

const SEMANTIC_GRAPH_ID = `jsrg_${"0".repeat(64)}`;

it("reports invalid nested semantic graph Evidence as caller input through CLI and SDK MCP", async () => {
  const root = await createTestTempDirectory("rea-semantic-trace-input-");
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "main.js"),
    "export function parse(value) { return JSON.parse(value); }\n",
  );

  const cli = createCli({});
  const analyzed = await serveCli(cli, [
    "analyze-javascript-application",
    root,
    "--json",
  ]);
  expect(analyzed.exitCode).toBe(0);
  const sourceEvidence = parseEvidence(JSON.parse(analyzed.stdout));
  const normalizedResult = structuredClone(sourceEvidence.normalized_result);
  if (!isJsonObject(normalizedResult))
    throw new Error("CLI analysis result must be an object");
  const semanticGraph = normalizedResult.semantic_graph;
  if (!isJsonObject(semanticGraph))
    throw new Error("CLI analysis must include a semantic graph");
  const firstNode = semanticGraph.nodes;
  if (!Array.isArray(firstNode) || !isJsonObject(firstNode[0]))
    throw new Error("CLI semantic graph must include a node");
  const seedNodeId = firstNode[0].node_id;
  if (typeof seedNodeId !== "string")
    throw new Error("CLI semantic graph node must have an identifier");
  semanticGraph.graph_id = SEMANTIC_GRAPH_ID;

  const subject = sourceEvidence.subject;
  if (subject === null) throw new Error("CLI Evidence must include a subject");
  const malformedEvidence = createEvidence(
    {
      path: subject.local_path,
      sha256: subject.digest.sha256,
      format: subject.format,
      ...(subject.architecture === null
        ? {}
        : { architecture: subject.architecture }),
    },
    sourceEvidence.provider,
    {
      predicateType: sourceEvidence.predicate_type,
      operation: sourceEvidence.operation,
      parameters: sourceEvidence.parameters,
      result: normalizedResult,
      confidence: sourceEvidence.confidence,
      authority: sourceEvidence.authority,
    },
  );
  expect(malformedEvidence.evidence_id).not.toBe(sourceEvidence.evidence_id);

  const arguments_ = {
    application: malformedEvidence,
    query: {
      seed: { kind: "semantic-node", node_id: seedNodeId },
      direction: "backward-provenance",
    },
  };
  const cliTrace = await serveCli(cli, [
    "trace-javascript-semantics",
    JSON.stringify(arguments_),
    "--json",
  ]);
  const cliEnvelope = analysisCliErrorEnvelopeSchema.parse(
    JSON.parse(cliTrace.stdout),
  );
  const { error: _label, ...cliError } = cliEnvelope;
  expect(cliError).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: {
      issues: [
        {
          path: [
            "application",
            "normalized_result",
            "semantic_graph",
            "graph_id",
          ],
          reason: "invalid_value",
        },
      ],
    },
  });

  const harness = await createApplicationMcpHarness();
  try {
    await assertSuccessfulTraceParity(
      cli,
      harness,
      sourceEvidence,
      arguments_.query,
    );

    const mcpTrace = await harness.client.callTool({
      name: "trace_javascript_semantics",
      arguments: arguments_,
    });
    const { error: mcpError } = parseMcpToolError(mcpTrace);
    expect(mcpError).toEqual(cliError);
  } finally {
    await harness.close();
  }
});

const assertSuccessfulTraceParity = async (
  cli: ReturnType<typeof createCli>,
  harness: Awaited<ReturnType<typeof createApplicationMcpHarness>>,
  application: ReturnType<typeof parseEvidence>,
  query: { readonly seed: unknown; readonly direction: string },
): Promise<void> => {
  const arguments_ = { application, query };
  const cliResponse = await serveCli(cli, [
    "trace-javascript-semantics",
    JSON.stringify(arguments_),
    "--json",
  ]);
  const cliEvidence = parseEvidence(JSON.parse(cliResponse.stdout));
  const cliResult = javaScriptSemanticTraceResultSchema.parse(
    cliEvidence.normalized_result,
  );
  assertTraceContextsResolve(cliResult);

  const mcpResponse = await harness.client.callTool({
    name: "trace_javascript_semantics",
    arguments: arguments_,
  });
  expect(mcpResponse.isError).not.toBe(true);
  const { tools } = await harness.client.listTools();
  const advertised = tools.find(
    ({ name }) => name === "trace_javascript_semantics",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("Semantic trace SDK output schema is missing");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(ajv.validate(outputSchema, mcpResponse.structuredContent)).toBe(true);
  const mcpEvidence = toolContract(
    "trace_javascript_semantics",
  ).outputSchema.parse(mcpResponse.structuredContent);
  expect(mcpEvidence.normalized_result).toEqual(cliResult);
  expect(mcpEvidence).toEqual(cliEvidence);
};

const assertTraceContextsResolve = (
  result: ReturnType<typeof javaScriptSemanticTraceResultSchema.parse>,
): void => {
  const contexts = new Map(
    result.evidence_contexts.map((context) => [context.context_id, context]),
  );
  const references = [
    ...result.nodes.map(({ evidence }) => evidence),
    ...result.relations.map(({ evidence }) => evidence),
    ...result.unknowns.map(({ evidence }) => evidence),
  ];
  const referencedIds = new Set<string>();
  for (const reference of references) {
    const context = contexts.get(reference.context_id);
    expect(context, reference.context_id).toBeDefined();
    if (context === undefined) continue;
    referencedIds.add(reference.context_id);
    expect(
      resolveJavaScriptSemanticEvidence(
        { evidence_contexts: result.evidence_contexts },
        reference,
      ),
    ).toMatchObject({
      ...Object.fromEntries(
        Object.entries(context).filter(([key]) => key !== "context_id"),
      ),
      location: reference.location,
    });
  }
  expect([...referencedIds].toSorted()).toEqual(
    [...contexts.keys()].toSorted(),
  );
  expect(contexts.size).toBeGreaterThan(0);
};

const serveCli = async (
  cli: ReturnType<typeof createCli>,
  arguments_: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...arguments_], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { stdout, exitCode };
};

const isJsonObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
