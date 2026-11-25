import {
  fatImage,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { buildManagedPeFixture } from "../../../../src/dotnet/ManagedPe.fixture.js";
import { peCertificateFixture } from "../../../../src/native/pe/PeCertificates.fixture.js";
import { appleIpsBytes } from "../../../fixtures/binaryDiagnostics/appleIps.js";
import { targetFailureReaders, type TargetFailureCase } from "../registry.js";

/** An ELF magic with nothing after it: every ELF-reading owner refuses it. */
const truncatedElfHeader: TargetFailureCase = {
  name: "elf-magic-only",
  kind: "malformed",
  bytes: () => Buffer.from("\x7fELF"),
  identity: true,
};

/** A managed PE whose first section's raw data starts past the end of the file. */
const managedSectionPastEof = (): Buffer => {
  const bytes = buildManagedPeFixture();
  const pe = bytes.readUInt32LE(0x3c);
  const sections = pe + 24 + bytes.readUInt16LE(pe + 20);
  bytes.writeUInt32LE(bytes.length + 0x1000, sections + 20);
  return bytes;
};

/** A universal Mach-O whose first declared slice runs into the second. */
const overlappingUniversalMacho = (): Buffer => {
  const slice = (type: number, subtype: number) => ({
    cpu: { type, subtype },
    bytes: machoImage({ cpu: { type, subtype }, wide: true }),
  });
  const bytes = Buffer.from(
    fatImage([slice(0x01000007, 3), slice(0x0100000c, 0)]),
  );
  const first = bytes.readUInt32BE(8 + 8);
  const second = bytes.readUInt32BE(8 + 20 + 8);
  bytes.writeUInt32BE(second - first + 16, 8 + 12);
  return bytes;
};

/** A universal Mach-O cut off inside its FAT table: 20 of its 48 table bytes. */
const truncatedUniversalMacho = (): Buffer => {
  const slice = (type: number, subtype: number) => ({
    cpu: { type, subtype },
    bytes: machoImage({ cpu: { type, subtype }, wide: true }),
  });
  return Buffer.from(
    fatImage([slice(0x01000007, 3), slice(0x0100000c, 0)]),
  ).subarray(0, 20);
};

/** A PE image whose first WIN_CERTIFICATE declares less than its own header. */
const shortCertificateHeader = (): Buffer => {
  const bytes = peCertificateFixture();
  bytes.writeUInt32LE(4, bytes.readUInt32LE(0x98 + 96 + 4 * 8));
  return bytes;
};

const truncatedSlices: TargetFailureCase = {
  name: "macho-fat-table-cut-off",
  kind: "truncated",
  bytes: truncatedUniversalMacho,
  facts: { format: "macho", available_bytes: 20, required_bytes: 48 },
  cli: ["--architecture", "arm64"],
  mcp: { architecture: "arm64" },
  identity: true,
};

const managedCase: TargetFailureCase = {
  name: "pe-cli-section-past-eof",
  kind: "malformed",
  bytes: managedSectionPastEof,
  facts: { format: "pe-cli", field: "pe.section-data" },
  identity: false,
};

const overlappingSlices: TargetFailureCase = {
  name: "macho-overlapping-slices",
  kind: "malformed",
  bytes: overlappingUniversalMacho,
  facts: { format: "macho", reason: "Mach-O slices 0 and 1 overlap." },
  cli: ["--architecture", "arm64"],
  mcp: { architecture: "arm64" },
  identity: true,
};

/**
 * Selected-file readers whose format owner raises its parse failure once.
 * The selected file's bytes are at fault, not the request.
 */
export default targetFailureReaders([
  ...[
    "inspect_python_pyc",
    "inspect_elf_notes",
    "inspect_elf_dependencies",
    "inspect_elf_debug_link",
    "inspect_elf_unwind_ranges",
    "inspect_devicetree",
    "inspect_pe_imports",
    "inspect_kernel_module",
    "inspect_pe_load_config",
    "inspect_pe_resources",
    "inspect_native_exports",
    "inspect_binary_hardening",
  ].map((operation) => ({ operation, cases: [truncatedElfHeader] })),
  ...[
    "inspect_go_binary",
    "inspect_rust_binary",
    "inspect_native_initializers",
  ].map((operation) => ({
    operation,
    cases: [truncatedElfHeader, overlappingSlices, truncatedSlices],
  })),
  {
    operation: "inspect_dwarf_units",
    cases: [overlappingSlices, truncatedSlices],
  },
  {
    operation: "inspect_apple_ips",
    cases: [
      truncatedElfHeader,
      {
        // The JSON body ends inside its declared report object.
        name: "ips-truncated-body",
        kind: "malformed",
        bytes: () => appleIpsBytes({ truncateBody: true }),
        identity: true,
      },
    ],
  },
  {
    operation: "inspect_erlang_beam",
    cases: [
      truncatedElfHeader,
      {
        name: "beam-form-header-only",
        kind: "truncated",
        bytes: () => Buffer.from("FOR1"),
        facts: { format: "beam" },
        identity: true,
      },
    ],
  },
  {
    operation: "inspect_pe_certificates",
    cases: [
      truncatedElfHeader,
      {
        name: "short-certificate-header",
        kind: "malformed",
        bytes: shortCertificateHeader,
        facts: { format: "pe-certificate-table" },
        identity: true,
      },
    ],
  },
  ...[
    "inspect_managed_artifact",
    "inspect_managed_members",
    "inspect_managed_native_boundaries",
  ].map((operation) => ({ operation, cases: [managedCase] })),
]);
