import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { AnalysisOperation } from "../application/AnalysisProvider.js";
import { IdaSessionClient } from "./IdaSessionClient.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("headless IDA operation failures", () => {
  it.each<{
    tool: string;
    operation: AnalysisOperation;
    parameters: Readonly<Record<string, JsonValue>>;
    response: JsonValue;
  }>([
    {
      tool: "decompile",
      operation: "procedure_pseudo_code",
      parameters: { procedure: "main" },
      response: { code: "partial pseudocode", cursor: { done: true } },
    },
    {
      tool: "xrefs_to",
      operation: "xrefs",
      parameters: { address: "0x1000" },
      response: [{ xrefs: [], more: false }],
    },
    {
      tool: "callees",
      operation: "procedure_callees",
      parameters: { procedure: "main" },
      response: [{ callees: [], more: false }],
    },
    {
      tool: "decompile",
      operation: "analyze_function",
      parameters: { procedure: "main" },
      response: { code: "partial pseudocode", cursor: { done: true } },
    },
    {
      tool: "callees",
      operation: "analyze_function",
      parameters: { procedure: "main" },
      response: [{ callees: [], more: false }],
    },
  ])(
    "preserves $tool failure through $operation when the producer also supplies preview data",
    async ({ tool, operation, parameters, response }) => {
      const { root, target } = await createIdaTarget();
      roots.push(root);
      const producer = new RecordingIdaMcp(target, "headless");
      const failure =
        "Database analysis interrupted while reading observations";
      producer.overrideCall = (name) => {
        if (name !== tool) return undefined;
        const withError = (value: JsonValue): JsonValue => {
          if (
            value === null ||
            typeof value !== "object" ||
            Array.isArray(value)
          )
            throw new TypeError("Invalid operation fixture");
          return { ...value, error: failure };
        };
        return Array.isArray(response)
          ? response.map(withError)
          : withError(response);
      };
      const client = new IdaSessionClient(
        {
          command: "fixture",
          args: [],
          env: {},
          mode: "headless",
          timeoutMs: 1000,
          workspaceRoot: root,
        },
        target,
        producer,
      );
      try {
        const result = await client.execute(operation, parameters);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain(failure);
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    },
  );
});
