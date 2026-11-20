import { expect, it } from "vitest";
import {
  inspectVsixPackageInputSchema,
  vsixActivationIsEager,
  vsixMemberMagicKind,
  vsixPackagePathKind,
  vsixPackagePathTraverses,
  vsixPackageSchema,
} from "./vsixPackage.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const jsonSchema = (schema: {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: (options: {
        readonly target: "draft-2020-12";
      }) => unknown;
    };
  };
}): Record<string, unknown> =>
  schema["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  }) as Record<string, unknown>;

it("applies the shared absolute local-path policy to the public input", () => {
  expect(
    inspectVsixPackageInputSchema.safeParse({ path: "pkg.vsix" }).success,
  ).toBe(false);
  expect(inspectVsixPackageInputSchema.safeParse({ path: "" }).success).toBe(
    false,
  );
  expect(
    inspectVsixPackageInputSchema.safeParse({
      path: "/artifacts/pkg\0.vsix",
    }).success,
  ).toBe(false);
  expect(
    inspectVsixPackageInputSchema.safeParse({
      path: "/artifacts/pkg.vsix",
    }).success,
  ).toBe(true);

  const shared = jsonSchema(absoluteLocalPathStringSchema);
  const advertised = jsonSchema(inspectVsixPackageInputSchema);
  const path = (
    advertised.properties as Record<string, Record<string, unknown>>
  ).path;
  const {
    $schema: _schema,
    description: _sharedDescription,
    ...sharedPolicy
  } = shared;
  const { description: _pathDescription, ...pathPolicy } = path ?? {};
  expect(pathPolicy).toEqual(sharedPolicy);
  expect(path?.description).toBe(
    "Absolute filesystem path to a VS Code .vsix package",
  );
});

const unknownIdentityReport = {
  artifact: {
    path: "/artifacts/pkg.vsix",
    sha256: "a".repeat(64),
    bytes: 16,
  },
  vsix_identity: null,
  package_identity: null,
  identity_disagreements: [],
  engine: { vsixmanifest: null, package_json: null, disagreement: false },
  target_platform: null,
  entry_points: { main: null, browser: null },
  activation_events: [],
  contributes: {
    keys: [],
    commands: [],
    commands_total: 0,
    commands_omitted: 0,
  },
  extension_dependencies: {
    vsixmanifest: [],
    package_json: [],
    disagreement: false,
  },
  extension_pack: {
    vsixmanifest: [],
    package_json: [],
    disagreement: false,
  },
  extension_kind: [],
  capabilities: {
    untrusted_workspaces: null,
    virtual_workspaces: null,
  },
  enabled_api_proposals: [],
  assets: [],
  signatures: { p7s: false, manifest: false },
  contents: [],
  member_kind_counts: {
    vsixmanifest: 0,
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
  vsixmanifest: null,
  package_json: null,
  coverage: { status: "complete", entries: 0, examined_manifest_bytes: 0 },
  limitations: ["No extension.vsixmanifest was selected."],
};

it("rejects extra caller arguments and admits a package with unknown identity", () => {
  expect(
    inspectVsixPackageInputSchema.safeParse({
      path: "/artifacts/pkg.vsix",
      extra: true,
    }).success,
  ).toBe(false);
  const report = vsixPackageSchema.parse(unknownIdentityReport);
  expect(report.vsix_identity).toBeNull();
  expect(report.vsixmanifest).toBeNull();
});

it("admits a ZIP64 interesting member larger than 4 GiB without a digest", () => {
  const report = vsixPackageSchema.parse({
    ...unknownIdentityReport,
    interesting_members: [
      {
        path: "extension/dist/module.wasm",
        kind: "wasm",
        bytes: 0x1_0000_0001,
        sha256: null,
        classification: "inferred",
      },
    ],
  });
  expect(report.interesting_members[0]?.bytes).toBe(0x1_0000_0001);
});

it("derives member kinds from ZIP names", () => {
  expect(vsixPackagePathKind("extension.vsixmanifest")).toBe("vsixmanifest");
  expect(vsixPackagePathKind("extension/package.json")).toBe("package_json");
  expect(vsixPackagePathKind("[Content_Types].xml")).toBe("content_types");
  expect(vsixPackagePathKind("_rels/.rels")).toBe("opc");
  expect(vsixPackagePathKind("extension.signature.p7s")).toBe("signature");
  expect(vsixPackagePathKind(".signature.manifest")).toBe("signature");
  expect(vsixPackagePathKind("extension/out/extension.js")).toBe("javascript");
  expect(vsixPackagePathKind("extension/native/addon.node")).toBe(
    "native_addon",
  );
  expect(vsixPackagePathKind("extension/mod.wasm")).toBe("wasm");
  expect(vsixPackagePathKind("extension/tools/run.sh")).toBe("shell_script");
  expect(vsixPackagePathKind("extension/bin/helper.exe")).toBe("executable");
  expect(vsixPackagePathKind("extension/vendor/payload.zip")).toBe(
    "nested_archive",
  );
  expect(vsixPackagePathKind("extension/server/server.jar")).toBe(
    "nested_archive",
  );
  expect(vsixPackagePathKind("extension/lib/App.WAR")).toBe("nested_archive");
  expect(vsixPackagePathKind("extension/readme.md")).toBe("unknown");
});

it("detects path traversal and eager activation events", () => {
  expect(vsixPackagePathTraverses("../outside.js")).toBe(true);
  expect(vsixPackagePathTraverses("/etc/passwd")).toBe(true);
  expect(vsixPackagePathTraverses("extension/out/extension.js")).toBe(false);
  expect(vsixActivationIsEager("*")).toBe(true);
  expect(vsixActivationIsEager("onStartupFinished")).toBe(true);
  expect(vsixActivationIsEager("onCommand:demo.hello")).toBe(false);
});

it("classifies member magic with BinaryReader", () => {
  expect(vsixMemberMagicKind(Uint8Array.from([0x00, 0x61, 0x73, 0x6d]))).toBe(
    "wasm",
  );
  expect(vsixMemberMagicKind(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46]))).toBe(
    "executable",
  );
  expect(vsixMemberMagicKind(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]))).toBe(
    "executable",
  );
  expect(vsixMemberMagicKind(Uint8Array.from([0x23, 0x21, 0x2f, 0x62]))).toBe(
    "shell_script",
  );
  expect(vsixMemberMagicKind(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe(
    "nested_archive",
  );
  expect(vsixMemberMagicKind(Uint8Array.from([0x1f, 0x8b, 0x08, 0x00]))).toBe(
    "nested_archive",
  );
  expect(vsixMemberMagicKind(Uint8Array.from([0x00, 0x01, 0x02, 0x03]))).toBe(
    undefined,
  );
});
