import { expectInvalidInspectionInputs } from "../../../tests/support/expectInvalidInspectionInputs.js";
import { lateCancellationEvidence } from "../../../tests/support/lateCancellationEvidence.js";
import { inspectPeCertificatesInputSchema } from "../../domain/native/peCertificates.js";
import {
  peCertificateFixture,
  peWithoutCertificateTableFixture,
} from "../../native/pe/PeCertificates.fixture.js";
import { parsePeCertificateFixture } from "../../../tests/fixtures/binaryDiagnostics/peCertificates.js";
import { expect, it } from "vitest";
import { PeCertificatesService } from "./PeCertificatesService.js";
import { PE_CERTIFICATES_PROVIDER } from "../../domain/investigationProviders.js";
import type { PeCertificates } from "../../domain/native/peCertificates.js";
import { ok } from "../../domain/result.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";

const identity = PE_CERTIFICATES_PROVIDER;
const input = inspectPeCertificatesInputSchema.parse({
  path: "/artifacts/app.exe",
});
const report = await parsePeCertificateFixture(
  peWithoutCertificateTableFixture(),
  input,
);

it("rejects a relative path and extra arguments before reading", () =>
  expectInvalidInspectionInputs(
    report,
    "app.exe",
    (inspect) => new PeCertificatesService({ identity, inspect }),
  ));

it("retains a completed observation when the caller cancels as the provider completes", async () => {
  const evidence = await lateCancellationEvidence(
    report,
    "late PeCertificates cancellation",
    (inspect) => new PeCertificatesService({ identity, inspect }),
  );
  expect(evidence).toMatchObject({
    operation: "inspect_pe_certificates",
    normalized_result: report,
  });
});

it("retains complete certificate provenance from the production parser", async () => {
  const parsed = await parsePeCertificateFixture(
    peCertificateFixture(false),
    input,
  );
  const result = await new PeCertificatesService({
    identity,
    inspect: () => Promise.resolve(ok(parsed)),
  }).inspect({ path: parsed.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value.normalized_result).toEqual(parsed);
});

it.each([
  [
    "invented examined entry",
    (value: PeCertificates) => {
      value.coverage.examined_entries += 1;
    },
  ],
  [
    "entries without a table",
    (value: PeCertificates) => {
      value.table = null;
    },
  ],
  [
    "data directory outside the artifact",
    (value: PeCertificates) => {
      value.table!.data_directory_location.offset = value.artifact.bytes;
    },
  ],
  [
    "entry outside its table",
    (value: PeCertificates) => {
      value.entries[0]!.location.offset = 0;
    },
  ],
  [
    "payload outside its entry",
    (value: PeCertificates) => {
      value.entries[0]!.payload.location.offset = 0;
    },
  ],
  [
    "certificate outside its payload",
    (value: PeCertificates) => {
      value.entries[0]!.pkcs7!.certificates[0]!.location.offset = 0;
    },
  ],
  [
    "complete coverage with undecoded unsigned attributes",
    (value: PeCertificates) => {
      value.entries[0]!.pkcs7!.signers[0]!.unsigned_attribute_oids = [
        "1.3.6.1.4.1.311.3.3.1",
      ];
    },
  ],
] as const)(
  "rejects %s before creating observed Evidence",
  async (_label, mutate) => {
    const parsed = await parsePeCertificateFixture(
      peCertificateFixture(false),
      input,
    );
    mutate(parsed);
    const result = await new PeCertificatesService({
      identity,
      inspect: () => Promise.resolve(ok(parsed)),
    }).inspect({ path: parsed.artifact.path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
  },
);
