import { nodeSeaElf } from "../../../../src/artifacts/nodeSea/NodeSea.fixture.js";
import { zipArchive } from "../../../../src/domain/desktop/zipArchive.fixture.js";
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

const containerCases: readonly TargetFailureCase[] = [
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
  {
    name: "node-sea-blob-magic",
    kind: "malformed",
    bytes: () => nodeSeaElf({ blob: Buffer.alloc(16) }),
    facts: {
      format: "node-sea",
      reason: "Node SEA blob magic is not 0x143da20",
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
