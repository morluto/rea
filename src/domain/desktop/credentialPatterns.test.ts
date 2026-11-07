import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  credentialsIn,
  credentialsInBytes,
  redactCredentials,
  redactCredentialsInJson,
} from "./credentialPatterns.js";

// Made-up credentials in their issuers' shapes; none is a real key or token.
const FAKE_DER_BODY =
  "Zm9yLXRlc3RzLW9ubHktbm90LWEta2V5LXRoaXMtaXMtbWFkZS11cC1ieS1yZWEtdGVzdHMtMDAwMDAwMDAwMDAwMDAwMDAw";
const KEEPASSXC_INI = `[KeeShare]
Active="<?xml version=\\"1.0\\"?><KeeShare><Active/></KeeShare>\\n"
Own="<?xml version=\\"1.0\\"?><KeeShare><PrivateKey>MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQ${FAKE_DER_BODY}</PrivateKey><PublicKey><Signer>user</Signer></PublicKey></KeeShare>\\n"
QuietSuccess=true
`;
const PEM = `-----BEGIN PRIVATE KEY-----\n${FAKE_DER_BODY}\n-----END PRIVATE KEY-----`;
const JWT = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJyZWEtdGVzdCJ9.ZmFrZS1zaWduYXR1cmU";

/** Keys generated for the test run, never stored anywhere, each as base64 DER in the encodings apps keep them in. */
const generatedKeys = () => {
  const der = (
    pair: { privateKey: Buffer; publicKey: Buffer },
    name: string,
  ) => [
    { name: `${name} private`, der: pair.privateKey },
    { name: `${name} public`, der: pair.publicKey, isPublic: true },
  ];
  const ec = (namedCurve: string, type: "pkcs8" | "sec1") =>
    der(
      generateKeyPairSync("ec", {
        namedCurve,
        privateKeyEncoding: { type, format: "der" },
        publicKeyEncoding: { type: "spki", format: "der" },
      }),
      `${namedCurve} ${type}`,
    );
  const rsa = (type: "pkcs8" | "pkcs1") =>
    der(
      generateKeyPairSync("rsa", {
        modulusLength: 1024,
        privateKeyEncoding: { type, format: "der" },
        publicKeyEncoding: { type: "spki", format: "der" },
      }),
      `rsa ${type}`,
    );
  const edwards = (type: "ed25519" | "x25519" | "ed448") =>
    der(
      generateKeyPairSync(type as "ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "der" },
        publicKeyEncoding: { type: "spki", format: "der" },
      }),
      type,
    );
  const encrypted = generateKeyPairSync("ec", {
    namedCurve: "secp384r1",
    privateKeyEncoding: {
      type: "pkcs8",
      format: "der",
      cipher: "aes-256-cbc",
      passphrase: "e-made-up-passphrase",
    },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  return [
    ...["prime256v1", "secp384r1", "secp521r1", "secp256k1"].flatMap(
      (curve) => [...ec(curve, "pkcs8"), ...ec(curve, "sec1")],
    ),
    ...rsa("pkcs8"),
    ...rsa("pkcs1"),
    ...edwards("ed25519"),
    ...edwards("x25519"),
    ...edwards("ed448"),
    { name: "encrypted pkcs8", der: encrypted.privateKey },
  ];
};

/** `base64` cut into lines of 64 characters joined by `separator`. */
const lines = (base64: string, separator: string) =>
  (base64.match(/.{1,64}/gu) ?? []).join(separator);

/** UTF-16 big-endian bytes of `text`. */
const utf16be = (text: string) => Buffer.from(text, "utf16le").swap16();

it("scans a large base64 payload without exhausting the stack", () => {
  expect(credentialsIn(`image=${"A".repeat(16_777_216)}`)).toEqual([]);
  expect(
    credentialsIn(`image=${randomBytes(12_582_912).toString("base64")}`),
  ).toEqual([]);
});

it("redacts an unpadded DER key without removing a following setting", () => {
  const { privateKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  const key = privateKey.toString("base64").replace(/=+$/u, "");
  expect(redactCredentials(`key=${key}\nnext=1\n`)).toBe(
    "key=<credential:private-key>\nnext=1\n",
  );
});

it("redacts multiple adjacent unpadded keys without removing their separator", () => {
  const key = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "der" },
    publicKeyEncoding: { type: "spki", format: "der" },
  })
    .privateKey.toString("base64")
    .replace(/=+$/u, "");
  expect(redactCredentials(`${key}\n${key}\n`)).toBe(
    "<credential:private-key>\n<credential:private-key>\n",
  );
});

it("preserves surrounding settings for padded and wrapped private keys", () => {
  for (const { name, der, isPublic } of generatedKeys()) {
    if (isPublic === true) continue;
    const key = der.toString("base64");
    for (const encoded of [
      key,
      key.replace(/=+$/u, ""),
      lines(key, "\n"),
      lines(key, "\\n"),
    ])
      expect(
        redactCredentials(`before=1\nkey=${encoded}\nnext=1\n`),
        `${name} length=${encoded.length} breaks=${encoded.includes("\n")} escapes=${encoded.includes("\\n")}`,
      ).toBe("before=1\nkey=<credential:private-key>\nnext=1\n");
  }
});

describe("credential patterns", () => {
  it("finds the private key KeePassXC generates into its settings, and replaces it with its kind", () => {
    expect(credentialsIn(KEEPASSXC_INI)).toEqual(["private-key"]);
    const redacted = redactCredentials(KEEPASSXC_INI);
    expect(redacted).toContain(
      "<PrivateKey><credential:private-key></PrivateKey>",
    );
    expect(redacted).not.toContain(FAKE_DER_BODY);
    expect(redacted).toContain("QuietSuccess=true");
  });

  it("finds keys and tokens by the shapes their issuers give them", () => {
    expect(credentialsIn(`key = ${PEM}`)).toEqual(["private-key"]);
    expect(credentialsIn(`token=${JWT}`)).toEqual(["jwt"]);
    expect(
      credentialsIn("remote https://ada:e-hunter2-fake@git.example.org/r"),
    ).toEqual(["url-credentials"]);
    expect(credentialsIn(`gh=ghp_${"a1".repeat(18)}`)).toEqual([
      "github-token",
    ]);
    expect(credentialsIn("AKIAFAKE0KEY0FOR0REA x")).toEqual(["aws-access-key"]);
    expect(credentialsIn(`hf_${"Z".repeat(32)}`)).toEqual([
      "hugging-face-token",
    ]);
    expect(credentialsIn(`sk-test-${"9".repeat(24)}`)).toEqual(["api-key"]);
  });

  it("finds nothing in ordinary settings, digests, ids or images", () => {
    for (const text of [
      "[ui]\nwrap=true\nrecent=/home/user/Documents/plan.kdbx\n",
      "f3ef6b1d3b016f443bd7a45c7237bb4e12e94e3065fb745cf7135956722174a3",
      "c108cb67-4570-48bb-a32b-96af1a16ce76",
      "https://downloads.example.org/linux/app_1.0_arm64.deb",
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    ])
      expect(credentialsIn(text), text).toEqual([]);
  });

  it("reads a file's bytes, inside a gzip file too", () => {
    expect(credentialsInBytes(Buffer.from(KEEPASSXC_INI))).toEqual([
      "private-key",
    ]);
    expect(credentialsInBytes(gzipSync(Buffer.from(`t=${JWT}`)))).toEqual([
      "jwt",
    ]);
    expect(credentialsInBytes(Buffer.from([0, 255, 1, 2]))).toEqual([]);
  });

  it("replaces credentials in every string of a JSON value, names included", () => {
    expect(redactCredentialsInJson({ [JWT]: [`a ${PEM} b`, 1, null] })).toEqual(
      { "<credential:jwt>": ["a <credential:private-key> b", 1, null] },
    );
  });

  it("finds private keys of every common kind by their DER structure, whatever the curve or line breaks, and never a public key", () => {
    for (const { name, der, isPublic } of generatedKeys()) {
      const base64 = der.toString("base64");
      const middle = base64.slice(8, 40);
      for (const text of [
        `key=${base64}\n`,
        `<PrivateKey>${base64}</PrivateKey>`,
        `key=${lines(base64, "\n")}\nnext=1\n`,
        `{"key":"${lines(base64, "\\n")}"}`,
        `key=${lines(base64, "\r\n")}\r\n`,
      ]) {
        if (isPublic === true) {
          expect(credentialsIn(text), `${name} ${text}`).toEqual([]);
          expect(redactCredentials(text), name).toBe(text);
          continue;
        }
        expect(credentialsIn(text), `${name} ${text}`).toEqual(["private-key"]);
        expect(credentialsInBytes(Buffer.from(text)), name).toEqual([
          "private-key",
        ]);
        expect(redactCredentials(text), name).toContain(
          "<credential:private-key>",
        );
        expect(
          redactCredentials(text).replace(/\\n|\s/gu, ""),
          name,
        ).not.toContain(middle);
      }
    }
  });

  it("finds a private key kept as raw DER bytes, and nothing in other binary data", () => {
    for (const { name, der, isPublic } of generatedKeys()) {
      const file = Buffer.concat([Buffer.from("KEYS\0\x01"), der]);
      expect(credentialsInBytes(file), name).toEqual(
        isPublic === true ? [] : ["private-key"],
      );
    }
    let block = createHash("sha256").update("e-seed").digest();
    const noise: Buffer[] = [];
    for (let index = 0; index < 4096; index += 1) {
      block = createHash("sha256").update(block).digest();
      noise.push(
        index % 7 === 0 ? Buffer.from([0x30, 0x82, 0x01, 0x22]) : block,
      );
    }
    expect(credentialsInBytes(Buffer.concat(noise))).toEqual([]);
  });

  it("reads UTF-16 files of either byte order, with or without a byte order mark, inside gzip too", () => {
    const [key] = generatedKeys().filter(({ isPublic }) => isPublic !== true);
    const text = `token=${JWT}\nkey=${PEM}\nder=${key?.der.toString("base64") ?? ""}\n`;
    const expected = ["private-key", "jwt"];
    for (const bytes of [
      Buffer.from(text, "utf16le"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]),
      utf16be(text),
      Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(text)]),
    ]) {
      expect(credentialsInBytes(bytes)).toEqual(expected);
      expect(credentialsInBytes(gzipSync(bytes))).toEqual(expected);
    }
    expect(
      credentialsInBytes(Buffer.from("[ui]\nwrap=true\n", "utf16le")),
    ).toEqual([]);
  });
});
