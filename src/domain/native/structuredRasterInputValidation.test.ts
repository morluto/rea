import { expect, it } from "vitest";
import * as schemas from "./structuredRasterCandidates.js";
import { DEFAULT_STRUCTURED_RASTER_GRAMMAR } from "../structuredRasterDiscovery.js";

it("validates the grammar relation at the canonical input boundary", () => {
  const result = schemas.inspectStructuredRasterCandidatesInputSchema.safeParse(
    {
      path: "/source",
      grammar: { ...DEFAULT_STRUCTURED_RASTER_GRAMMAR, scanAlignment: 5 },
    },
  );
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues[0]?.path).toEqual(["grammar", "scanAlignment"]);
});
it("preserves omitted request controls while resolving analysis defaults separately", () => {
  const request = schemas.inspectStructuredRasterCandidatesRequestSchema;
  expect(request).toBeDefined();
  expect(request.parse({ path: "/source" })).toEqual({ path: "/source" });
  expect(
    schemas.inspectStructuredRasterCandidatesInputSchema.parse({
      path: "/source",
    }),
  ).toMatchObject({
    offset: 0,
    profile: "flat",
    min_records: 8,
    max_records: 4096,
    max_previews: 4,
  });
});

it.each([
  [{ min_records: 9, max_records: 8 }, ["max_records"]],
  [{ profile: "fgs-records", offset: 1 }, ["offset"]],
  [
    {
      profile: "fgs-records",
      segments: [{ logicalOffset: 0, fileOffset: 0, length: 4 }],
    },
    ["segments"],
  ],
  [
    {
      grammar: {
        ...DEFAULT_STRUCTURED_RASTER_GRAMMAR,
        fields: {
          ...DEFAULT_STRUCTURED_RASTER_GRAMMAR.fields,
          width: { offset: 0, byteWidth: 2 },
        },
      },
    },
    ["grammar", "fields", "width"],
  ],
  [
    {
      grammar: {
        ...DEFAULT_STRUCTURED_RASTER_GRAMMAR,
        fields: {
          ...DEFAULT_STRUCTURED_RASTER_GRAMMAR.fields,
          payloadOffset: { offset: 10, byteWidth: 4 },
        },
      },
    },
    ["grammar", "fields", "payloadOffset"],
  ],
] as const)(
  "uses the same semantic paths for caller and resolved schemas: %j",
  (controls, path) => {
    for (const schema of [
      schemas.inspectStructuredRasterCandidatesRequestSchema,
      schemas.inspectStructuredRasterCandidatesInputSchema,
    ]) {
      const result = schema.safeParse({ path: "/source", ...controls });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues[0]?.path).toEqual([...path]);
    }
  },
);
it("preserves explicit zero and nested false controls without injecting omitted fields", () => {
  const grammar = {
    ...DEFAULT_STRUCTURED_RASTER_GRAMMAR,
    requireZeroReserved: false,
    requireMonotonicOffsets: false,
    maxFormat: 0,
  };
  const input = { path: "/source", offset: 0, max_previews: 0, grammar };
  expect(
    schemas.inspectStructuredRasterCandidatesRequestSchema.parse(input),
  ).toEqual(input);
});

it("admits explicit family/color controls without inventing omitted choices", () => {
  const request = schemas.inspectStructuredRasterCandidatesRequestSchema.parse({
    path: "/tmp/source",
    resource_family: "record12-lut-registry",
    family_max_work: 100,
    color_policy: {
      kind: "record12-lut-registry",
      theme_slot: 0,
      precision: "byte8",
      alpha: "opaque",
      sentinel: "disabled",
      rgb565_color_key: null,
    },
  });
  expect(request).not.toHaveProperty("max_previews");
  expect(request).toHaveProperty("family_max_work", 100);
});

it("reports the effective diagnostic rendering default without adding it to caller parameters", () => {
  expect(
    schemas.inspectStructuredRasterCandidatesRequestSchema.parse({
      path: "/source",
    }),
  ).not.toHaveProperty("color_policy");
  expect(
    schemas.inspectStructuredRasterCandidatesInputSchema.parse({
      path: "/source",
    }),
  ).toHaveProperty("color_policy", { kind: "diagnostic-indices" });
});
