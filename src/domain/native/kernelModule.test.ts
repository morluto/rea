import { expect, it } from "vitest";
import {
  KERNEL_MODULE_MODINFO_ENTRY_REASONS,
  inspectKernelModuleInputSchema,
} from "./kernelModule.js";

it("rejects extra caller arguments and applies kernel-module budgets", () => {
  expect(
    inspectKernelModuleInputSchema.safeParse({
      path: "/artifacts/demo.ko",
      extra: true,
    }).success,
  ).toBe(false);
  expect(
    inspectKernelModuleInputSchema.parse({ path: "/artifacts/demo.ko" }),
  ).toMatchObject({
    max_file_bytes: 67108864,
    max_entries: 8192,
  });
});

it("keeps modinfo field omission separate from entry validity", () => {
  expect(KERNEL_MODULE_MODINFO_ENTRY_REASONS).not.toContain(
    "modinfo_field_exceeds_limit",
  );
});
