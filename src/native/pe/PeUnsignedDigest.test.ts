import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import {
  peCertificateFixture,
  peWithoutCertificateTableFixture,
  pkcs7SignedDataFixture,
} from "./PeCertificates.fixture.js";
import { parsePeCertificates } from "./PeCertificateParser.js";
import { MAX_DECODED_NAME_BYTES } from "./PeCertificateAsn1.js";
import {
  explainPeSignedAfterPacking,
  rebuildPeBytesWithoutCertificateTable,
} from "./PeUnsignedDigest.js";

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

const securityDirectoryAt = (plus: boolean): number =>
  0x98 + (plus ? 112 : 96) + 4 * 8;

const unsignedFixture = (plus: boolean): Buffer => {
  const bytes = peWithoutCertificateTableFixture(plus);
  bytes.writeUInt32LE(16, 0x98 + (plus ? 108 : 92));
  return bytes;
};

it.each([false, true])(
  "restores the pre-signing PE%s digest when only Authenticode overlay differs",
  (plus) => {
    const signed = peCertificateFixture(plus, pkcs7SignedDataFixture());
    signed.writeUInt32LE(0x89abcdef, 0x98 + 64);
    const unsigned = unsignedFixture(plus);
    expect(rebuildPeBytesWithoutCertificateTable(signed)?.bytes).toEqual(
      unsigned,
    );
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
      signer_subjects_complete: true,
    });
  },
);

it.each([
  [
    "different issuer",
    "Other Issuer",
    [expect.stringContaining("commonName=REA Fixture")],
    true,
  ],
  ["ambiguous duplicate", "REA Fixture", [], false],
] as const)(
  "does not select a wrong signer for a shared serial: %s",
  (_case, extra, expected, complete) => {
    const signed = peCertificateFixture(
      false,
      pkcs7SignedDataFixture(
        "REA Fixture",
        "REA Tests",
        undefined,
        undefined,
        {},
        extra,
      ),
    );
    expect(
      explainPeSignedAfterPacking(signed, digest(unsignedFixture(false))),
    ).toMatchObject({
      signer_subjects: expected,
      signer_subjects_complete: complete,
    });
  },
);

it("keeps the digest explanation when signer decoding exceeds its allowance", () => {
  const signed = peCertificateFixture(
    false,
    pkcs7SignedDataFixture("A".repeat(40_000)),
  );
  expect(() =>
    parsePeCertificates(
      signed,
      { path: "/fixture", sha256: digest(signed), bytes: signed.length },
      { path: "/fixture", max_file_bytes: signed.length, max_entries: 64 },
    ),
  ).toThrow(
    expect.objectContaining({
      exhausted: { allowance: "decoded-text", limit: MAX_DECODED_NAME_BYTES },
    }),
  );
  expect(
    explainPeSignedAfterPacking(signed, digest(unsignedFixture(false))),
  ).toMatchObject({
    kind: "signed-after-packing",
    signer_subjects_complete: false,
  });
});

it("keeps a real content mismatch unexplained", () => {
  const signed = peCertificateFixture();
  signed.writeUInt32LE(0x11111111, 0x98 + 64);
  const unsigned = unsignedFixture(false);
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
