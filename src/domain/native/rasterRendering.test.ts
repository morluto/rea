import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { expect, it } from "vitest";
import {
  rasterColorPolicyInputSchema,
  rasterRegistrySelectionInputSchema,
} from "./rasterRendering.js";
it("requires every family color choice and disallows caller palette ranges", () => {
  const policy = {
    kind: "record12-lut-registry",
    theme_slot: 0,
    precision: "byte8",
    alpha: "palette",
    sentinel: "profile",
    rgb565_color_key: null,
  };
  expect(rasterColorPolicyInputSchema.safeParse(policy).success).toBe(true);
  for (const key of Object.keys(policy).filter((k) => k !== "kind")) {
    const copy = { ...policy };
    delete copy[key as keyof typeof copy];
    expect(rasterColorPolicyInputSchema.safeParse(copy).success).toBe(false);
  }
  expect(
    rasterColorPolicyInputSchema.safeParse({
      ...policy,
      paletteRange: { offset: 0, length: 1024 },
    }).success,
  ).toBe(false);
  expect(
    rasterColorPolicyInputSchema.safeParse({
      kind: "rgba-palette",
      entries: [[1, 2, 3, 4]],
    }).success,
  ).toBe(false);
  expect(
    rasterColorPolicyInputSchema.safeParse({
      kind: "rgba-palette",
      entries: [[1, 2, 3, 256]],
      index_space: "selector",
      sentinel: "disabled",
    }).success,
  ).toBe(false);
});
it("allows exact signed pointer bias but not unsafe registry coordinates", () => {
  expect(
    rasterRegistrySelectionInputSchema.parse({ offset: 0, pointer_bias: -100 }),
  ).toEqual({ offset: 0, pointer_bias: -100 });
  for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(
      rasterRegistrySelectionInputSchema.safeParse({ offset, pointer_bias: 0 })
        .success,
    ).toBe(false);
});

it("advertises exact RGBA tuples with useful item guidance", () => {
  const converted = z.toJSONSchema(rasterColorPolicyInputSchema);
  const palette = converted.oneOf?.find((branch) => {
    if (typeof branch === "boolean") return false;
    const kind = branch.properties?.kind;
    return typeof kind === "object" && kind.const === "rgba-palette";
  });
  if (!palette || typeof palette !== "object")
    throw new Error("Palette schema is missing");
  const entriesSchema = palette.properties?.entries;
  if (!entriesSchema || typeof entriesSchema !== "object")
    throw new Error("Entries schema is missing");
  const entry = entriesSchema.items;
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    throw new Error("RGBA entry schema is missing");
  expect(entry).toMatchObject({ minItems: 4, maxItems: 4 });
  expect(typeof entry.items).toBe("object");
  const validate = new Ajv2020({ strict: false }).compile(converted);
  for (const [entries, accepted] of [
    [[[0, 1, 254, 255]], true],
    [[[0, 1, 2]], false],
    [[[0, 1, 2, 3, 4]], false],
    [[[0, 1, 2, 256]], false],
    [[[0, 1, 2, "3"]], false],
  ] as const) {
    const value = {
      kind: "rgba-palette",
      entries,
      index_space: "selector",
      sentinel: "disabled",
    };
    expect(validate(value)).toBe(accepted);
    expect(rasterColorPolicyInputSchema.safeParse(value).success).toBe(
      accepted,
    );
  }
});
