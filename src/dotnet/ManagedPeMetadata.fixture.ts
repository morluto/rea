import { readManagedMetadataLayout } from "../domain/managed/managedMetadataLayout.js";
import { readManagedPeLayout } from "../domain/managed/managedPeReader.js";

/** Read the CLI metadata layout of a managed PE test fixture. */
export const readManagedFixtureMetadataLayout = (bytes: Buffer) => {
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  const { rva, size } = pe.cli.metadata;
  return readManagedMetadataLayout(
    bytes,
    pe.rvaToOffset(rva, size, "cli.metadata"),
    size,
  );
};
