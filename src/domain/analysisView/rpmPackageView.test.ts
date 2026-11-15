import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import type { RpmPackage } from "../rpm/package.js";
import { projectAnalysisView } from "./analysisView.js";
import { rpmPackageSummaryViewResultSchema } from "./analysisViewResult.js";
import { analysisViewRequestSchema } from "./analysisViewRequest.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

const report: RpmPackage = {
  artifact: {
    path: "/artifacts/demo.rpm",
    sha256: "a".repeat(64),
    bytes: 256,
  },
  lead: {
    magic: "edabeedb",
    version: { major: 3, minor: 0 },
    type: "binary",
    arch_number: 1,
    os_number: 1,
    name: "demo-1.0.0-1",
    signature_type: 5,
    location: { offset: 0, bytes: 96 },
  },
  signature: {
    location: { offset: 96, bytes: 64 },
    pad_bytes: 0,
    index_entries: 1,
    store_bytes: 16,
    size: 256,
    md5: null,
    sha1_header: null,
    sha256_header: null,
    payload_digest: null,
    payload_digest_algorithm: null,
    blobs: [
      {
        present: true,
        tag: "rsa",
        bytes: 32,
        algorithm: "rsa",
        key_id: "a1b2c3d4e5f60708",
      },
    ],
  },
  header: {
    location: { offset: 160, bytes: 80 },
    index_entries: 4,
    store_bytes: 16,
    immutable_region: null,
  },
  package: {
    name: "demo",
    version: "1.0.0",
    release: "1",
    epoch: 2,
    arch: "noarch",
    os: "linux",
    summary: null,
    license: "MIT",
    vendor: null,
    packager: null,
    url: null,
    build_time: null,
    build_host: null,
    source_rpm: null,
    payload_format: "cpio",
    payload_compressor: "gzip",
    payload_flags: null,
  },
  provides: [
    {
      name: "demo",
      version: "1.0.0-1",
      flags: 8,
      comparison: "=",
      rpmlib: false,
      scriptlet_only: false,
    },
  ],
  requires: null,
  conflicts: null,
  obsoletes: null,
  recommends: null,
  suggests: null,
  supplements: null,
  enhances: null,
  scriptlets: [
    {
      kind: "prein",
      interpreter: "/bin/sh",
      bytes: 11,
      text: null,
      trigger_names: null,
    },
  ],
  files: [
    {
      path: "/usr/bin/demo",
      size: 12,
      mode: 0o100755,
      digest: null,
      digest_algorithm: null,
      digest_algorithm_id: null,
      flags: 0,
      config: false,
      doc: false,
      user: "root",
      group: "root",
    },
    {
      path: "/etc/demo.conf",
      size: 4,
      mode: 0o100644,
      digest: null,
      digest_algorithm: null,
      digest_algorithm_id: null,
      flags: 1,
      config: true,
      doc: false,
      user: "root",
      group: "root",
    },
  ],
  payload: {
    offset: 240,
    size: 16,
    format: "cpio",
    compressor: "gzip",
    flags: null,
    listing_source: "header",
  },
  coverage: { status: "complete", header_tags: 4, files: 2, dependencies: 1 },
  limitations: ["Package condition"],
};

const parent = (): AnalysisViewParent => {
  const evidence = createEvidence(
    {
      path: report.artifact.path,
      sha256: report.artifact.sha256,
      format: "file",
    },
    { id: "rea-rpm-package", name: "REA RPM package reader", version: "1" },
    {
      operation: "inspect_rpm_package",
      parameters: {},
      result: report,
      limitations: ["Parent condition"],
    },
  );
  return {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    normalizedResult: report,
    subject: evidence.subject,
    limitations: evidence.limitations,
  };
};

it("summarizes RPM package Evidence with identity and counts", () => {
  const result = projectAnalysisView(
    parent(),
    analysisViewRequestSchema.parse({ kind: "summary" }),
  );
  if (!result.ok) throw result.error;
  const view = rpmPackageSummaryViewResultSchema.parse(result.value);
  expect(view.summary).toMatchObject({
    package: { name: "demo", version: "1.0.0", release: "1" },
    lead: { type: "binary" },
    file_count: 2,
    scriptlet_count: 1,
    signature_blob_count: 1,
    dependency_count: 1,
  });
  expect(view.limitations).toEqual(
    expect.arrayContaining(["Parent condition", "Package condition"]),
  );
});
