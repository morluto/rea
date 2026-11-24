import { beforeAll, describe, expect, it } from "vitest";
import { createMessage, generateKey, readPrivateKey, sign } from "openpgp";

import { verifyDetachedPgpSignature } from "./DetachedPgpSignature.js";

const bytes = Buffer.from("binary package fixture\0\xff", "latin1");
let publicKey: string;
let fingerprint: string;
let signatures: Uint8Array[];
let signingFingerprints: string[];

beforeAll(async () => {
  const generated = await generateKey({
    type: "ecc",
    curve: "curve25519Legacy",
    userIDs: [{ name: "Fixture publisher" }],
    subkeys: [{ sign: true }, { sign: true }],
    format: "armored",
  });
  const privateKey = await readPrivateKey({ armoredKey: generated.privateKey });
  publicKey = generated.publicKey;
  fingerprint = privateKey.getFingerprint().toUpperCase();
  signingFingerprints = privateKey.subkeys.map((subkey) =>
    subkey.getFingerprint().toUpperCase(),
  );
  signatures = [];
  for (const subkey of privateKey.subkeys)
    signatures.push(
      await sign({
        message: await createMessage({ binary: bytes }),
        signingKeys: privateKey,
        signingKeyIDs: [subkey.getKeyID()],
        detached: true,
        format: "binary",
      }),
    );
});

const verify = ({
  payload = bytes,
  signature = signatures[0]!,
  key = publicKey,
  pin = fingerprint,
  signal,
}: {
  readonly payload?: Uint8Array;
  readonly signature?: Uint8Array;
  readonly key?: string;
  readonly pin?: string;
  readonly signal?: AbortSignal;
} = {}) => verifyDetachedPgpSignature(payload, signature, key, pin, signal);

describe("detached binary PGP publisher verification", () => {
  it("accepts independently selected signing subkeys through one pinned primary", async () => {
    expect(signatures).toHaveLength(2);
    for (const [index, signature] of signatures.entries())
      expect(await verify({ signature })).toEqual({
        ok: true,
        value: {
          primaryFingerprint: fingerprint,
          signingFingerprint: signingFingerprints[index],
        },
      });
  });

  it("rejects a valid signature when the authorized primary differs", async () => {
    expect(await verify({ pin: "0".repeat(40) })).toMatchObject({
      ok: false,
      error: { reason: "wrong_publisher" },
    });
  });

  it.each([
    {
      defect: "changed payload",
      payload: Buffer.from("Binary package fixture\0\xff", "latin1"),
    },
    { defect: "malformed signature", signature: Uint8Array.of(1, 2, 3) },
    { defect: "malformed public key", key: "malformed" },
  ])("refuses $defect", async (input) => {
    expect(await verify(input)).toMatchObject({
      ok: false,
      error: { reason: "invalid_signature" },
    });
  });

  it.each([null, "caller stop", { phase: "publisher-key" }])(
    "preserves the exact pre-abort reason %j",
    async (reason) => {
      const verified = await verify({ signal: AbortSignal.abort(reason) });
      expect(verified).toMatchObject({
        ok: false,
        error: { reason: "cancelled" },
      });
      expect(verified.ok ? undefined : verified.error.cause).toBe(reason);
    },
  );

  it("cancels a started verification before classifying a mismatched publisher", async () => {
    const controller = new AbortController();
    const verification = verify({
      pin: "0".repeat(40),
      signal: controller.signal,
    });
    const reason = new Error("authored publisher check cancellation");
    queueMicrotask(() => controller.abort(reason));
    const verified = await verification;
    expect(verified).toMatchObject({
      ok: false,
      error: { reason: "cancelled" },
    });
    expect(verified.ok ? undefined : verified.error.cause).toBe(reason);
  });
});
