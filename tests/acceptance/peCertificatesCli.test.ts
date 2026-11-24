import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { BINARY_DIAGNOSTICS_TOOL_CONTRACTS } from "../../src/contracts/native/binaryDiagnosticsToolContracts.js";
import {
  peCertificateFixture,
  peWithoutCertificateTableFixture,
  pkcs7SignedDataFixture,
  pkcs7SignedDataIndefiniteEnvelopeFixture,
} from "../../src/native/pe/PeCertificates.fixture.js";
import { repeatedCertificateSignedData } from "../fixtures/peCertificateAllowance.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const contract = BINARY_DIAGNOSTICS_TOOL_CONTRACTS.find(
  (item) => item.name === "inspect_pe_certificates",
);
if (contract === undefined)
  throw new Error("Missing inspect_pe_certificates contract");

cliTest(
  "checks the next PE certificate frame before reporting the entry limit through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-limit-framing-");
    const path = join(root, "table.exe");
    const single = peCertificateFixture(false, Buffer.from([0x61]), 0x0001);
    const table = single.subarray(0x200);
    const tableSizeAt = 0x98 + 96 + 4 * 8 + 4;
    const valid = Buffer.concat([single, table]);
    valid.writeUInt32LE(table.length * 2, tableSizeAt);
    const badLength = Buffer.from(valid);
    badLength.writeUInt32LE(table.length + 1, single.length);
    const badAlignment = Buffer.from(valid.subarray(0, valid.length - 1));
    badAlignment.writeUInt32LE(table.length * 2 - 1, tableSizeAt);
    const call = await cli.sharedMcpCall!();
    for (const { bytes, message, kind } of [
      { bytes: valid },
      { bytes: badLength, message: "dwLength exceeds", kind: "malformed" },
      {
        bytes: badAlignment,
        message: "alignment padding is truncated",
        kind: "truncated",
      },
    ]) {
      const expectedError =
        message === undefined
          ? {
              code: "resource_constraint",
              details: {
                resource: "capacity",
                reported_limits: { max_entries: 1 },
              },
            }
          : {
              code: "unsupported_target",
              details: {
                failure_kind: kind,
                format: "pe-certificate-table",
                reason: expect.stringContaining(message),
              },
            };
      await writeFile(path, bytes);
      const inspected = await cli.run({
        arguments: [
          "inspect-pe-certificates",
          path,
          "--max-entries",
          "1",
          "--json",
        ],
      });
      expect(inspected.exitCode, inspected.stdout).toBe(1);
      expect.soft(inspected.json).toMatchObject(expectedError);
      const rejected = await call("inspect_pe_certificates", {
        path,
        max_entries: 1,
      });
      expect(rejected.isError, JSON.stringify(rejected)).toBe(true);
      expect
        .soft(parseMcpToolError(rejected).error)
        .toMatchObject(expectedError);
    }
  },
);

cliTest.for([false, true])(
  "rejects incomplete certificate alignment and recovers through CLI/MCP (PE32+ = %s)",
  async (plus, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-alignment-cli-");
    const path = join(root, "signed.exe");
    const valid = peCertificateFixture(plus);
    const directoryAt = 0x98 + (plus ? 112 : 96) + 4 * 8;
    const tableSize = valid.readUInt32LE(directoryAt + 4);
    const length = valid.readUInt32LE(0x200);
    expect(length).toBeLessThan(tableSize);
    const truncated = Buffer.from(valid.subarray(0, valid.length - 1));
    truncated.writeUInt32LE(tableSize - 1, directoryAt + 4);
    await writeFile(path, truncated);
    const invalid = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    const error = {
      code: "unsupported_target",
      details: {
        operation: "inspect_pe_certificates",
        failure_kind: "truncated",
        format: "pe-certificate-table",
      },
    };
    expect.soft(invalid.exitCode, invalid.stdout).toBe(1);
    expect.soft(invalid.json).toMatchObject(error);
    const call = await cli.sharedMcpCall!();
    const rejected = await call("inspect_pe_certificates", { path });
    expect.soft(rejected.isError, JSON.stringify(rejected)).toBe(true);
    if (rejected.isError)
      expect(parseMcpToolError(rejected).error).toMatchObject(error);
    expect((await readFile(path)).equals(truncated)).toBe(true);
    // The same session and selected path must recover after the source is
    // repaired, preserving the complete source identity and payload facts.
    await writeFile(path, valid);
    const recovered = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(recovered.exitCode, recovered.stderr).toBe(0);
    const response = await call("inspect_pe_certificates", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    for (const value of [recovered.json, response.structuredContent]) {
      const report = contract.outputSchema.parse(value).normalized_result;
      expect(report.coverage.status).toBe("complete");
      expect(report.artifact.sha256).toBe(
        createHash("sha256").update(valid).digest("hex"),
      );
      expect(report.entries[0]?.length).toBe(length);
    }
  },
);

cliTest.for([0x00, 0xff, null])(
  "requires canonical extension critical encoding %s through CLI and MCP",
  async (critical, { cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-critical-");
    const path = join(root, "signed.exe");
    // Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE, extnValue }.
    // The extension OID and opaque value stay identical in every control.
    const fields = Buffer.concat([
      Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0e]),
      critical === null ? Buffer.alloc(0) : Buffer.from([0x01, 0x01, critical]),
      Buffer.from([0x04, 0x03, 0x04, 0x01, 0xaa]),
    ]);
    const extension = Buffer.concat([
      Buffer.from([0x30, fields.length]),
      fields,
    ]);
    const extensions = Buffer.concat([
      Buffer.from([0x30, extension.length]),
      extension,
    ]);
    const bytes = peCertificateFixture(
      false,
      pkcs7SignedDataFixture(undefined, undefined, undefined, undefined, {
        extensions,
      }),
    );
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_pe_certificates", { path });
    const valid = critical === null || critical === 0xff;
    expect(result.exitCode, result.stdout).toBe(valid ? 0 : 1);
    if (valid)
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
    else expect(response.isError, JSON.stringify(response)).toBe(true);
    for (const value of [
      result.json,
      valid ? response.structuredContent : parseMcpToolError(response).error,
    ]) {
      if (valid) {
        const report = contract.outputSchema.parse(value).normalized_result;
        expect(report.coverage.status).toBe("complete");
        expect(report.entries[0]?.pkcs7?.certificates[0]?.serial_hex).toBe(
          "11223344",
        );
      } else {
        expect(value).toMatchObject({
          code: "unsupported_target",
          details: {
            operation: "inspect_pe_certificates",
            failure_kind: "malformed",
            format: "pe-certificate-table",
            reason: expect.stringContaining("critical"),
          },
        });
      }
    }
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "refuses an empty certificate RDN through both adapters",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-name-structure-");
    const path = join(root, "malformed.exe");
    const payload = pkcs7SignedDataFixture(
      undefined,
      undefined,
      undefined,
      undefined,
      {
        subject: Buffer.from([0x30, 0x02, 0x31, 0]),
      },
    );
    const bytes = peCertificateFixture(false, payload);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_pe_certificates",
        failure_kind: "malformed",
        format: "pe-certificate-table",
        reason: expect.stringContaining("Name RDN"),
      },
    });
    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_pe_certificates", { path });
    expect(parseMcpToolError(response).error).toEqual(result.json);
    expect(response.structuredContent).toBeUndefined();
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "rejects nonzero certificate signature padding through the public CLI",
  async ({ cli }) => {
    const field = "signature";
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
    const invalid = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.json).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_pe_certificates",
        failure_kind: "malformed",
        format: "pe-certificate-table",
        reason: expect.stringContaining("padding"),
      },
    });
    // Only zero the advertised unused bit; all ASN.1 lengths stay unchanged.
    const last = at + marker.length - 1;
    payload[last] = payload[last]! & 0xfe;
    await writeFile(path, peCertificateFixture(false, payload));
    const valid = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(valid.exitCode, valid.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(valid.json);
    expect(
      evidence.normalized_result.entries[0]?.pkcs7?.certificates[0]?.serial_hex,
    ).toBe("11223344");
  },
);

cliTest(
  "reports PKCS#7 signer identity and BER lengths through both adapters",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-cert-cli-");
    const path = join(root, "signed.exe");
    const payload = pkcs7SignedDataIndefiniteEnvelopeFixture();
    const bytes = peCertificateFixture(false, payload);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_pe_certificates", { path });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const evidence = contract.outputSchema.parse(result.json);
    const mcp = contract.outputSchema.parse(response.structuredContent);
    const report = evidence.normalized_result;
    expect(evidence.caller_input_path).toBe(path);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(report);
    expect(report.artifact).toEqual({
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const entry = report.entries[0];
    expect(entry?.payload).toMatchObject({
      bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
    const pkcs7 = entry?.pkcs7;
    expect(pkcs7?.certificates[0]?.serial_hex).toBe("11223344");
    expect(pkcs7?.certificates[0]?.location.bytes).toBeGreaterThan(0);
    for (const name of [
      pkcs7?.certificates[0]?.issuer,
      pkcs7?.certificates[0]?.subject,
      pkcs7?.signers[0]?.issuer,
    ])
      expect(name?.attributes.map(({ rdn_index }) => rdn_index)).toEqual([
        0, 1,
      ]);
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest("reports unsigned attributes through CLI and MCP", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-pe-cert-unsigned-attrs-");
  const path = join(root, "timestamped.exe");
  const payload = pkcs7SignedDataFixture(undefined, undefined, undefined, [
    [1, 3, 6, 1, 4, 1, 311, 3, 3, 1],
  ]);
  await writeFile(path, peCertificateFixture(true, payload));
  const result = await cli.run({
    arguments: ["inspect-pe-certificates", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const call = await cli.sharedMcpCall!();
  const response = await call("inspect_pe_certificates", { path });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  for (const value of [result.json, response.structuredContent]) {
    const report = contract.outputSchema.parse(value).normalized_result;
    expect(report.coverage.status).toBe("partial");
    expect(
      report.entries[0]?.pkcs7?.signers[0]?.unsigned_attribute_oids,
    ).toEqual(["1.3.6.1.4.1.311.3.3.1"]);
    expect(report.limitations).toContain(
      "Signer unsigned attribute contents are not decoded; nested signatures and timestamp token certificates and times may be omitted.",
    );
  }
});

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
    const evidence = contract.outputSchema.parse(result.json);
    expect(evidence).toMatchObject({
      confidence: "observed",
      subject: {
        local_path: path,
        identity: { format: "pe", architecture: "x86" },
      },
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
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
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
    const result = await cli.run({
      arguments: ["inspect-pe-certificates", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_pe_certificates",
        failure_kind: "malformed",
        format: "pe-certificate-table",
      },
    });
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
    const evidence = contract.outputSchema.parse(result.json);
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
  },
  {
    allowance: "ASN.1 value count",
    certificates: 600,
    limits: { max_asn1_values: 16_384 },
  },
])(
  "reports the fixed $allowance allowance as a resource constraint",
  async ({ certificates, limits }, { cli }) => {
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
        refusal: {
          kind: "fixed_ceiling",
          allowance_kind: "parser",
          limit: Object.values(limits)[0],
        },
      },
    });
  },
);
