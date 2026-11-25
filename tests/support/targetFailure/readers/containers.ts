import { zipArchive } from "../../../../src/domain/desktop/zipArchive.fixture.js";
import { buildIso9660Image } from "../../../../src/domain/iso9660/iso9660.fixture.js";
import { INTEL_HEX_I32_GAP } from "../../../../src/domain/firmware/hexRecords.fixture.js";
import {
  RP2040_FAMILY,
  uf2Block,
  uf2File,
  uf2Image,
} from "../../../../src/domain/firmware/uf2.fixture.js";
import { targetFailureReaders, type TargetFailureCase } from "../registry.js";

/** A ZIP whose central directory places its only member past the end of the file. */
const zipMemberPastEof = (): Buffer => {
  const bytes = zipArchive([
    { name: "member.bin", data: "valid member bytes" },
  ]);
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (central < 0) throw new Error("Expected a ZIP central directory");
  bytes.writeUInt32LE(bytes.length + 1024, central + 42);
  return bytes;
};

/** Two UF2 blocks that write different bytes to the same RP2040 address. */
const conflictingUf2 = (): Buffer =>
  Buffer.from(
    uf2File([
      ...uf2Image(RP2040_FAMILY, 0x1000_0000, Buffer.from([0x01, 0x02])),
      uf2Block({
        address: 0x1000_0000,
        payload: [0xff],
        blockNo: 0,
        numBlocks: 1,
        familyId: RP2040_FAMILY,
      }),
    ]),
  );

/** An ISO 9660 image whose subdirectory record points back at the root. */
const iso9660DirectoryCycle = (): Buffer => {
  const { bytes, layout } = buildIso9660Image({
    files: [{ path: "dir/a.txt", bytes: Buffer.from("a") }],
  });
  const record = layout.primaryRecords.get("dir");
  const root = layout.directoryBlocks.get("");
  if (record === undefined || root === undefined)
    throw new Error("Expected the ISO 9660 fixture's directory layout");
  bytes.writeUInt32LE(root, record + 2);
  bytes.writeUInt32BE(root, record + 6);
  return bytes;
};

/** An ISO 9660 image cut one byte into its only file's extent. */
const iso9660ExtentCutOff = (): Buffer => {
  const { bytes, layout } = buildIso9660Image({
    files: [{ path: "top.txt", bytes: Buffer.from("cut-off download\n") }],
  });
  const record = layout.primaryRecords.get("top.txt");
  if (record === undefined)
    throw new Error("Expected the ISO 9660 fixture's file record");
  return bytes.subarray(0, bytes.readUInt32LE(record + 2) * 2048 + 1);
};

const containerCases: readonly TargetFailureCase[] = [
  {
    name: "iso9660-directory-cycle",
    kind: "malformed",
    bytes: iso9660DirectoryCycle,
    facts: { format: "iso9660", field: "extent_location" },
    identity: false,
  },
  {
    name: "iso9660-extent-cut-off",
    kind: "truncated",
    bytes: iso9660ExtentCutOff,
    facts: { format: "iso9660", field: "data_length" },
    identity: false,
  },
  {
    name: "zip-member-past-eof",
    kind: "malformed",
    bytes: zipMemberPastEof,
    facts: {
      format: "zip",
      reason:
        "ZIP archive is malformed: read at 1162 extends beyond the 138-byte archive",
    },
    identity: false,
  },
  {
    name: "intel-hex-record-checksum",
    kind: "malformed",
    bytes: () => Buffer.from(INTEL_HEX_I32_GAP.replace("BEEFC3", "BEEFC4")),
    facts: {
      format: "intel-hex",
      reason:
        "Intel HEX is malformed: line 4: record type 00 checksum 0xc4 does not match computed 0xc3",
    },
    identity: false,
  },
  {
    name: "uf2-conflicting-rewrite",
    kind: "malformed",
    bytes: conflictingUf2,
    facts: {
      format: "uf2",
      reason:
        "UF2 is malformed: family 0xe48bff56 (RP2040) address 0x10000000 is written with different values by block 0 (0x01) and block 1 (0xff)",
    },
    identity: false,
  },
];

/**
 * Container readers that inventory the selected file. Each refusal is the
 * selected target's failure, whichever member the reader was reading.
 * `inspect_artifact` reads the session's open target through MCP.
 */
export default targetFailureReaders([
  { operation: "inspect_artifact", session: true, cases: containerCases },
]);
