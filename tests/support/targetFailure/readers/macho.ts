import {
  fatImage,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { targetFailureReaders, type TargetFailureCase } from "../registry.js";

/**
 * A universal Mach-O whose second slice is declared 4096 bytes longer than
 * the file holds: a cut-off download, with the declared extent measured.
 */
const slicePastEof = (): Buffer => {
  const slice = (type: number, subtype: number) => ({
    cpu: { type, subtype },
    bytes: machoImage({ cpu: { type, subtype }, wide: true }),
  });
  const bytes = Buffer.from(
    fatImage([slice(0x01000007, 3), slice(0x0100000c, 0)]),
  );
  const size = bytes.readUInt32BE(8 + 20 + 12);
  bytes.writeUInt32BE(size + 4096, 8 + 20 + 12);
  return bytes;
};

const truncatedSlice: TargetFailureCase = {
  name: "macho-slice-past-eof",
  kind: "truncated",
  bytes: slicePastEof,
  facts: { format: "macho", field: "fat_arch[1]" },
  cli: ["--architecture", "arm64"],
  mcp: { architecture: "arm64" },
  identity: true,
};

/** Universal Mach-O readers report a slice that leaves the file as truncated. */
export default targetFailureReaders(
  [
    "inspect_go_binary",
    "inspect_rust_binary",
    "inspect_native_initializers",
    "inspect_dwarf_units",
  ].map((operation) => ({ operation, cases: [truncatedSlice] })),
);
