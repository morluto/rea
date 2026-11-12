import { readManagedMetadataLayout } from "../../src/dotnet/ManagedMetadataLayout.js";
import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { readManagedPeLayout } from "../../src/dotnet/ManagedPeReader.js";
import { readTypeDefinitionRowFacts } from "../../src/dotnet/ManagedTypeDefinitionRows.js";

/** Select TypeDef list coordinates while retaining the fixture's readable member rows. */
export const managedMemberListStartsFixture = (
  fields: readonly number[],
  methods: readonly number[],
): Buffer => {
  if (fields.length === 0 || fields.length !== methods.length)
    throw new Error("Each fixture TypeDef needs both list coordinates");
  const bytes = buildManagedPeFixture({
    additionalEmptyTypes: fields.length - 1,
  });
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  const { rva, size } = pe.cli.metadata;
  const layout = readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(rva, size, "cli.metadata"),
    size,
  );
  for (const [index, field] of fields.entries()) {
    const row = readTypeDefinitionRowFacts(bytes, layout, index + 1);
    bytes.writeUInt16LE(field, row.fieldListOffset);
    bytes.writeUInt16LE(methods[index]!, row.methodListOffset);
  }
  return bytes;
};
