import { expect, it } from "vitest";
import { inspectCargoManifestInputSchema } from "./cargoManifestQuery.js";

it.each([
  ["a bare file name", "Cargo.toml"],
  ["a dot-relative path", "./Cargo.toml"],
  ["a parent-relative path", "../crate/Cargo.toml"],
])("refuses %s at the advertised schema", (_label, path) => {
  // The service rejects relative paths before it reads anything, so accepting
  // one here only lets a client send a call that can never run.
  expect(inspectCargoManifestInputSchema.safeParse({ path }).success).toBe(
    false,
  );
});

it("accepts an absolute manifest path", () => {
  expect(
    inspectCargoManifestInputSchema.safeParse({ path: "/tmp/Cargo.toml" })
      .success,
  ).toBe(true);
});
