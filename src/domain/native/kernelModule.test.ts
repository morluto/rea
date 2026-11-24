import { expect, it } from "vitest";
import {
  inspectKernelModuleInputSchema,
  kernelModuleSchema,
} from "./kernelModule.js";

it("applies the default kernel-module read and entry budgets", () => {
  expect(
    inspectKernelModuleInputSchema.parse({ path: "/artifacts/demo.ko" }),
  ).toMatchObject({
    max_file_bytes: 67108864,
    max_entries: 8192,
  });
});

it("limits the external recovery probe to decompression", () => {
  expect(
    kernelModuleSchema.shape.next_probe.safeParse({
      operation: "extract_artifact",
      rationale: "Test declared operation",
    }).success,
  ).toBe(false);
});
