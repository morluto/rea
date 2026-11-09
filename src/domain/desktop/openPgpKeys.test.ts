import { readKey } from "openpgp";
import { describe, expect, it } from "vitest";

import { BOTH_ARMORED, VENDOR_A, VENDOR_B } from "./aptKeys.fixture.js";
import { transferablePublicKeys, verifyingKey } from "./openPgpKeys.js";

const BOTH = Buffer.concat([VENDOR_A.key, VENDOR_B.key]);

/** The same keys as OpenPGP.js writes them, with new-format packet headers. */
const rewritten = async (key: Buffer) =>
  Buffer.from((await readKey({ binaryKey: key })).write());

describe("transferablePublicKeys", () => {
  it("splits GnuPG's old-format keyring at each primary key and fingerprints it", () => {
    expect(VENDOR_A.key[0]).toBe(0x98);

    const keys = transferablePublicKeys(BOTH);

    expect(
      keys?.map(({ bytes, fingerprint }) => ({
        bytes: bytes.toString("hex"),
        fingerprint,
      })),
    ).toEqual([
      {
        bytes: VENDOR_A.key.toString("hex"),
        fingerprint: VENDOR_A.fingerprint,
      },
      {
        bytes: VENDOR_B.key.toString("hex"),
        fingerprint: VENDOR_B.fingerprint,
      },
    ]);
  });

  it("reads new-format headers with one-, two- and five-octet lengths", async () => {
    const newFormat = Buffer.concat([
      await rewritten(VENDOR_A.key),
      await rewritten(VENDOR_B.key),
    ]);
    expect(newFormat[0]).toBe(0xc6);
    const body = VENDOR_A.key.subarray(2, 2 + (VENDOR_A.key[1] ?? 0));
    const fiveOctet = Buffer.alloc(6);
    fiveOctet[0] = 0xc6;
    fiveOctet[1] = 0xff;
    fiveOctet.writeUInt32BE(body.length, 2);
    const userId = Buffer.alloc(300, 0x61);
    const twoOctet = Buffer.from([
      0xcd,
      ((300 - 192) >> 8) + 192,
      (300 - 192) & 0xff,
    ]);

    expect(
      transferablePublicKeys(newFormat)?.map((key) => key.fingerprint),
    ).toEqual([VENDOR_A.fingerprint, VENDOR_B.fingerprint]);
    expect(
      transferablePublicKeys(
        Buffer.concat([fiveOctet, body, twoOctet, userId]),
      ),
    ).toEqual([
      {
        bytes: Buffer.concat([fiveOctet, body, twoOctet, userId]),
        fingerprint: VENDOR_A.fingerprint,
      },
    ]);
  });

  it("refuses truncated packets, partial or indeterminate lengths and a keyring not starting with a key", () => {
    expect(transferablePublicKeys(BOTH.subarray(0, BOTH.length - 1))).toBe(
      undefined,
    );
    expect(transferablePublicKeys(Buffer.from([0xc6, 0xe1, 0x00]))).toBe(
      undefined,
    );
    expect(transferablePublicKeys(Buffer.from([0x9b, 0x04, 0x00]))).toBe(
      undefined,
    );
    expect(transferablePublicKeys(VENDOR_A.key.subarray(53))).toBe(undefined);
    expect(transferablePublicKeys(Buffer.from("KBXf"))).toBe(undefined);
  });
});

describe("verifyingKey", () => {
  const armor = (bytes: Buffer) =>
    Buffer.from(
      `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${bytes.toString("base64")}\n=AAAA\n-----END PGP PUBLIC KEY BLOCK-----\n`,
    );

  it("keeps a file holding one key as it is", () => {
    expect(verifyingKey(VENDOR_A.key, VENDOR_A.fingerprint)).toEqual({
      ok: true,
      value: { bytes: VENDOR_A.key, format: "binary" },
    });
    const armored = armor(VENDOR_A.key);
    expect(verifyingKey(armored, VENDOR_A.fingerprint)).toEqual({
      ok: true,
      value: { bytes: armored, format: "armored" },
    });
  });

  it("keeps only the verifying key of a binary or armored keyring", async () => {
    const fromBinary = verifyingKey(BOTH, VENDOR_B.fingerprint);
    const fromArmor = verifyingKey(
      Buffer.from(BOTH_ARMORED),
      VENDOR_A.fingerprint,
    );

    if (!fromBinary.ok || !fromArmor.ok) throw new Error("no key kept");
    expect(fromBinary.value.format).toBe("binary");
    expect(fromBinary.value.bytes.equals(VENDOR_B.key)).toBe(true);
    expect(fromArmor.value.bytes.equals(VENDOR_A.key)).toBe(true);
    const parsed = await readKey({ binaryKey: fromArmor.value.bytes });
    expect(parsed.getFingerprint().toUpperCase()).toBe(VENDOR_A.fingerprint);
  });

  it("refuses a keyring without the verifying key and a file it cannot split", () => {
    expect(verifyingKey(BOTH, "0".repeat(40))).toEqual({
      ok: false,
      error: `the key file holds 2 keys and REA found none with the verifying fingerprint ${"0".repeat(40)}`,
    });
    expect(verifyingKey(Buffer.from("KBXf"), VENDOR_A.fingerprint)).toEqual({
      ok: false,
      error: "REA could not split the key file into OpenPGP keys",
    });
  });
});
