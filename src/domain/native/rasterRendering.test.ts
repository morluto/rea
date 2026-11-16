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
