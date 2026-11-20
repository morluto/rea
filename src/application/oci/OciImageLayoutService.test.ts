import { expect, it } from "vitest";

import { OciImageLayoutService } from "./OciImageLayoutService.js";
import {
  inspectOciImageLayoutInputSchema,
  type OciImageLayout,
} from "../../domain/oci/imageLayout.js";
import { createOciImageLayoutEvidence } from "../../domain/oci/imageLayoutEvidence.js";
import { err, ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
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

it("keeps caller selections in Evidence recovered from a cleanup failure", async () => {
  const resolved = inspectOciImageLayoutInputSchema.parse({
    path: report.artifact.path,
  });
  const service = new OciImageLayoutService({
    close: async () => {},
    identity,
    inspect: () =>
      Promise.resolve(
        err(
          new AnalysisOutputError("inspect_oci_image_layout", "cleanup", {
            partialObservation: createOciImageLayoutEvidence(
              identity,
              resolved,
              report,
            ),
          }),
        ),
      ),
  });
  const result = await service.inspect({ path: report.artifact.path });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const success = await new OciImageLayoutService({
    close: async () => {},
    identity,
    inspect: async () => ok(report),
  }).inspect({ path: report.artifact.path });
  if (!success.ok) throw success.error;
  expect(result.error.partialObservation).toEqual(success.value);
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

it("accepts JSON reads up to the per-document budget for every manifest and config", async () => {
  // oci-layout, index.json, then a manifest and a config for each of three
  // images, every document at max_json_bytes.
  const jsonBytes = 1024;
  const images: OciImageLayout["images"] = [1, 2, 3].map((n) => ({
    digest: "sha256:" + String(n).repeat(64),
    media_type: "application/vnd.oci.image.manifest.v1+json",
    config_digest: "sha256:" + String(n + 3).repeat(64),
    architecture: null,
    os: null,
    variant: null,
    created: null,
    author: null,
    user: null,
    env: [],
    entrypoint: null,
    cmd: null,
    working_dir: null,
    exposed_ports: [],
    volumes: [],
    labels: [],
    stop_signal: null,
    rootfs_diff_ids: [],
    history: [],
    layers: [],
  }));
  const service = new OciImageLayoutService({
    close: async () => {},
    identity,
    inspect: async () =>
      ok({
        ...report,
        images,
        coverage: { ...report.coverage, json_bytes_read: jsonBytes * 8 },
      }),
  });
  // The root index, its three entries and three manifests decode seven
  // descriptors.
  const result = await service.inspect({
    path: report.artifact.path,
    max_json_bytes: jsonBytes,
    max_descriptors: 7,
  });
  if (!result.ok) throw result.error;
});

it("rejects JSON reads beyond what the descriptor budget allows", async () => {
  const service = new OciImageLayoutService({
    close: async () => {},
    identity,
    inspect: async () =>
      ok({
        ...report,
        coverage: { ...report.coverage, json_bytes_read: 1024 * 8 + 1 },
      }),
  });
  const result = await service.inspect({
    path: report.artifact.path,
    max_json_bytes: 1024,
    max_descriptors: 3,
  });
  expect(result.ok).toBe(false);
});
