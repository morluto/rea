import { describe, expect, it } from "vitest";

import {
  analyzeFixtureProcedure,
  requireCurrentDocument,
  resolveFixtureProcedure,
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
});

const clientWithItems = (items: readonly unknown[]) => ({
  callTool: async () => ({ items }),
});

const clientReturning = (value: unknown) => ({
  callTool: async () => value,
});
