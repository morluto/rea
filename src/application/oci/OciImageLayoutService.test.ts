import { expect, it } from "vitest";

import { OciImageLayoutService } from "./OciImageLayoutService.js";
import type { OciImageLayout } from "../../domain/oci/imageLayout.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";

const identity = {
  id: "fixture-oci-image-layout",
  name: "Source-owned OCI image-layout reader seam",
  version: "1",
};

const report: OciImageLayout = {
  artifact: {
    path: "/artifacts/busybox.oci",
    format: "directory",
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
  images: [],
  blobs: [],
  findings: [],
  coverage: {
    status: "complete",
    entries_examined: 4,
    blobs_hashed: 0,
    json_bytes_read: 64,
  },
  limitations: [
    "This workflow reads an OCI image-layout directory without decompressing layers, executing the image, or contacting a registry. Tar image layouts are not inspected.",
  ],
};

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new OciImageLayoutService({
    close: async () => {},
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "busybox.oci" });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  const nul = await service.inspect({ path: "/artifacts/busybox\0.oci" });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  expect(nul.ok).toBe(false);
  if (!relative.ok)
    expect(relative.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [{ path: ["path"] }],
    });
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  if (!nul.ok)
    expect(nul.error).toMatchObject({
      _tag: "AnalysisInputError",
      issues: [{ path: ["path"] }],
    });
  expect(calls).toBe(0);
});

it("retains completed Evidence and caller selections on late cancellation", async () => {
  const controller = new AbortController();
  const reason = { source: "caller-request", operation: "cancel" };
  const service = new OciImageLayoutService({
    close: async () => {},
    identity,
    inspect: () => {
      controller.abort(reason);
      return Promise.resolve(ok(report));
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(AnalysisCancelledError);
    expect(result.error.cause).toBe(reason);
    expect(result.error.partialObservation).toMatchObject({
      operation: "inspect_oci_image_layout",
      parameters: { path: report.artifact.path },
      normalized_result: report,
    });
  }
});

it.each([undefined, true, false])(
  "preserves the caller's selected include_env_values %s",
  async (includeEnvValues) => {
    const input = {
      path: report.artifact.path,
      ...(includeEnvValues === undefined
        ? {}
        : { include_env_values: includeEnvValues }),
    };
    const service = new OciImageLayoutService({
      close: async () => {},
      identity,
      inspect: async () => ok(report),
    });
    const result = await service.inspect(input);
    if (!result.ok) throw result.error;
    expect(result.value.parameters).toEqual(input);
  },
);
