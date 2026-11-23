import { expect, it } from "vitest";
import { buildManagedPeFixture } from "../../scripts/fixtures/managed/pe.mjs";
import { managedDecodeBudget } from "../domain/managed/managedDecodeBudget.js";
import { createManagedFieldConstantReader } from "./ManagedFieldConstants.js";
import { readManagedMetadataLayout } from "../domain/managed/managedMetadataLayout.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";

it("uses the layout's existing representation capacity instead of an independent constant budget", () => {
  const bytes = buildManagedPeFixture({
    fields: [{ name: "Default", flags: 0x8056 }],
    constants: [{ typeCode: 8, value: Buffer.from("01000000", "hex") }],
  });
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture has no CLI metadata");
  const { rva, size } = pe.cli.metadata;
  const offset = pe.rvaToOffset(rva, size, "metadata");
  const layout = readManagedMetadataLayout(bytes, offset, size, 4096);
  const alreadyUsed = readManagedMetadataLayout(bytes, offset, size, 4096);
  expect(
    createManagedFieldConstantReader(bytes, layout, [])(1, 0x8056),
  ).toMatchObject({
    state: "decoded",
    value: 1,
  });

  // Earlier facets of the same inspection leave under 576 bytes available.
  managedDecodeBudget(alreadyUsed).reserve(3520, null);
  const read = createManagedFieldConstantReader(bytes, alreadyUsed, []);
  expect(() => read(1, 0x8056)).toThrow(
    expect.objectContaining({
      issue: expect.objectContaining({
        scope: "metadata.representation",
        limit: expect.objectContaining({
          parameter: "max_metadata_representation_bytes",
          effective_value: 4096,
        }),
      }),
    }),
  );
});
