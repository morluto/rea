import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { functionDossierSchema } from "../../../../src/domain/native/functionDossier.js";
import {
  jsonValueSchema,
  type JsonValue,
} from "../../../../src/domain/jsonValue.js";
import { IdaSessionClient } from "../../../../src/ida/IdaSessionClient.js";
import { createIdaTarget, RecordingIdaMcp } from "../../../fixtures/idaMcp.js";

type IdentityCase = {
  label: string;
  fields: Readonly<Record<string, JsonValue>>;
};

const observationsSchema = z.object({
  observations: z.array(
    z.object({ tool: z.string(), result: jsonValueSchema }),
  ),
});
const observation = (raw: unknown, tool: string) =>
  observationsSchema.parse(raw).observations.find((item) => item.tool === tool)
    ?.result;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const session = async (
  mode: "attached" | "headless",
  fields: Readonly<Record<string, JsonValue>>,
) => {
  const { root, target } = await createIdaTarget();
  roots.push(root);
  const producer = new RecordingIdaMcp(target, mode);
  const fn = { addr: "0x1000", name: "main", ...fields };
  const inventory = [{ data: [fn], next_offset: null }];
  const lookup = [{ query: "main", fn, error: null }];
  producer.overrideCall = (name) => {
    switch (name) {
      case "list_funcs":
        return inventory;
      case "lookup_funcs":
        return lookup;
      case "callees":
        return [{ callees: [], more: false }];
      default:
        return undefined;
    }
  };
  const client = new IdaSessionClient(
    {
      command: "fixture",
      args: [],
      env: {},
      mode,
      protocol: mode === "attached" ? "native" : "modern",
      timeoutMs: 1000,
      workspaceRoot: root,
    },
    target,
    producer,
  );
  return { client, inventoryObservation: inventory, lookupObservation: lookup };
};

describe.each(["attached", "headless"] as const)(
  "%s IDA function identity boundary",
  (mode) => {
    it.each<IdentityCase>([
      { label: "omitted", fields: {} },
      { label: "null", fields: { size: null } },
      { label: "malformed text", fields: { size: "unknown extent" } },
      { label: "malformed object", fields: { size: { unavailable: true } } },
    ])(
      "retains usable inventory and dossier identity with $label size and preserves exact observations",
      async ({ fields }) => {
        const fixture = await session(mode, fields);
        try {
          const inventory = await fixture.client.execute("list_procedures", {});
          if (!inventory.ok) throw inventory.error;
          expect(inventory.value.result).toEqual([
            { address: "0x1000", value: "main" },
          ]);
          expect(observation(inventory.value.rawResult, "list_funcs")).toEqual(
            fixture.inventoryObservation,
          );

          const analyzed = await fixture.client.execute("analyze_function", {
            procedure: "main",
          });
          if (!analyzed.ok) throw analyzed.error;
          const dossier = functionDossierSchema.parse(analyzed.value.result);
          expect(dossier.procedure).toMatchObject({
            address: "0x1000",
            name: "main",
            body: { available: false, reason: expect.any(String) },
          });
          expect(observation(analyzed.value.rawResult, "lookup_funcs")).toEqual(
            fixture.lookupObservation,
          );
        } finally {
          expect((await fixture.client.close()).ok).toBe(true);
        }
      },
    );

    it.each<IdentityCase>([
      { label: "address", fields: { address: "invalid", addr: "invalid" } },
      { label: "null name", fields: { name: null } },
      { label: "empty name", fields: { name: "" } },
    ])("rejects malformed $label despite unused size", async ({ fields }) => {
      const fixture = await session(mode, {
        ...fields,
        size: "unknown extent",
      });
      try {
        for (const operation of [
          "list_procedures",
          "procedure_address",
        ] as const) {
          const result = await fixture.client.execute(
            operation,
            operation === "procedure_address" ? { procedure: "main" } : {},
          );
          if (result.ok) throw new Error("Expected malformed identity to fail");
          expect(result.error._tag).toBe("AnalysisOutputError");
          const partial = result.error.partialObservation;
          if (partial === undefined || !("raw_result" in partial))
            throw new Error("Expected retained IDA Evidence");
          expect(
            observation(
              partial.raw_result,
              operation === "list_procedures" ? "list_funcs" : "lookup_funcs",
            ),
          ).toEqual(
            operation === "list_procedures"
              ? fixture.inventoryObservation
              : fixture.lookupObservation,
          );
        }
      } finally {
        expect((await fixture.client.close()).ok).toBe(true);
      }
    });
  },
);

it("preserves unknown native instruction body bounds despite an upstream size", async () => {
  const { client, lookupObservation } = await session("attached", {
    size: { bytes: 32 },
  });
  try {
    const result = await client.execute("read_function_instructions", {
      procedure: "main",
    });
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({
      procedure: {
        address: "0x1000",
        name: "main",
        body: {
          available: false,
          reason: expect.stringContaining("complete function body ranges"),
        },
      },
    });
    expect(observation(result.value.rawResult, "lookup_funcs")).toEqual(
      lookupObservation,
    );
  } finally {
    expect((await client.close()).ok).toBe(true);
  }
});
