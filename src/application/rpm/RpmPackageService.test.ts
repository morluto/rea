import { expect, it } from "vitest";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { RpmPackage } from "../../domain/rpm/package.js";
import { ok } from "../../domain/result.js";
import { RpmPackageService } from "./RpmPackageService.js";

const identity = {
  id: "fixture-rpm-package",
  name: "Source-owned RPM reader seam",
  version: "1",
};

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
  limitations: [
    "This workflow reads RPM lead, signature and header metadata without installing the package, running scriptlets, verifying signatures, or decompressing the payload.",
  ],
};

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new RpmPackageService({
    close: async () => {},
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "demo.rpm" });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it("records the selected artifact and header ranges", async () => {
  const result = await new RpmPackageService({
    close: async () => {},
    identity,
    inspect: () => Promise.resolve(ok(report)),
  }).inspect({ path: report.artifact.path });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    confidence: "observed",
    subject: { identity: { format: "file" } },
    normalized_result: report,
  });
  expect(result.value.locations).toEqual(
    expect.arrayContaining([
      { kind: "artifact-path", path: report.artifact.path },
      {
        kind: "file-offset-range",
        start: 0,
        end: 96,
      },
    ]),
  );
});

it("discards an observation if the caller cancels while the provider completes", async () => {
  const controller = new AbortController();
  const reason = { source: "caller-request", operation: "cancel" };
  const service = new RpmPackageService({
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
  }
});

it("refuses a provider report that claims more files than the caller budget", async () => {
  const result = await new RpmPackageService({
    close: async () => {},
    identity,
    inspect: () =>
      Promise.resolve(
        ok({
          ...report,
          files: report.files,
        }),
      ),
  }).inspect({ path: report.artifact.path, max_files: 1 });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
});
