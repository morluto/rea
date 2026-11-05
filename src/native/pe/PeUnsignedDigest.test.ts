import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import {
  peCertificateFixture,
  peWithoutCertificateTableFixture,
  pkcs7SignedDataFixture,
} from "./PeCertificates.fixture.js";
import {
  explainPeSignedAfterPacking,
  rebuildPeBytesWithoutCertificateTable,
} from "./PeUnsignedDigest.js";

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const securityDirectoryAt = (plus: boolean): number =>
  0x98 + (plus ? 112 : 96) + 4 * 8;

const unsignedFromSigned = (signed: Buffer, plus: boolean): Buffer => {
  const rebuilt = rebuildPeBytesWithoutCertificateTable(signed);
  if (rebuilt === null) throw new Error("expected a rebuild");
  expect(rebuilt.bytes.length).toBe(0x200);
  expect(signed.readUInt32LE(securityDirectoryAt(plus))).toBe(0x200);
  return rebuilt.bytes;
};

it.each([false, true])(
  "restores the pre-signing PE%s digest when only Authenticode overlay differs",
  (plus) => {
    const signed = peCertificateFixture(plus, pkcs7SignedDataFixture());
    signed.writeUInt32LE(0x89abcdef, 0x98 + 64);
    const unsigned = unsignedFromSigned(signed, plus);
    expect(unsigned.readUInt32LE(0x98 + 64)).toBe(0);
    expect(unsigned.readUInt32LE(securityDirectoryAt(plus))).toBe(0);
    expect(unsigned.readUInt32LE(securityDirectoryAt(plus) + 4)).toBe(0);
    const explained = explainPeSignedAfterPacking(signed, digest(unsigned));
    expect(explained).toMatchObject({
      kind: "signed-after-packing",
      platform: "pe-authenticode",
      unsigned_sha256: digest(unsigned),
      certificate_table_bytes: signed.length - unsigned.length,
      signer_subjects: [expect.stringContaining("commonName=REA Fixture")],
    });
  },
);

it("keeps a real content mismatch unexplained", () => {
  const signed = peCertificateFixture();
  signed.writeUInt32LE(0x11111111, 0x98 + 64);
  const unsigned = unsignedFromSigned(signed, false);
  unsigned[0x100] = (unsigned[0x100] ?? 0) ^ 0xff;
  expect(explainPeSignedAfterPacking(signed, digest(unsigned))).toBeNull();
});

it("does not explain an image without a security directory", () => {
  const bytes = peWithoutCertificateTableFixture();
  expect(explainPeSignedAfterPacking(bytes, digest(bytes))).toBeNull();
});

it("does not explain when the certificate table is not the sole appended delta", () => {
  const signed = peCertificateFixture();
  signed.writeUInt32LE(0x22222222, 0x98 + 64);
  const withTrailer = Buffer.concat([signed, Buffer.from("trailer")]);
  const unsigned = Buffer.alloc(0x200);
  signed.copy(unsigned, 0, 0, 0x200);
  unsigned.writeUInt32LE(0, 0x98 + 64);
  unsigned.writeUInt32LE(0, securityDirectoryAt(false));
  unsigned.writeUInt32LE(0, securityDirectoryAt(false) + 4);
  expect(explainPeSignedAfterPacking(withTrailer, digest(unsigned))).toBeNull();
});
