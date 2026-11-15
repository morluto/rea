import { expect, it } from "vitest";

import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { DebPackage } from "../../domain/deb/debPackage.js";
import { ok } from "../../domain/result.js";
import { DebPackageService } from "./DebPackageService.js";

const identity = {
  id: "rea-deb-package",
  name: "Source-owned Debian package reader seam",
  version: "1",
};

const report: DebPackage = {
  artifact: {
    path: "/artifacts/hello.deb",
    sha256: "a".repeat(64),
    bytes: 128,
  },
  ar: {
    magic: "!<arch>\n",
    format_version: "2.0",
    members: [
      {
        name: "debian-binary",
        role: "debian-binary",
        size: 4,
        offset: 8,
        compression: null,
      },
    ],
    extra_member_names: [],
  },
  control: {
    package: "hello",
    version: { raw: "1:2.03-1", epoch: 1, upstream: "2.03", revision: "1" },
    architecture: "all",
    maintainer: "Alice <alice@example.com>",
    installed_size: 12,
    section: "misc",
    priority: "optional",
    homepage: "https://example.invalid/hello",
    description_summary: "greeting tool",
    source: "hello",
    multi_arch: "foreign",
    essential: false,
    relationships: {
      depends: [
        [
          {
            name: "libc6",
            arch_qualifier: null,
            operator: ">=",
            version: "2.34",
            arch_restriction: null,
          },
        ],
      ],
      pre_depends: null,
      recommends: null,
      suggests: null,
      conflicts: null,
      breaks: null,
      replaces: null,
      provides: null,
      enhances: null,
    },
    conffiles: { present: true, count: 1 },
    md5sums: { present: true, count: 1 },
    maintainer_scripts: [
      { name: "preinst", interpreter: "/bin/sh", bytes: 17 },
    ],
  },
  data_entries: [],
  md5sums_cross_check: {
    listed: 1,
    present: 1,
    missing_from_inventory: 0,
    missing_from_md5sums: 0,
  },
  issues: [],
  coverage: {
    status: "complete",
    ar_members: 1,
    control_entries: 1,
    data_entries: 0,
    examined_control_bytes: 64,
    examined_data_bytes: 0,
  },
  limitations: [
    "This workflow reads the .deb ar container and its control/data tars without installing the package or running maintainer scripts.",
  ],
};

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new DebPackageService({
    close: async () => {},
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "hello.deb" });
  const extra = await service.inspect({
    path: report.artifact.path,
    detail: "complete",
  });
  expect(relative.ok).toBe(false);
  expect(extra.ok).toBe(false);
  if (!relative.ok) expect(relative.error).toBeInstanceOf(AnalysisInputError);
  if (!extra.ok) expect(extra.error).toBeInstanceOf(AnalysisInputError);
  expect(calls).toBe(0);
});

it("records the selected artifact as observed Evidence", async () => {
  const result = await new DebPackageService({
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
  expect(result.value.locations).toEqual([
    { kind: "artifact-path", path: report.artifact.path },
    { kind: "file-offset-range", start: 0, end: report.artifact.bytes },
  ]);
});

it("retains completed Debian package Evidence on late cancellation", async () => {
  const controller = new AbortController();
  const reason = new AnalysisInputError("opaque caller metadata");
  const service = new DebPackageService({
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
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(result.error.partialObservation).toMatchObject({
    operation: "inspect_deb_package",
    normalized_result: report,
    subject: { local_path: report.artifact.path },
  });
});

it("retains a pre-admission cancellation reason without calling the provider", async () => {
  const reason = new Error("caller stopped before Debian package admission");
  let calls = 0;
  const service = new DebPackageService({
    close: async () => {},
    identity,
    inspect: async () => {
      calls += 1;
      return ok(report);
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: AbortSignal.abort(reason) },
  );
  if (result.ok) throw new Error("Expected cancellation");
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(result.error.cause).toBe(reason);
  expect(result.error.partialObservation).toBeUndefined();
  expect(calls).toBe(0);
});

it("preserves malformed provider output instead of relabeling it as a late abort", async () => {
  const controller = new AbortController();
  const service = new DebPackageService({
    close: async () => {},
    identity,
    inspect: async () => {
      controller.abort(new Error("later caller stop"));
      return ok({
        ...report,
        artifact: { ...report.artifact, path: "/different.deb" },
      });
    },
  });
  const result = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected output failure");
  expect(result.error).toBeInstanceOf(AnalysisOutputError);
  expect(result.error.partialObservation).toBeUndefined();
});
