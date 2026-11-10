import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { UNSIGNED_ATTRIBUTES_LIMITATION } from "../../src/native/pe/PeCertificateParser.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  peCertificateFixture,
  peWithoutCertificateTableFixture,
  pkcs7SignedDataFixture,
  pkcs7SignedDataIndefiniteEnvelopeFixture,
} from "../../src/native/pe/PeCertificates.fixture.js";
import { repeatedCertificateSignedData } from "../fixtures/peCertificateAllowance.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest, runFileCli } from "../support/cli/cliFixture.js";

cliTest.for(["extra-field", "empty-rdn"] as const)(
  "rejects a malformed certificate name %s through CLI and MCP",
  async (kind, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-name-structure-");
    const path = join(root, "malformed.exe");
    const subject =
      kind === "empty-rdn"
        ? Buffer.from([0x30, 0x02, 0x31, 0])
        : Buffer.from([
            0x30, 14, 0x31, 12, 0x30, 10, 0x06, 3, 0x55, 0x04, 3, 0x0c, 1, 0x41,
            0x05, 0,
          ]);
    const payload = pkcs7SignedDataFixture(
      undefined,
      undefined,
      undefined,
      undefined,
      { subject },
    );
    const bytes = peCertificateFixture(false, payload);
    await writeFile(path, bytes);
    const result = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect.soft(result.exitCode, result.stdout).toBe(1);
    expect.soft(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "inspect_pe_certificates",
        issues: [
          expect.objectContaining({ path: ["path"], reason: "invalid_format" }),
        ],
      },
    });
    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_pe_certificates", { path });
    expect.soft(response.isError, JSON.stringify(response)).toBe(true);
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest.for(["pubkey", "signature"])(
  "rejects nonzero BIT STRING padding in %s through the public CLI",
  async (field, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-bit-padding-");
    const path = join(root, "padding.exe");
    const payload = pkcs7SignedDataFixture();
    const marker = Buffer.concat([
      Buffer.from([0x03, field.length + 1, 0]),
      Buffer.from(field),
    ]);
    const at = payload.indexOf(marker);
    expect(at).toBeGreaterThanOrEqual(0);
    payload[at + 2] = 1;
    await writeFile(path, peCertificateFixture(false, payload));
    const invalid = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "inspect_pe_certificates",
        issues: [
          expect.objectContaining({
            path: ["path"],
            reason: "invalid_format",
            message: expect.stringContaining("padding"),
          }),
        ],
      },
    });
    // Only zero the advertised unused bit; all ASN.1 lengths stay unchanged.
    const last = at + marker.length - 1;
    payload[last] = payload[last]! & 0xfe;
    await writeFile(path, peCertificateFixture(false, payload));
    const valid = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(valid.exitCode, valid.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      valid.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.serial_hex,
    ).toBe("11223344");
  },
);

cliTest(
  "reports PKCS#7 signer identity through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-");
    const path = join(root, "signed.exe");
    await writeFile(path, peCertificateFixture());
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.serial_hex,
    ).toBe("11223344");
  },
);

cliTest("reports unsigned attributes through CLI and MCP", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-pe-cert-unsigned-attrs-");
  const path = join(root, "timestamped.exe");
  const payload = pkcs7SignedDataFixture(undefined, undefined, undefined, [
    [1, 3, 6, 1, 4, 1, 311, 3, 3, 1],
  ]);
  await writeFile(path, peCertificateFixture(true, payload));
  const result = await runFileCli(cli, {
    arguments: ["inspect-pe-certificates", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const call = await cli.sharedMcpCall!();
  const response = await call("inspect_pe_certificates", { path });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  for (const value of [result.json, response.structuredContent]) {
    const report = toolContract("inspect_pe_certificates").outputSchema.parse(
      value,
    ).normalized_result;
    expect(report.coverage.status).toBe("partial");
    expect(
      report.entries[0]?.pkcs7?.signers[0]?.unsigned_attribute_oids,
    ).toEqual(["1.3.6.1.4.1.311.3.3.1"]);
    expect(report.limitations).toContain(UNSIGNED_ATTRIBUTES_LIMITATION);
  }
});

cliTest(
  "inspects SignedData with an indefinite constructed ContentInfo envelope",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-ber-cli-");
    const path = join(root, "ber-signed.exe");
    const payload = pkcs7SignedDataIndefiniteEnvelopeFixture();
    await writeFile(path, peCertificateFixture(false, payload));

    const result = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    const entry = evidence.normalized_result.entries[0];
    expect(entry?.pkcs7?.certificates[0]).toMatchObject({
      serial_hex: "11223344",
    });
    expect(entry?.payload.bytes).toBe(payload.length);
    expect(entry?.pkcs7?.certificates[0]?.location.bytes).toBeGreaterThan(0);
  },
);

cliTest(
  "resolves a relative PE path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-rel-");
    const path = join(root, "unsigned.exe");
    const bytes = peWithoutCertificateTableFixture();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", "unsigned.exe", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    expect(evidence).toMatchObject({
      confidence: "observed",
      subject: { local_path: path, format: "pe", architecture: "x86" },
      normalized_result: {
        artifact: {
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
        format: "pe32",
        machine: 0x14c,
        table: null,
        entries: [],
        coverage: { status: "complete", examined_entries: 0, certificates: 0 },
        limitations: expect.arrayContaining([
          expect.stringContaining("IMAGE_DIRECTORY_ENTRY_SECURITY is absent"),
        ]),
      },
    });
  },
);

cliTest("reports a truncated PE as invalid input", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-pe-cert-cli-bad-");
  const path = join(root, "broken.exe");
  await writeFile(path, Buffer.from("MZ"));
  const result = await runFileCli(cli, {
    arguments: ["inspect-pe-certificates", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    details: { operation: "inspect_pe_certificates" },
  });
});

cliTest(
  "reports TeletexString compatibility text with its decoding limitation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-teletex-");
    const path = join(root, "teletex.exe");
    const payload = pkcs7SignedDataFixture("é");
    const nameAt = payload.indexOf(Buffer.from([0x0c, 0x02, 0xc3, 0xa9]));
    expect(nameAt).toBeGreaterThanOrEqual(0);
    // Replace an equal-length UTF8String with T.61's acute accent plus 'e'.
    Buffer.from([0x14, 0x02, 0xc2, 0x65]).copy(payload, nameAt);
    await writeFile(path, peCertificateFixture(false, payload));
    const result = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.issuer
        .text,
    ).toBe("commonName=Âe, organizationName=REA Tests");
    expect(evidence.normalized_result.limitations).toContainEqual(
      expect.stringMatching(/TeletexString.*ISO.8859.1.*not a full T.61/iu),
    );
  },
);

cliTest(
  "rejects a non-minimal PKCS#7 content OID through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-oid-");
    const path = join(root, "nonminimal.exe");
    const payload = pkcs7SignedDataIndefiniteEnvelopeFixture();
    expect([...payload.subarray(0, 5)]).toEqual([0x30, 0x80, 0x06, 0x09, 0x2a]);
    const malformed = Buffer.concat([
      payload.subarray(0, 3),
      Buffer.from([0x0a, 0x80]),
      payload.subarray(4),
    ]);
    await writeFile(path, peCertificateFixture(false, malformed));
    const result = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_pe_certificates" },
    });
  },
);

cliTest(
  "rejects surrogate pairs in BMPString certificate names and accepts valid neighboring code units",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-bmp-");
    const path = join(root, "bmp.exe");
    const payload = pkcs7SignedDataFixture("ABCD");
    const nameAt = payload.indexOf(
      Buffer.from([0x0c, 0x04, 0x41, 0x42, 0x43, 0x44]),
    );
    expect(nameAt).toBeGreaterThanOrEqual(0);
    // Equal-size replacement keeps the DER lengths and all unrelated fields intact.
    Buffer.from([0x1e, 0x04, 0xd8, 0, 0xdc, 0]).copy(payload, nameAt);
    await writeFile(path, peCertificateFixture(false, payload));
    const invalid = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_pe_certificates" },
    });
    Buffer.from([0x1e, 0x04, 0xd7, 0xff, 0xe0, 0]).copy(payload, nameAt);
    await writeFile(path, peCertificateFixture(false, payload));
    const valid = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(valid.exitCode, valid.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      valid.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.issuer
        .text,
    ).toBe("commonName=\ud7ff\ue000, organizationName=REA Tests");
  },
);

cliTest(
  "rejects a certificate validity date that is not a calendar day through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-validity-");
    const path = join(root, "validity.exe");
    const payload = pkcs7SignedDataFixture();
    const timeAt = payload.indexOf(Buffer.from("250101000000Z"));
    expect(timeAt).toBeGreaterThanOrEqual(0);
    // 2025 has no 29 February; the equal-length edit keeps every DER length.
    payload.write("250229000000Z", timeAt, "ascii");
    await writeFile(path, peCertificateFixture(false, payload));
    const invalid = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_pe_certificates" },
    });
    payload.write("240229000000Z", timeAt, "ascii");
    await writeFile(path, peCertificateFixture(false, payload));
    const valid = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(valid.exitCode, valid.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      valid.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.not_before,
    ).toBe("240229000000Z");
  },
);

cliTest(
  "inventories repeated certificates within both decoder allowances",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-repeated-");
    const path = join(root, "chain.exe");
    await writeFile(
      path,
      peCertificateFixture(false, repeatedCertificateSignedData(200)),
    );

    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });

    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      result.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates,
    ).toHaveLength(200);
  },
);

cliTest.for([
  // Each repeated certificate decodes to 43 ASN.1 values and about 200 bytes
  // of text, so 350 stay within the value allowance and exceed the text one.
  {
    allowance: "decoded certificate text",
    certificates: 350,
    limits: { max_decoded_text_bytes: 65_536 },
    message: "65536-byte decoded budget",
  },
  {
    allowance: "ASN.1 value count",
    certificates: 600,
    limits: { max_asn1_values: 16_384 },
    message: "16384-node budget",
  },
])(
  "reports the fixed $allowance allowance as a resource constraint",
  async ({ certificates, limits, message }, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-allowance-");
    const path = join(root, "large.exe");
    await writeFile(
      path,
      peCertificateFixture(false, repeatedCertificateSignedData(certificates)),
    );

    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      details: {
        operation: "inspect_pe_certificates",
        reported_limits: limits,
      },
    });
    const { message: reason, remediation } = result.json as {
      message: string;
      remediation: { action: string };
    };
    expect(reason).toContain(message);
    expect(remediation.action).toContain(String(Object.values(limits)[0]));
    expect(remediation.action).toContain("no runtime override");
    expect(remediation.action).toMatch(/unchanged request.*fails/iu);
  },
);

cliTest.for([
  [0x13, "REA@Fixture"],
  [0x16, "REAéFixture"],
] as const)(
  "rejects an invalid certificate name alphabet for tag %i through the public CLI",
  async ([tag, name], { cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-name-alphabet-");
    const path = join(root, "name.exe");
    const payload = pkcs7SignedDataFixture(name);
    const content = Buffer.from(name, "utf8");
    const marker = Buffer.concat([
      Buffer.from([0x0c, content.length]),
      content,
    ]);
    const at = payload.indexOf(marker);
    expect(at).toBeGreaterThanOrEqual(0);
    payload[at] = tag;
    await writeFile(path, peCertificateFixture(false, payload));
    const invalid = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "inspect_pe_certificates" },
    });
    // Only restore the string tag: the same bytes are valid UTF8String content.
    payload[at] = 0x0c;
    await writeFile(path, peCertificateFixture(false, payload));
    const valid = await runFileCli(cli, {
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(valid.exitCode, valid.stderr).toBe(0);
    const evidence = toolContract("inspect_pe_certificates").outputSchema.parse(
      valid.json,
    );
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.issuer
        .attributes[0]?.value,
    ).toBe(name);
  },
);
