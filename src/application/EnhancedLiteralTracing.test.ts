import { expect, it } from "vitest";

import { ok } from "../domain/result.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "./AnalysisProvider.js";
import { traceLiteralFeature } from "./EnhancedLiteralTracing.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

it("refuses a malformed literal search result at the port with the observed execution", async () => {
  const calls: string[] = [];
  const analysis: AnalysisOperationPort = {
    execute: async (operation) => {
      calls.push(operation);
      return ok(
        createAnalysisExecution(
          operation === "search_strings" ? [{ address: "0x10" }] : [],
          provider,
        ),
      );
    },
  };
  const traced = await traceLiteralFeature(analysis, {
    query: "token",
    case_sensitive: true,
  });
  expect(calls).toEqual(["search_strings"]);
  expect(traced.ok).toBe(false);
  if (traced.ok) return;
  expect(traced.error).toMatchObject({
    _tag: "AnalysisOutputError",
    operation: "search_strings",
    diagnostics: {
      contract_issues: [{ path: [0, "value"], code: "invalid_type" }],
    },
    partialObservation: {
      operation: "search_strings",
      parameters: { pattern: "token", mode: "literal", case_sensitive: true },
    },
  });
});
