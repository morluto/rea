import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { repeatedCertificateSignedData } from "../../../tests/fixtures/peCertificateAllowance.js";
import {
  indefinite,
  tlv,
  signedDataBlock,
  signerInfo,
  LEAF_CERTIFICATE,
} from "../../../tests/fixtures/apkSignature/v1SignatureBlock.js";
import { inspectPeCertificatesInputSchema } from "../../domain/native/peCertificates.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { peCertificateFixture } from "./PeCertificates.fixture.js";
import { PeCertificatesProvider } from "./PeCertificatesProvider.js";

const encapsulated = (depth: number): Buffer => {
  let content = tlv(0x04, Uint8Array.of(1));
  for (let level = 0; level < depth; level += 1)
    content = indefinite(0x24, content);
  return Buffer.from(
    signedDataBlock({
      certificates: [LEAF_CERTIFICATE],
      signerInfos: [signerInfo({ names: LEAF_CERTIFICATE })],
      encapsulatedContent: content,
    }),
  );
};

const inspect = async (payload: Buffer) => {
  const path = join(
    await createTestTempDirectory("rea-pe-decoder-allowance-"),
    "inert.exe",
  );
  await writeFile(path, peCertificateFixture(false, payload));
  const provider = new PeCertificatesProvider();
  try {
    return await provider.inspect(
      inspectPeCertificatesInputSchema.parse({ path }),
    );
  } finally {
    await provider.close();
  }
};

it.each([
  {
    name: "depth",
    payload: () => encapsulated(40),
    limits: { max_asn1_depth: 32 },
    description: "32 nesting levels",
  },
  {
    name: "nodes",
    payload: () => repeatedCertificateSignedData(600),
    limits: { max_asn1_values: 16_384 },
    description: "16384 values",
  },
  {
    name: "text",
    payload: () => repeatedCertificateSignedData(350),
    limits: { max_decoded_text_bytes: 65_536 },
    description: "65536 bytes",
  },
])(
  "reports the fixed $name allowance with its own resource and recovery",
  async ({ payload, limits, description }) => {
    const result = await inspect(payload());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected decoder refusal");
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(result.error instanceof AnalysisResourceConstraintError))
      throw result.error;
    expect(result.error.reportedLimits).toEqual(limits);
    expect(result.error.retryable).toBe(false);
    expect(result.error.fixedAllowance?.name).toContain(description);
    expect(result.error.fixedAllowance?.name).toContain("no runtime override");
  },
);

it("accepts shallower valid BER and keeps malformed BER an input failure", async () => {
  expect((await inspect(encapsulated(1))).ok).toBe(true);
  const malformed = await inspect(Buffer.from([0x30, 0x03, 0x05]));
  expect(malformed.ok).toBe(false);
  if (malformed.ok) throw new Error("Expected malformed input refusal");
  expect(malformed.error).toBeInstanceOf(AnalysisInputError);
});

it.each([
  {
    name: "bytes",
    content: Buffer.from([0x2a, ...Array<number>(256).fill(0)]),
    limits: { max_oid_bytes: 256 },
  },
  {
    name: "arc bytes",
    content: Buffer.from([0x2a, 0x81, ...Array<number>(31).fill(0x80), 0]),
    limits: { max_oid_arc_bytes: 32 },
  },
])(
  "preserves the canonical OID $name allowance in a valid CMS algorithm",
  async ({ content, limits }) => {
    const algorithm = tlv(0x06, content);
    const result = await inspect(
      Buffer.from(
        signedDataBlock({
          certificates: [LEAF_CERTIFICATE],
          signerInfos: [
            signerInfo({
              names: LEAF_CERTIFICATE,
              digestAlgorithmOid: algorithm,
            }),
          ],
          digestAlgorithmOid: algorithm,
        }),
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected OID allowance refusal");
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(result.error instanceof AnalysisResourceConstraintError))
      throw result.error;
    expect(result.error.reportedLimits).toEqual(limits);
    expect(result.error.retryable).toBe(false);
    expect(result.error.fixedAllowance?.name).toContain("OBJECT IDENTIFIER");
    expect(result.error.fixedAllowance?.name).toContain("no runtime override");
  },
);
