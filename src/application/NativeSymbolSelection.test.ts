import { expect, it } from "vitest";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok } from "../domain/result.js";
import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../ports/AnalysisProvider.js";
import { resolveNativeSymbol } from "./NativeSymbolSelection.js";

const PROVIDER = { id: "fixture", name: "Fixture", version: "1" };

/** Serve one name inventory; every procedure lookup misses. */
const names = (rows: JsonValue): AnalysisOperationPort => ({
  execute: async (operation) =>
    operation === "list_names"
      ? ok(createAnalysisExecution(rows, PROVIDER))
      : err(
          new AnalysisInputError(operation, { conformsToInputContract: true }, [
            { path: ["procedure"], reason: "invalid_value" },
          ]),
        ),
});

const external = {
  primary: true,
  dynamic: false,
  external: true,
  type: "function",
  source: "imported",
} as const;

const resolve = (rows: JsonValue, selector: string) =>
  resolveNativeSymbol(names(rows), selector, "find_xrefs_to_name", undefined, {
    procedureLookup: true,
  });

it("resolves an exact name from rows carrying undeclared provider fields", async () => {
  expect(
    await resolve(
      [{ address: "0x10", value: "main", provider_rank: 1 }],
      "main",
    ),
  ).toEqual({
    ok: true,
    value: {
      status: "resolved",
      address: "0x10",
      name: "main",
      match: "exact_name",
    },
  });
});

it("matches an imported name only through the provider's external symbol fact", async () => {
  const rows = [
    {
      address: "EXTERNAL:0x4d",
      value: "KERNEL32.DLL::VirtualAlloc",
      symbol: external,
    },
    // A namespaced local function is not an import of its leaf name.
    {
      address: "0x20",
      value: "Pool::Reserve",
      symbol: { ...external, external: false },
    },
  ];
  expect(await resolve(rows, "VirtualAlloc")).toMatchObject({
    ok: true,
    value: {
      status: "resolved",
      address: "EXTERNAL:0x4d",
      match: "import_name",
    },
  });
  expect(await resolve(rows, "Reserve")).toEqual({
    ok: true,
    value: { status: "unresolved", candidates: [] },
  });
});

it("refuses an imported name that two libraries export", async () => {
  const rows = [
    { address: "EXTERNAL:0x1", value: "A.DLL::Open", symbol: external },
    { address: "EXTERNAL:0x2", value: "B.DLL::Open", symbol: external },
  ];
  expect(await resolve(rows, "Open")).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["name"],
          message: expect.stringContaining(
            "EXTERNAL:0x1 (A.DLL::Open), EXTERNAL:0x2 (B.DLL::Open)",
          ),
        },
      ],
    },
  });
  expect(await resolve(rows, "b.dll::Open")).toMatchObject({
    ok: true,
    value: { status: "resolved", address: "EXTERNAL:0x2" },
  });
});

it("refuses a malformed name row with field diagnostics", async () => {
  expect(await resolve([{ address: 16, value: "main" }], "main")).toMatchObject(
    {
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        operation: "list_names",
        diagnostics: { contract_issues: [{ path: [0, "address"] }] },
      },
    },
  );
});

it("refuses a name row without an address it could pass back to the provider", async () => {
  expect(await resolve([{ address: "", value: "main" }], "main")).toMatchObject(
    {
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        reason: "Invalid symbol inventory entry at index 0",
      },
    },
  );
});
