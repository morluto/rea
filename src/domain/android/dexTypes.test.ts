import { expect, it } from "vitest";
import { dexDescriptorSchema, dexTypeSchema } from "./dexTypes.js";
import { androidJniSelectionSchema } from "./androidJniBindings.js";

it.each(["I", "Ljava/lang/String;"])(
  "bounds each %s array at the DEX format's 255 dimensions",
  (element) => {
    for (const dimensions of [0, 1, 255, 256]) {
      const type = "[".repeat(dimensions) + element;
      const valid = dimensions <= 255;
      expect(dexTypeSchema.safeParse(type).success).toBe(valid);
      for (const descriptor of [`(${type})V`, `()${type}`, `(I${type}J)V`]) {
        expect(dexDescriptorSchema.safeParse(descriptor).success).toBe(valid);
        expect(
          androidJniSelectionSchema.safeParse({ descriptors: [descriptor] })
            .success,
        ).toBe(valid);
      }
    }
  },
);

it("applies the array bound per type while preserving void only for returns", () => {
  const array = "[".repeat(255) + "I";
  expect(
    dexDescriptorSchema.safeParse(`(${array}${array})${array}`).success,
  ).toBe(true);
  expect(dexDescriptorSchema.safeParse("()V").success).toBe(true);
  for (const descriptor of ["(V)V", "()[V", "([V)V"])
    expect(dexDescriptorSchema.safeParse(descriptor).success).toBe(false);
  expect(dexTypeSchema.safeParse("V").success).toBe(false);
});
