import { createHash, X509Certificate } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { apkSignatureResultSchema } from "../../src/domain/apkSignature/apkSignatureReport.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import {
  APK_SIGNATURE_V2_ID,
  LEAF_CERTIFICATE,
  LEAF_SHA256,
  ROOT_CERTIFICATE,
  OID_SHA256,
  OID_ECDSA_SHA256,
  organizationalUnits,
  withSubject,
  signedDataBlock,
  signerInfo,
  tlv,
  oid,
  zipWith,
  withSigningBlock,
  v2SchemeValue,
} from "../fixtures/apkSignature/v1SignatureBlock.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const changed = withSubject(
  LEAF_CERTIFICATE,
  organizationalUnits(1, "Another certificate"),
);
const fingerprint = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const byKey = tlv(
  0x30,
  tlv(0x02, Uint8Array.of(3)),
  // SubjectKeyIdentifier of the independently produced OpenSSL leaf fixture.
  tlv(0x80, Buffer.from("eeee4ca425e9750d7ab95429abcc7c66a10869f8", "hex")),
  tlv(0x30, oid(OID_SHA256)),
  tlv(0x30, oid(OID_ECDSA_SHA256)),
  tlv(0x04, Uint8Array.of(1, 2, 3)),
);

for (const mode of ["issuer-and-serial", "subject-key-identifier"] as const)
  cliTest(
    `keeps distinct certificates matching one ${mode} unknown through public inspection`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-apk-v1-identity-");
      // Different raw certificate identities can share either supported signer identifier.
      const original = new X509Certificate(LEAF_CERTIFICATE);
      const alternate = new X509Certificate(changed);
      expect(alternate.issuer).toBe(original.issuer);
      expect(alternate.serialNumber).toBe(original.serialNumber);
      expect(fingerprint(changed)).not.toBe(LEAF_SHA256);
      const info =
        mode === "issuer-and-serial"
          ? signerInfo({ names: LEAF_CERTIFICATE })
          : byKey;
      const mcp = await cli.sharedMcpCall!();
      const observations = [];
      const expectedObservations = [];
      for (const [name, certificates, expected] of [
        ["collision", [LEAF_CERTIFICATE, changed], null],
        ["reversed", [changed, LEAF_CERTIFICATE], null],
        [
          "duplicate-before-collision",
          [LEAF_CERTIFICATE, LEAF_CERTIFICATE, changed],
          null,
        ],
        [
          "duplicate-encoding",
          [LEAF_CERTIFICATE, LEAF_CERTIFICATE],
          LEAF_SHA256,
        ],
        ["unrelated", [ROOT_CERTIFICATE, LEAF_CERTIFICATE], LEAF_SHA256],
      ] as const) {
        const path = join(root, `${name}.apk`);
        const zip = await zipWith([
          { name: "META-INF/CERT.SF", data: "Signature-Version: 1.0" },
          {
            name: "META-INF/CERT.EC",
            data: signedDataBlock({ certificates, signerInfos: [info] }),
          },
        ]);
        await writeFile(
          path,
          withSigningBlock(zip, [
            {
              id: APK_SIGNATURE_V2_ID,
              value: v2SchemeValue(LEAF_CERTIFICATE),
            },
          ]),
        );
        let output: unknown;
        if (mode === "issuer-and-serial") {
          const result = await cli.run({
            arguments: ["inspect-apk-signature", path, "--json"],
          });
          expect(result.exitCode, result.stdout + result.stderr).toBe(0);
          output = result.json;
        } else {
          const result = await mcp("inspect_apk_signature", {
            path,
            detail: "complete",
          });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          output = result.structuredContent;
        }
        const evidence = parseEvidence(output);
        const report = apkSignatureResultSchema.parse(
          evidence.normalized_result,
        );
        const signer = report.schemes.v1.signers[0];
        expect(signer?.decode_error).toBeNull();
        expect(
          signer?.certificates.map(
            (certificate) => certificate.sha256_fingerprint,
          ),
        ).toEqual(certificates.map(fingerprint));
        observations.push({
          name,
          certificate: signer?.certificate?.sha256_fingerprint ?? null,
          identified: signer?.signer_infos[0]?.certificate_sha256,
          agreement: report.posture.v1_signers_match_block_signers,
          ambiguityNoted: evidence.limitations.some((note) =>
            note.includes("multiple distinct certificates match"),
          ),
        });
        expectedObservations.push({
          name,
          certificate: expected,
          identified: expected,
          agreement:
            mode === "subject-key-identifier" || expected === null
              ? null
              : true,
          ambiguityNoted: expected === null,
        });
      }
      expect(observations).toEqual(expectedObservations);
    },
  );
