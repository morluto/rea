import { expect, it } from "vitest";
import { inspectRpmPackageInputSchema, rpmPackageSchema } from "./package.js";

it("keeps missing optional identity tags distinct from zero", () => {
  const parsed = inspectRpmPackageInputSchema.parse({
    path: "/artifacts/demo.rpm",
  });
  expect(parsed.include_script_text).toBe(false);
  expect(parsed.max_file_bytes).toBe(67108864);
  expect(rpmPackageSchema.shape.package.shape.epoch.safeParse(0).success).toBe(
    true,
  );
  expect(
    rpmPackageSchema.shape.package.shape.epoch.safeParse(null).success,
  ).toBe(true);
  expect(rpmPackageSchema.shape.coverage.shape.status.parse("complete")).toBe(
    "complete",
  );
});

it("rejects silent empty strings for optional identity text", () => {
  expect(rpmPackageSchema.shape.package.shape.name.safeParse("").success).toBe(
    false,
  );
  expect(
    rpmPackageSchema.shape.package.shape.license.safeParse("").success,
  ).toBe(false);
});
