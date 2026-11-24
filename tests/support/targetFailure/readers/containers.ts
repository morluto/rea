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
    facts: { format: "zip" },
    identity: false,
  },
  {
    name: "intel-hex-record-checksum",
    kind: "malformed",
    bytes: () => Buffer.from(INTEL_HEX_I32_GAP.replace("BEEFC3", "BEEFC4")),
    facts: { format: "intel-hex" },
    identity: false,
  },
  {
    name: "uf2-conflicting-rewrite",
    kind: "malformed",
    bytes: conflictingUf2,
    facts: { format: "uf2" },
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
