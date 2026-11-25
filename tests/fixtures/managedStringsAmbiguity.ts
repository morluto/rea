import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { readManagedMetadataLayout } from "../../src/domain/managed/managedMetadataLayout.js";
import { readManagedPeLayout } from "../../src/domain/managed/managedPeReader.js";
import {
  duplicateManagedHeap,
  type DuplicateHeapVariant,
} from "./managedDuplicateMetadataHeap.js";

export const STRING_AMBIGUITY_MVID = "11111111-1111-1111-1111-111111111111";

export const managedStringsAmbiguity = (
  variant: DuplicateHeapVariant,
  options: {
    readonly nilName?: boolean;
    readonly ambiguousGuid?: boolean;
    readonly multipleModules?: boolean;
    readonly invalidEnc?: boolean;
  } = {},
) => {
  const bytes = buildManagedPeFixture({
    mvid: Buffer.alloc(16, 0x11),
    moduleRowCount: options.multipleModules === true ? 2 : 1,
    targetFramework: null,
  });
  const pe = readManagedPeLayout(bytes);
  if (pe.cli === null) throw new Error("Fixture omitted CLI metadata");
  const { size, rva } = pe.cli.metadata;
  const root = pe.rvaToOffset(rva, size, "fixture metadata");
  const layout = readManagedMetadataLayout(bytes, root, size);
  const module = layout.table(0);
  if (module === undefined) throw new Error("Fixture omitted its Module row");
  // This small fixture uses 16-bit heap indices. Generation, Name and three
  // GUID indices occupy the first five words. Two fields refer to GUID slot 1.
  bytes.writeUInt16LE(2, module.offset);
  if (options.nilName === true) bytes.writeUInt16LE(0, module.offset + 2);
  bytes.writeUInt16LE(options.invalidEnc === true ? 2 : 1, module.offset + 6);
  const nameIndex = bytes.readUInt16LE(module.offset + 2);
  if (options.multipleModules === true)
    bytes.writeUInt16LE(0, module.offset + module.rowSize + 4);
  const source =
    options.ambiguousGuid === true
      ? duplicateManagedHeap(bytes, "#GUID", Buffer.alloc(16, 0x22), "forward")
          .bytes
      : bytes;
  const alternate = Buffer.from("\0Alternate.dll\0", "utf8");
  return {
    ...duplicateManagedHeap(source, "#Strings", alternate, variant),
    nameIndex,
  };
};
