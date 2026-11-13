import { createHash } from "node:crypto";

import {
  metadataSignature,
  type SignatureDisplayTypeName,
  type SignatureTypeName,
} from "../../src/dotnet/ManagedMemberInspectorCore.js";
import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { readManagedMetadataLayout } from "../../src/dotnet/ManagedMetadataLayout.js";
import { readManagedPeLayout } from "../../src/dotnet/ManagedPeReader.js";

// Supply real metadata rows for the TypeDefOrRef coordinates used by the
// signature grammar and identity cases.
const bytes = buildManagedPeFixture({
  typeSpecSignatures: [Buffer.from([0x08])],
  typeReferences: Array.from({ length: 9 }, (_, index) => ({
    namespace: "Fixture",
    name: `Type${String(index + 2)}`,
  })),
});
const pe = readManagedPeLayout(bytes);
if (pe.cli === null) throw new Error("Fixture has no CLI metadata");
const layout = readManagedMetadataLayout(
  bytes,
  pe.rvaToOffset(pe.cli.metadata.rva, pe.cli.metadata.size, "cli.metadata"),
  pe.cli.metadata.size,
);

export const signature = (
  blob: Buffer,
  rawSha256?: string,
  typeName: SignatureTypeName = () => null,
  displayTypeName?: SignatureDisplayTypeName,
) =>
  metadataSignature(blob, {
    rawSha256: rawSha256 ?? createHash("sha256").update(blob).digest("hex"),
    typeName,
    displayTypeName,
    layout,
    issues: [],
    scope: "fixture.signature",
    blobOffset: 0,
  });
