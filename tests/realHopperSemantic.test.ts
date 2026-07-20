import { describe, expect, it } from "vitest";

import {
  analyzeFixtureProcedure,
  requireCurrentDocument,
  resolveFixtureProcedure,
  verifyLanguageFixture,
  verifyAbsentFixtureValues,
  verifyNamedFixture,
} from "../scripts/lib/real-hopper-semantic.mjs";

const normalize = (value: unknown): unknown => value;

describe("real Hopper semantic fixture resolution", () => {
  it("requests assembly when analyzing fixture procedures", async () => {
    const requests: unknown[] = [];
    const result = await analyzeFixtureProcedure(
      {
        callTool: async (request: unknown) => {
          requests.push(request);
          return { dossier: true };
        },
      },
      {},
      { address: "0x1000", name: "rea_entry" },
      normalize,
    );

    expect(result).toEqual({ dossier: true });
    expect(requests).toEqual([
      {
        name: "analyze_function",
        arguments: { procedure: "0x1000", include_assembly: true },
      },
    ]);
  });

  it("binds mutations to the active document, not the first listed one", async () => {
    await expect(
      requireCurrentDocument(
        clientReturning("active"),
        {},
        ["unrelated", "active"],
        normalize,
      ),
    ).resolves.toBe("active");
    await expect(
      requireCurrentDocument(
        clientReturning("unknown"),
        {},
        ["unrelated", "active"],
        normalize,
      ),
    ).rejects.toThrow(/current_document/u);
  });

  it("resolves the public search value and preserves its reported name", async () => {
    const procedure = await resolveFixtureProcedure(
      clientWithItems([
        {
          address: "0x1000",
          value: "_rea_entry",
          value_truncated: false,
        },
      ]),
      {},
      "rea_entry",
      normalize,
    );

    expect(procedure).toEqual({ address: "0x1000", name: "_rea_entry" });
  });

  it.each([
    ["empty", []],
    [
      "truncated",
      [{ address: "0x1000", value: "rea_entry", value_truncated: true }],
    ],
    [
      "duplicate",
      [
        { address: "0x1000", value: "rea_entry", value_truncated: false },
        { address: "0x2000", value: "_rea_entry", value_truncated: false },
      ],
    ],
    [
      "wrong name",
      [{ address: "0x1000", value: "rea_other", value_truncated: false }],
    ],
  ])("rejects %s search evidence", async (_label, items) => {
    await expect(
      resolveFixtureProcedure(
        clientWithItems(items),
        {},
        "rea_entry",
        normalize,
      ),
    ).rejects.toThrow(/exactly one Hopper procedure/u);
  });

  it("proves declared symbols, strings, and language semantics", async () => {
    const requests: { name: string; arguments: unknown }[] = [];
    const client = {
      callTool: async (request: { name: string; arguments: unknown }) => {
        requests.push(request);
        if (request.name === "find_xrefs_to_name")
          return { status: "resolved", name: "_rea_entry", xrefs: [] };
        if (request.name === "search_strings")
          return {
            items: [
              { address: "0x1000", value: "REA_ENTRY", value_truncated: false },
            ],
          };
        if (request.name === "get_objc_classes")
          return { count: 1, classes: [{ name: "REAWidget" }] };
        return {};
      },
    };
    await expect(
      verifyLanguageFixture({
        client,
        options: {},
        target: { path: "/fixture", sha256: "a".repeat(64) },
        expectations: {
          symbols: ["_rea_entry"],
          strings: ["REA_ENTRY"],
        },
        operations: ["get_objc_classes"],
        semanticExpectations: { get_objc_classes: ["REAWidget"] },
        normalizedResult: normalize,
      }),
    ).resolves.toMatchObject({
      symbols: ["_rea_entry"],
      strings: ["REA_ENTRY"],
      semantics: {
        get_objc_classes: {
          count: 1,
          classes: [{ name: "REAWidget" }],
        },
      },
    });
    expect(requests.map(({ name }) => name)).toEqual([
      "open_binary",
      "find_xrefs_to_name",
      "search_strings",
      "get_objc_classes",
    ]);
  });

  it("rejects missing, truncated, and unavailable positive evidence", async () => {
    const target = { path: "/fixture", sha256: "a".repeat(64) };
    await expect(
      verifyNamedFixture({
        client: {
          callTool: async ({ name }: { name: string }) =>
            name === "find_xrefs_to_name"
              ? { status: "unresolved" }
              : { items: [] },
        },
        options: {},
        target,
        expectations: { symbols: ["missing"] },
        normalizedResult: normalize,
      }),
    ).rejects.toThrow(/expected symbol/u);
    await expect(
      verifyNamedFixture({
        client: {
          callTool: async ({ name }: { name: string }) =>
            name === "search_strings"
              ? {
                  items: [{ value: "TRUNCATED", value_truncated: true }],
                }
              : {},
        },
        options: {},
        target,
        expectations: { strings: ["TRUNCATED"] },
        normalizedResult: normalize,
      }),
    ).rejects.toThrow(/expected string/u);
  });

  it("proves version-specific symbols and strings remain absent", async () => {
    await expect(
      verifyAbsentFixtureValues({
        client: {
          callTool: async ({ name }: { name: string }) =>
            name === "find_xrefs_to_name"
              ? { status: "unresolved", name: "_rea_added" }
              : { items: [] },
        },
        options: {},
        target: { path: "/v1", sha256: "a".repeat(64) },
        symbols: ["_rea_added"],
        strings: ["REA_VERSION_TWO"],
        normalizedResult: normalize,
      }),
    ).resolves.toBeUndefined();
  });
});

const clientWithItems = (items: readonly unknown[]) => ({
  callTool: async () => ({ items }),
});

const clientReturning = (value: unknown) => ({
  callTool: async () => value,
});
