import { peImportImage } from "../../../fixtures/binaryDiagnostics/peImports.js";
import { peLoadConfigImage } from "../../../../src/native/pe/PeLoadConfig.fixture.js";
import { targetFailureReaders, type TargetFailureCase } from "../registry.js";

/** A valid image whose DOS signature is replaced, so the PE owner refuses it. */
const withoutMz = (
  image: (options: { readonly bits: 32 | 64 }) => Buffer,
): TargetFailureCase[] =>
  ([32, 64] as const).flatMap((bits) =>
    (
      [
        ["zz", Buffer.from("ZZ")],
        ["high-bit", Buffer.from([0xcd, 0xda])],
      ] as const
    ).map(([name, prefix]) => ({
      name: `pe${String(bits)}-${name}-dos-signature`,
      kind: "malformed" as const,
      bytes: () => {
        const bytes = image({ bits });
        prefix.copy(bytes);
        return bytes;
      },
      identity: false,
    })),
  );

/** PE readers that refuse a corrupt DOS header before reading their tables. */
export default targetFailureReaders([
  { operation: "inspect_pe_imports", cases: withoutMz(peImportImage) },
  { operation: "inspect_pe_load_config", cases: withoutMz(peLoadConfigImage) },
]);
