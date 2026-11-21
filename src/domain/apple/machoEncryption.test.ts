import { expect, it } from "vitest";
import { machoSliceEncryptionSchema } from "./machoEncryption.js";

it("requires a malformed cause exactly for malformed slice encryption", () => {
  const slice = {
    architecture: null,
    cpu_type: null,
    cpu_subtype: null,
    container_file_offset: 0,
    size: 32,
    reason: null,
    commands: [],
    range: null,
  };
  for (const status of [
    "absent",
    "encrypted",
    "not-encrypted",
    "unknown",
    "malformed",
  ]) {
    for (const malformed_kind of [null, "structure", "duplicate-commands"]) {
      expect(
        machoSliceEncryptionSchema.safeParse({
          ...slice,
          status,
          malformed_kind,
        }).success,
        `${status}/${String(malformed_kind)}`,
      ).toBe((status === "malformed") === (malformed_kind !== null));
    }
  }
  expect(
    machoSliceEncryptionSchema.safeParse({ ...slice, status: "absent" })
      .success,
  ).toBe(false);
});
