import { expect, it } from "vitest";
import { VsixPackageService } from "./VsixPackageService.js";
import type { VsixPackage } from "../../domain/vsix/vsixPackage.js";
import { ok } from "../../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";

const identity = {
  id: "fixture-vsix-package",
  name: "Source-owned vsix reader seam",
  version: "1",
};

const report: VsixPackage = {
  artifact: {
    path: "/artifacts/demo.vsix",
    sha256: "a".repeat(64),
    bytes: 64,
  },
  vsix_identity: {
    id: "demo.hello",
    version: "1.2.3",
    publisher: "demo",
    target_platform: "win32-x64",
    display_name: "Hello Demo",
    description: "A tiny fixture extension.",
  },
  package_identity: {
    name: "hello",
    publisher: "demo",
    version: "1.2.3",
  },
  identity_disagreements: [],
  engine: {
    vsixmanifest: "^1.74.0",
    package_json: "^1.74.0",
    disagreement: false,
  },
  target_platform: "win32-x64",
  entry_points: {
    main: { path: "extension/out/extension.js", present: true },
    browser: { path: "extension/out/web/extension.js", present: true },
  },
  activation_events: [
    { event: "onCommand:demo.hello", eager: false },
    { event: "*", eager: true },
  ],
  contributes: {
    keys: [{ name: "commands", count: 1 }],
    commands: [{ command: "demo.hello", title: "Say Hello" }],
    commands_total: 1,
    commands_omitted: 0,
  },
  extension_dependencies: {
    vsixmanifest: ["other.dep"],
    package_json: ["other.dep"],
    disagreement: false,
  },
  extension_pack: {
    vsixmanifest: ["demo.pack-a"],
    package_json: ["demo.pack-a"],
    disagreement: false,
  },
  extension_kind: ["workspace"],
  capabilities: {
    untrusted_workspaces: { supported: "true", description: null },
    virtual_workspaces: null,
  },
  enabled_api_proposals: ["testObserver"],
  assets: [],
  signatures: { p7s: false, manifest: false },
  contents: [
    {
      name: "extension.vsixmanifest",
      path: "extension.vsixmanifest",
      uncompressed_size: 12,
      compressed_size: 12,
      encrypted: false,
      kind: "vsixmanifest",
      traverses: false,
    },
  ],
  member_kind_counts: {
    vsixmanifest: 1,
    package_json: 0,
    content_types: 0,
    opc: 0,
    signature: 0,
    javascript: 0,
    native_addon: 0,
    wasm: 0,
    executable: 0,
    shell_script: 0,
    nested_archive: 0,
    unknown: 0,
  },
  interesting_members: [],
  duplicate_paths: [],
  vsixmanifest: { path: "extension.vsixmanifest", bytes: 12 },
  package_json: null,
  coverage: { status: "complete", entries: 1, examined_manifest_bytes: 12 },
  limitations: [
    "This workflow reads the .vsix ZIP, extension.vsixmanifest and extension/package.json without installing, executing, or contacting a marketplace.",
  ],
};

it("rejects a relative path and extra arguments before reading", async () => {
  let calls = 0;
  const service = new VsixPackageService({
    close: async () => {},
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  const relative = await service.inspect({ path: "pkg.vsix" });
  const extra = await service.inspect({
    path: report.artifact.path,
    extra: true,
  });
  const nul = await service.inspect({ path: "/artifacts/pkg\0.vsix" });
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
  const service = new VsixPackageService({
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
      operation: "inspect_vsix_package",
      parameters: { path: report.artifact.path },
      normalized_result: report,
    });
  }
});

it.each([undefined, 67108864, 128])(
  "preserves the caller's selected file budget %s",
  async (maximum) => {
    const input = {
      path: report.artifact.path,
      ...(maximum === undefined ? {} : { max_file_bytes: maximum }),
    };
    const service = new VsixPackageService({
      close: async () => {},
      identity,
      inspect: async () => ok(report),
    });
    const result = await service.inspect(input);
    if (!result.ok) throw result.error;
    expect(result.value.parameters).toEqual(input);
  },
);

it("allows examined_manifest_bytes across three manifest reads and rejects more", async () => {
  let examined = 2700;
  const service = new VsixPackageService({
    close: async () => {},
    identity,
    inspect: async () =>
      ok({
        ...report,
        coverage: { ...report.coverage, examined_manifest_bytes: examined },
      }),
  });
  const allowed = await service.inspect({
    path: report.artifact.path,
    max_manifest_bytes: 1024,
  });
  expect(allowed.ok).toBe(true);
  examined = 3073;
  const rejected = await service.inspect({
    path: report.artifact.path,
    max_manifest_bytes: 1024,
  });
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error).toBeInstanceOf(AnalysisOutputError);
});
