import { expect, it } from "vitest";

import type { JsonValue } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "./AnalysisProvider.js";
import { resolveXrefsName } from "./XrefsAddressResolution.js";

const names = (rows: JsonValue): AnalysisOperationPort => ({
  execute: async () =>
    ok(
      createAnalysisExecution(rows, {
        id: "fixture",
        name: "Fixture",
        version: "1",
      }),
    ),
});

it("resolves an exact name from rows carrying undeclared provider fields", async () => {
  expect(
    await resolveXrefsName(
      names([{ address: "0x10", value: "main", provider_rank: 1 }]),
      "main",
    ),
  ).toEqual({ ok: true, value: "0x10" });
});

it("refuses a malformed name row with field diagnostics", async () => {
  expect(
    await resolveXrefsName(names([{ address: 16, value: "main" }]), "main"),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisOutputError",
      operation: "list_names",
      diagnostics: { contract_issues: [{ path: [0, "address"] }] },
    },
  });
});

it("refuses a name row without an address it could pass back to xrefs", async () => {
  expect(
    await resolveXrefsName(names([{ address: "", value: "main" }]), "main"),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisOutputError",
      reason: "Invalid symbol inventory entry at index 0",
    },
  });
});
