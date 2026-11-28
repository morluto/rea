import { describe, expect, it, vi } from "vitest";

import { bindMetadataCommitment } from "./solidityMetadataBinding.js";
import type { SolidityMetadata } from "./solidityMetadata.js";

const HASH = `1220${"ab".repeat(32)}`;
type Entry = SolidityMetadata["entries"][number];
const entry = (key: string, hex: string): Entry => ({
  key: { kind: "text", value: key },
  value: { kind: "bytes", value: hex },
});
const trailer = (
  entries: Entry[],
  status: SolidityMetadata["status"] = "decoded",
): SolidityMetadata => ({
  profile: "terminal-cbor-scalars-v1",
  status,
  bytecode_offset: 0,
  cbor_bytes: 1,
  entries,
  compiler_version: null,
  diagnostic: null,
});
const computes = (hex: string | undefined) => () =>
  hex === undefined ? undefined : Buffer.from(hex, "hex");

describe("metadata commitment binding", () => {
  it("reports a match with both hashes", () => {
    expect(
      bindMetadataCommitment(trailer([entry("ipfs", HASH)]), computes(HASH)),
    ).toEqual({
      status: "match",
      reason: null,
      scheme: "ipfs",
      recorded: HASH,
      computed: HASH,
    });
  });

  it("reports a different file as a mismatch", () => {
    const other = `1220${"cd".repeat(32)}`;
    expect(
      bindMetadataCommitment(trailer([entry("ipfs", HASH)]), computes(other)),
    ).toMatchObject({ status: "mismatch", recorded: HASH, computed: other });
  });

  it.each([
    ["no_decoded_trailer", trailer([], "not-decoded")],
    ["no_commitment", trailer([entry("solc", "00081e")])],
    [
      "multiple_commitments",
      trailer([entry("ipfs", HASH), entry("bzzr1", HASH)]),
    ],
    ["unsupported_scheme", trailer([entry("bzzr0", "ab".repeat(32))])],
    ["unsupported_scheme", trailer([entry("bzzr1", "ab".repeat(32))])],
    ["unrecognized_commitment", trailer([entry("ipfs", "ab".repeat(32))])],
  ])("stays unverified: %s", (reason, metadata) => {
    const compute = vi.fn(computes(HASH));
    expect(bindMetadataCommitment(metadata, compute)).toMatchObject({
      status: "unverified",
      reason,
      computed: null,
    });
    expect(compute).not.toHaveBeenCalled();
  });

  it("stays unverified when the file hash cannot be computed", () => {
    expect(
      bindMetadataCommitment(
        trailer([entry("ipfs", HASH)]),
        computes(undefined),
      ),
    ).toMatchObject({
      status: "unverified",
      reason: "metadata_exceeds_admitted_size",
    });
  });
});
