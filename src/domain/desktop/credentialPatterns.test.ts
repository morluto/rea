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
});
