import { Ajv2020 } from "ajv/dist/2020.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
  isCallToolResult,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import {
  jsonObjectSchema,
  type JsonValue,
} from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { registerOfficialTools } from "../../../src/server/registerOfficialTools.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { encodeToolResult } from "../../../src/server/toolResultEncoding.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

const delivery = new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);

const provider = { id: "fixture", name: "Fixture", version: "1" };

const callPseudoCode = async (
  payload: string,
  rawResult: JsonValue,
  retained: boolean,
) => {
  const records = new Map<string, Evidence>();
  const recordEvidence = retained
    ? (evidence: Evidence) => {
        records.set(evidence.evidence_id, evidence);
        return ok("added" as const);
      }
    : undefined;
  const server = new EvidenceMcpServer(
    { name: "complete-evidence", version: "1" },
    { capabilities: {} },
    recordEvidence,
    delivery,
  );
  registerOfficialTools(server, {
    logger: silentLogger,
    activeTarget: undefined,
    recordEvidence,
    withAdmittedAnalysis: async (_operationName, _signal, operation) =>
      ok(
        await operation({
          execute: () =>
            Promise.resolve(
              ok(createAnalysisExecution(payload, provider, { rawResult })),
            ),
        }),
      ),
  });
  const client = new Client({ name: "complete-evidence-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const send = serverTransport.send.bind(serverTransport);
  let responseWire = "";
  serverTransport.send = (message, options) => {
    if (isJSONRPCResultResponse(message) && isCallToolResult(message.result))
      responseWire = JSON.stringify(message);
    return send(message, options);
  };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const advertised = (await client.listTools()).tools.find(
      ({ name }) => name === "procedure_pseudo_code",
    );
    if (advertised?.outputSchema === undefined)
      throw new Error("Missing named procedure_pseudo_code output schema");
    const result = await client.callTool({
      name: "procedure_pseudo_code",
      arguments: { procedure: "main" },
    });
    return {
      result,
      responseWire,
      records,
      outputSchema: jsonObjectSchema.parse(advertised.outputSchema),
    };
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
};

describe("large complete Evidence MCP delivery", () => {
  it("delivers a two MiB provider result with raw observations and one normalized payload", async () => {
    const payload = "x".repeat(2 * 1024 * 1024);
    const { result, responseWire, outputSchema } = await callPseudoCode(
      payload,
      payload,
      false,
    );
    expect(result.isError).not.toBe(true);
    const evidence = toolContract("procedure_pseudo_code").outputSchema.parse(
      result.structuredContent,
    );
    expect(evidence.normalized_result).toBe(payload);
    expect(evidence.raw_result).toBe(payload);
    expect(parseEvidence(evidence)).toEqual(evidence);
    expect(evidence).not.toHaveProperty("result");
    expect(evidence).not.toHaveProperty("evidence");
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(evidence) },
    ]);
    expect(Buffer.byteLength(responseWire)).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validate = ajv.compile(outputSchema);
    expect(validate(evidence), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({ ...evidence, normalized_result: { unexpected: true } }),
    ).toBe(false);
    expect(
      validate({
        result: payload,
        evidence_id: evidence.evidence_id,
        evidence,
      }),
    ).toBe(false);
  });

  it("accounts for JSON escaping and preserves distinct raw and normalized observations", async () => {
    const payload = 'quote" slash\\ control\u0000 newline\n unicode☃'.repeat(
      8192,
    );
    const raw = { source: payload, decoder: "fixture-native-wire" };
    const { result, responseWire } = await callPseudoCode(payload, raw, true);
    expect(result.isError).not.toBe(true);
    const evidence = toolContract("procedure_pseudo_code").outputSchema.parse(
      result.structuredContent,
    );
    expect(evidence.normalized_result).toBe(payload);
    expect(evidence.raw_result).toEqual(raw);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(evidence) },
    ]);
    expect(Buffer.byteLength(responseWire)).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
    const encoded = encodeToolResult(
      jsonObjectSchema.parse(evidence),
      delivery.resultBudgetBytes,
    );
    expect(encoded.ok).toBe(true);
    if (!encoded.ok)
      throw new Error("Expected complete escaped result delivery");
    expect(encoded.bytes).toBe(Buffer.byteLength(JSON.stringify(result)));
    expect(JSON.parse(responseWire).result.structuredContent).toEqual(evidence);
  });

  it("reports a true escaped-wire overrun and keeps acknowledged evidence recoverable", async () => {
    // Control characters expand once in structured JSON and again in the text mirror.
    const payload = "\u0000".repeat(
      Math.ceil(STDIO_DEFAULT_MAX_BUFFER_SIZE / 20),
    );
    const { result, responseWire, records } = await callPseudoCode(
      payload,
      payload,
      true,
    );
    expect(result.isError).toBe(true);
    const limits = z
      .object({
        error: z.object({
          code: z.literal("resource_constraint"),
          details: z.object({
            reported_limits: z.object({
              constraint: z.literal("receive-buffer"),
              evidence_reference: z.object({
                kind: z.literal("retained-evidence"),
                evidence_id: z.string(),
              }),
            }),
          }),
        }),
      })
      .parse(parseMcpToolError(result)).error.details.reported_limits;
    const retained = parseEvidence(
      records.get(limits.evidence_reference.evidence_id),
    );
    expect(retained.normalized_result).toBe(payload);
    expect(retained.raw_result).toBe(payload);
    expect(Buffer.byteLength(responseWire)).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
  });

  it("does not claim retention without a recording acknowledgment", () => {
    const evidence = createEvidence(undefined, provider, {
      operation: "procedure_pseudo_code",
      parameters: {},
      result: "x".repeat(Math.ceil(STDIO_DEFAULT_MAX_BUFFER_SIZE / 2)),
    });
    const detached = delivery.toEvidenceToolResult(
      evidence,
      toolContract("procedure_pseudo_code"),
      undefined,
    );
    expect(detached.isError).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(detached))).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
    const limits = z
      .object({
        error: z.object({
          message: z.string(),
          details: z.object({
            reported_limits: z.record(z.string(), z.unknown()),
          }),
        }),
      })
      .parse(detached.structuredContent).error;
    expect(limits.message).toContain("larger MCP response budget");
    expect(limits.message).not.toContain("Export retained evidence");
    expect(limits.details.reported_limits).not.toHaveProperty(
      "evidence_reference",
    );
    expect(limits.details.reported_limits).toHaveProperty(
      "evidence_id",
      evidence.evidence_id,
    );
  });
});
