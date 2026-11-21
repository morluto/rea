import { expect, it } from "vitest";
import { createEvidence } from "../evidence.js";
import { projectAnalysisView } from "./analysisView.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { ociImageLayoutSummaryViewResultSchema } from "./analysisViewResult.js";
import { analysisViewRequestSchema } from "./analysisViewRequest.js";

const report = {
  artifact: {
    path: "/artifacts/busybox.oci",
    format: "directory" as const,
    snapshot_sha256: "a".repeat(64),
    layout_version: "1.0.0",
    oci_layout_digest: "b".repeat(64),
    index_digest: "c".repeat(64),
  },
  indexes: [
    {
      digest: "sha256:" + "d".repeat(64),
      media_type: "application/vnd.oci.image.index.v1+json",
      schema_version: 2,
      depth: 0,
      entries: [],
    },
  ],
  images: [
    {
      digest: "sha256:" + "e".repeat(64),
      media_type: "application/vnd.oci.image.manifest.v1+json",
      config_digest: "sha256:" + "f".repeat(64),
      architecture: "amd64",
      os: "linux",
      variant: null,
      created: "2024-01-02T03:04:05Z",
      author: "fixture@example.invalid",
      user: "nobody",
      env: [{ name: "PATH", value: null }],
      entrypoint: ["/bin/sh"],
      cmd: ["-c", "true"],
      working_dir: "/",
      exposed_ports: ["80/tcp"],
      volumes: ["/data"],
      labels: [],
      stop_signal: "SIGTERM",
      rootfs_diff_ids: [],
      history: [],
      layers: [],
    },
  ],
  blobs: [],
  findings: [
    {
      kind: "digest_mismatch" as const,
      digest: "sha256:" + "e".repeat(64),
      path: "blobs/sha256/" + "e".repeat(64),
      message: "Blob content does not match its digest.",
    },
  ],
  coverage: {
    status: "complete" as const,
    entries_examined: 8,
    blobs_hashed: 3,
    json_bytes_read: 512,
  },
  limitations: ["Layout condition"],
};

const parent = (): AnalysisViewParent => {
  const evidence = createEvidence(
    {
      path: report.artifact.path,
      sha256: report.artifact.snapshot_sha256,
      format: "directory",
    },
    {
      id: "rea-oci-image-layout",
      name: "REA OCI image layout reader",
      version: "1",
    },
    {
      operation: "inspect_oci_image_layout",
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

it("summarizes OCI image-layout Evidence with counts and finding kinds", () => {
  const result = projectAnalysisView(
    parent(),
    analysisViewRequestSchema.parse({ kind: "summary" }),
  );
  if (!result.ok) throw result.error;
  const view = ociImageLayoutSummaryViewResultSchema.parse(result.value);
  expect(view.summary).toMatchObject({
    artifact: { layout_version: "1.0.0", format: "directory" },
    index_count: 1,
    image_count: 1,
    blob_count: 0,
    finding_count: 1,
    finding_kinds: ["digest_mismatch"],
    limitation_count: 1,
  });
  expect(view.limitations).toEqual(
    expect.arrayContaining(["Parent condition", "Layout condition"]),
  );
});
