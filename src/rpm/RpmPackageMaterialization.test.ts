import { expect, it, vi } from "vitest";
import { RpmPackageMaterialization } from "./RpmPackageMaterialization.js";

it("refuses cumulative known vectors before their next materialization", () => {
  const budget = new RpmPackageMaterialization({ values: 3, textBytes: 8 });
  budget.values(2);
  budget.values(1);
  expect(() => budget.values(1)).toThrowError(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: { name: "materialized_values", maximum: 3, required: 4 },
      }),
    }),
  );
});

it("admits decoded text once per raw value and refuses repeated stored extents before decoding", () => {
  const budget = new RpmPackageMaterialization({ values: 3, textBytes: 3 });
  const bytes = Buffer.from("abc");
  const decode = vi.fn(() => "abc");
  expect(budget.text(bytes, decode)).toBe("abc");
  expect(budget.text(bytes, decode)).toBe("abc");
  expect(decode).toHaveBeenCalledTimes(1);
  const repeated = vi.fn(() => "abc");
  expect(() => budget.text(bytes.subarray(), repeated)).toThrowError(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: { name: "decoded_text_bytes", maximum: 3, required: 6 },
      }),
    }),
  );
  expect(repeated).not.toHaveBeenCalled();
});
