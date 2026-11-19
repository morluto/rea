import { expect, it } from "vitest";
import { inspectKernelBuildConfigInputSchema } from "./kernelBuildConfig.js";

it("rejects extra caller arguments and applies kernel build config budgets", () => {
  expect(
    inspectKernelBuildConfigInputSchema.safeParse({
      path: "/artifacts/vmlinux",
      extra: true,
    }).success,
  ).toBe(false);
  expect(
    inspectKernelBuildConfigInputSchema.safeParse({
      path: "/artifacts/vmlinux",
      name: "SECURITY_SELINUX",
    }).success,
  ).toBe(false);
  expect(
    inspectKernelBuildConfigInputSchema.parse({ path: "/artifacts/vmlinux" }),
  ).toMatchObject({
    max_file_bytes: 67108864,
    max_entries: 16384,
    max_config_bytes: 4194304,
    max_payload_bytes: 134217728,
    offset: 0,
    limit: 256,
  });
});
