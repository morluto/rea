import { ParseFailureError } from "../domain/parseFailure.js";
import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { VsixPackageProvider } from "./VsixPackageProvider.js";
import { ZipReader } from "@zip.js/zip.js";

import {
  inspectVsixPackageInputSchema,
  MAX_INSPECT_VSIX_PACKAGE_MANIFEST_BYTES,
  MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES,
  MAX_INSPECT_VSIX_PACKAGE_MEMBER_BYTES,
  VSIX_COMMANDS_CAP,
  vsixPackageSchema,
} from "../domain/vsix/vsixPackage.js";
import {
  defaultPackageJson,
  defaultVsixManifest,
  vsixPackageFixture,
  vsixPackageMalformedManifestFixture,
  vsixPackageMalformedPackageJsonFixture,
  vsixPackageMissingManifestFixture,
  vsixPackageTraversalFixture,
} from "./VsixPackage.fixture.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import { VSIX_LIMITATIONS, parseVsixPackage } from "./VsixPackageParser.js";

const defaults = inspectVsixPackageInputSchema.parse({
  path: "/artifacts/demo.hello-1.2.3.vsix",
});

const artifactOf = (bytes: Uint8Array) => ({
  path: defaults.path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

const digestOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const ELF = Uint8Array.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0,
]);
const WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const MZ = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
const NESTED_ZIP = Uint8Array.from([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00,
]);
const SHELL = new TextEncoder().encode("#!/bin/sh\necho hi\n");

it("reads identity from both manifests, activation, contributes and hashed members", async () => {
  const bytes = await vsixPackageFixture({
    includeSignature: true,
    extraBinaryMembers: {
      "extension/native/addon.node": ELF,
      "extension/mod.wasm": WASM,
      "extension/bin/helper.exe": MZ,
      "extension/tools/run.sh": SHELL,
      "extension/vendor/payload.zip": NESTED_ZIP,
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.vsix_identity).toEqual({
    id: "demo.hello",
    version: "1.2.3",
    publisher: "demo",
    target_platform: "win32-x64",
    display_name: "Hello Demo",
    description: "A tiny fixture extension.",
  });
  expect(report.package_identity).toEqual({
    name: "hello",
    publisher: "demo",
    version: "1.2.3",
  });
  expect(report.identity_disagreements).toEqual([]);
  expect(report.engine).toEqual({
    vsixmanifest: "^1.74.0",
    package_json: "^1.74.0",
    disagreement: false,
  });
  expect(report.target_platform).toBe("win32-x64");
  expect(report.entry_points).toEqual({
    main: { path: "extension/out/extension.js", present: true },
    browser: { path: "extension/out/web/extension.js", present: true },
  });
  expect(report.activation_events).toEqual([
    { event: "onCommand:demo.hello", eager: false },
    { event: "*", eager: true },
    { event: "onStartupFinished", eager: true },
  ]);
  expect(report.contributes.keys).toEqual(
    expect.arrayContaining([
      { name: "commands", count: 2 },
      { name: "configuration", count: 1 },
    ]),
  );
  expect(report.contributes.commands).toEqual([
    { command: "demo.hello", title: "Say Hello" },
    { command: "demo.world", title: "Say World" },
  ]);
  expect(report.extension_dependencies).toEqual({
    vsixmanifest: ["other.dep"],
    package_json: ["other.dep"],
    disagreement: false,
  });
  expect(report.extension_pack).toEqual({
    vsixmanifest: ["demo.pack-a"],
    package_json: ["demo.pack-a"],
    disagreement: false,
  });
  expect(report.extension_kind).toEqual(["workspace"]);
  expect(report.capabilities).toEqual({
    untrusted_workspaces: {
      supported: "true",
      description: "No workspace trust needed.",
    },
    virtual_workspaces: {
      supported: "limited",
      description: "Read-only on virtual FS.",
    },
  });
  expect(report.enabled_api_proposals).toEqual(["testObserver"]);
  expect(report.assets).toEqual([
    {
      type: "Microsoft.VisualStudio.Code.Manifest",
      path: "extension/package.json",
      present: true,
    },
    {
      type: "Microsoft.VisualStudio.Services.Content.Details",
      path: "extension/readme.md",
      present: true,
    },
  ]);
  expect(report.signatures).toEqual({ p7s: true, manifest: true });
  expect(report.interesting_members).toEqual(
    expect.arrayContaining([
      {
        path: "extension/native/addon.node",
        kind: "native_addon",
        bytes: ELF.length,
        sha256: digestOf(ELF),
        classification: "observed",
      },
      {
        path: "extension/mod.wasm",
        kind: "wasm",
        bytes: WASM.length,
        sha256: digestOf(WASM),
        classification: "observed",
      },
      {
        path: "extension/bin/helper.exe",
        kind: "executable",
        bytes: MZ.length,
        sha256: digestOf(MZ),
        classification: "observed",
      },
      {
        path: "extension/tools/run.sh",
        kind: "shell_script",
        bytes: SHELL.length,
        sha256: digestOf(SHELL),
        classification: "observed",
      },
      {
        path: "extension/vendor/payload.zip",
        kind: "nested_archive",
        bytes: NESTED_ZIP.length,
        sha256: digestOf(NESTED_ZIP),
        classification: "observed",
      },
    ]),
  );
  expect(report.member_kind_counts.javascript).toBeGreaterThan(0);
  expect(report.member_kind_counts.native_addon).toBe(1);
  expect(report.member_kind_counts.wasm).toBe(1);
  expect(report.coverage.status).toBe("complete");
  expect(report.limitations).toContain(VSIX_LIMITATIONS.noExecution);
  expect(report.limitations).toContain(VSIX_LIMITATIONS.signaturesUnverified);
  expect(report.limitations).not.toContain(VSIX_LIMITATIONS.noVsixmanifest);
});

it("records identity, engine and dependency disagreements", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: defaultPackageJson
      .replace('"version": "1.2.3"', '"version": "9.9.9"')
      .replace('"vscode": "^1.74.0"', '"vscode": "^1.80.0"')
      .replace('["other.dep"]', '["other.dep", "extra.dep"]'),
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.identity_disagreements).toEqual([
    { field: "version", vsixmanifest: "1.2.3", package_json: "9.9.9" },
  ]);
  expect(report.engine).toEqual({
    vsixmanifest: "^1.74.0",
    package_json: "^1.80.0",
    disagreement: true,
  });
  expect(report.extension_dependencies.disagreement).toBe(true);
});

it("caps contributed commands and keeps the omitted count", async () => {
  const commands = Array.from(
    { length: VSIX_COMMANDS_CAP + 3 },
    (_, index) => ({
      command: `demo.cmd${String(index)}`,
      title: `Command ${String(index)}`,
    }),
  );
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      contributes: { commands },
    }),
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.contributes.commands).toHaveLength(VSIX_COMMANDS_CAP);
  expect(report.contributes.commands_total).toBe(VSIX_COMMANDS_CAP + 3);
  expect(report.contributes.commands_omitted).toBe(3);
});

it("reports an empty contributes key as a limitation and keeps the report", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      contributes: { "": [], commands: [] },
    }),
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.contributes.keys).toEqual([{ name: "commands", count: 0 }]);
  expect(report.limitations).toContain(VSIX_LIMITATIONS.emptyContributesKey);
});

it("stops decoding members once the package-wide decode budget is spent", async () => {
  // Seventeen highly compressible 16 MiB members expand past the 256 MiB
  // package floor while each stays within its own member budget.
  const member = new Uint8Array(MAX_INSPECT_VSIX_PACKAGE_MEMBER_BYTES);
  const extraBinaryMembers = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `extension/dist/module-${String(index).padStart(2, "0")}.wasm`,
      member,
    ]),
  );
  const bytes = await vsixPackageFixture({
    extraBinaryMembers,
    compressBinaryMembers: true,
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), {
      ...defaults,
      max_member_bytes: MAX_INSPECT_VSIX_PACKAGE_MEMBER_BYTES,
    }),
  );
  const wasm = report.interesting_members.filter((entry) =>
    entry.path.endsWith(".wasm"),
  );
  expect(wasm).toHaveLength(17);
  expect(wasm.filter((entry) => entry.sha256 === null).length).toBeGreaterThan(
    0,
  );
  expect(
    report.limitations.some((limitation) =>
      limitation.includes("total decode budget was spent"),
    ),
  ).toBe(true);
}, 60_000);

it("inventories a package with no vsixmanifest and leaves vsix identity unknown", async () => {
  const bytes = await vsixPackageMissingManifestFixture();
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.vsix_identity).toBeNull();
  expect(report.vsixmanifest).toBeNull();
  expect(report.package_identity?.name).toBe("hello");
  expect(report.contents.some((entry) => entry.kind === "package_json")).toBe(
    true,
  );
  expect(report.limitations).toContain(VSIX_LIMITATIONS.noVsixmanifest);
});

it("inventories a package whose vsixmanifest is not well-formed XML", async () => {
  const bytes = await vsixPackageMalformedManifestFixture();
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.vsix_identity).toBeNull();
  expect(report.vsixmanifest?.path).toBe("extension.vsixmanifest");
  expect(report.package_identity?.name).toBe("hello");
  expect(report.limitations).toContain(VSIX_LIMITATIONS.malformedVsixmanifest);
});

it("inventories a package whose package.json is not well-formed JSON", async () => {
  const bytes = await vsixPackageMalformedPackageJsonFixture();
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.package_identity).toBeNull();
  expect(report.package_json?.path).toBe("extension/package.json");
  expect(report.vsix_identity?.id).toBe("demo.hello");
  expect(report.limitations).toContain(VSIX_LIMITATIONS.malformedPackageJson);
});

it("records a path-traversal member without extracting it", async () => {
  const bytes = await vsixPackageTraversalFixture();
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(
    report.contents.find((entry) => entry.name === "../outside.js"),
  ).toMatchObject({
    path: "../outside.js",
    traverses: true,
    kind: "javascript",
  });
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.traverses("../outside.js"),
  );
});

it("does not decode duplicate vsixmanifest members as identity", async () => {
  const bytes = await vsixPackageFixture({
    extraMembers: { "./extension.vsixmanifest": defaultVsixManifest },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.vsix_identity).toBeNull();
  expect(report.vsixmanifest).toBeNull();
  expect(report.duplicate_paths).toContain("extension.vsixmanifest");
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.duplicatePath("extension.vsixmanifest"),
  );
  expect(report.limitations).toContain(VSIX_LIMITATIONS.noVsixmanifest);
});

it("rejects a vsixmanifest document type without decoding identity", async () => {
  const bytes = await vsixPackageFixture({
    vsixmanifest: `<?xml version="1.0"?><!DOCTYPE PackageManifest><PackageManifest Version="2.0.0"><Metadata><Identity Id="demo.hello" Version="1.2.3" Publisher="demo" /></Metadata></PackageManifest>`,
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.vsix_identity).toBeNull();
  expect(report.limitations).toContain(
    "The selected extension.vsixmanifest declares a document type, which is unsupported.",
  );
});

it("refuses a non-ZIP file without claiming a package inventory", async () => {
  const bytes = Buffer.from("not a zip");
  await expect(
    parseVsixPackage(bytes, artifactOf(bytes), defaults),
  ).rejects.toBeInstanceOf(ParseFailureError);
});

it.each([
  new Error("controlled opaque decoder failure"),
  { failure: "opaque" },
])(
  "preserves an unclassified ZIP failure without claiming malformed bytes: %j",
  async (cause) => {
    const bytes = await vsixPackageFixture();
    const enumeration = vi
      .spyOn(ZipReader.prototype, "getEntriesGenerator")
      .mockImplementation(async function* () {
        throw cause;
      });
    try {
      await expect(
        parseVsixPackage(bytes, artifactOf(bytes), defaults),
      ).rejects.toBe(cause);
    } finally {
      enumeration.mockRestore();
    }
  },
);

it("stops ZIP enumeration as soon as the entry budget is exceeded", async () => {
  const bytes = await vsixPackageFixture({
    extraMembers: Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `extension/extra${String(index)}.txt`,
        "x",
      ]),
    ),
  });
  const original = ZipReader.prototype.getEntriesGenerator;
  let yielded = 0;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        yielded += 1;
        yield entry;
      }
      return true;
    });
  try {
    await expect(
      parseVsixPackage(bytes, artifactOf(bytes), {
        ...defaults,
        max_entries: 2,
      }),
    ).rejects.toMatchObject({
      constructor: ParseFailureError,
      failure: {
        kind: "limit",
        limit: { name: "max_entries", maximum: 2, required: 3 },
      },
    });
    expect(yielded).toBe(3);
  } finally {
    enumeration.mockRestore();
  }
});

it("refuses a vsixmanifest larger than the metadata budget before reading it", async () => {
  const bytes = await vsixPackageFixture();
  await expect(
    parseVsixPackage(bytes, artifactOf(bytes), {
      ...defaults,
      max_manifest_bytes: 64,
    }),
  ).rejects.toMatchObject({
    constructor: ParseFailureError,
    failure: {
      kind: "limit",
      limit: { name: "max_manifest_bytes", maximum: 64 },
    },
  });
});

it("refuses a vsixmanifest with more XML nodes than its tree allowance", async () => {
  const bytes = await vsixPackageFixture({
    vsixmanifest: `<PackageManifest>${"<x/>".repeat(MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES)}</PackageManifest>`,
  });
  await expect(
    parseVsixPackage(bytes, artifactOf(bytes), {
      ...defaults,
      max_manifest_bytes: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_BYTES,
    }),
  ).rejects.toMatchObject({
    constructor: ParseFailureError,
    failure: {
      kind: "limit",
      limit: {
        name: "xml_nodes",
        maximum: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES,
        required: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES + 1,
      },
    },
  });
});

it("reports the vsixmanifest node refusal as a fixed parser allowance", async () => {
  const root = await createTestTempDirectory("rea-vsix-xml-nodes-");
  const path = join(root, "demo.hello-1.2.3.vsix");
  await writeFile(
    path,
    await vsixPackageFixture({
      vsixmanifest: `<PackageManifest>${"<x/>".repeat(MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES)}</PackageManifest>`,
    }),
  );
  const provider = new VsixPackageProvider();
  try {
    const result = await provider.inspect(
      inspectVsixPackageInputSchema.parse({
        path,
        max_manifest_bytes: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_BYTES,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      retryable: false,
      fixedAllowance: {
        kind: "parser",
        limit: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES,
        unit: "nodes",
      },
    });
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      remediation: {
        action: expect.stringContaining(
          `${String(MAX_INSPECT_VSIX_PACKAGE_MANIFEST_XML_NODES)}-node allowance`,
        ),
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/more memory|Raise /);
  } finally {
    await provider.close();
  }
});

it("lists an oversize interesting member without a digest", async () => {
  const oversized = new Uint8Array(2048);
  oversized.set(WASM);
  const bytes = await vsixPackageFixture({
    extraBinaryMembers: { "extension/mod.wasm": oversized },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), {
      ...defaults,
      max_member_bytes: 16,
    }),
  );
  expect(report.interesting_members).toContainEqual({
    path: "extension/mod.wasm",
    kind: "wasm",
    bytes: oversized.length,
    sha256: null,
    classification: "inferred",
  });
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.memberOversize("extension/mod.wasm", 16),
  );
});

it("reports cancellation during a member read with the caller's reason", async () => {
  const bytes = await vsixPackageFixture();
  const controller = new AbortController();
  const reason = { source: "caller-request", operation: "cancel" };
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      yield* original.call(this, options);
      controller.abort(reason);
      return true;
    });
  try {
    const failure: unknown = await parseVsixPackage(
      bytes,
      artifactOf(bytes),
      defaults,
      controller.signal,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(failure).toMatchObject({ reason: "cancelled" });
    expect((failure as ArtifactReaderFailure).cancellation?.reason).toBe(
      reason,
    );
  } finally {
    enumeration.mockRestore();
  }
});

it("keeps a Zstandard dictionary refusal as an unsupported layout instead of a malformed package", async () => {
  const bytes = await vsixPackageFixture();
  const refusal = Object.assign(new Error("Dictionary mismatch"), {
    code: "ZSTD_error_dictionary_wrong",
  });
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        if (entry.filename === "extension.vsixmanifest" && !entry.directory) {
          entry.compressionMethod = 93;
          entry.getData = () => Promise.reject(refusal);
        }
        yield entry;
      }
      return true;
    });
  try {
    const failure: unknown = await parseVsixPackage(
      bytes,
      artifactOf(bytes),
      defaults,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ParseFailureError);
    expect(failure).toMatchObject({ failure: { kind: "unsupported" } });
    expect((failure as Error).message).toContain("Zstandard dictionary");
    expect(((failure as Error).cause as ArtifactReaderFailure).cause).toBe(
      refusal,
    );
  } finally {
    enumeration.mockRestore();
  }
});

it("keeps a Zstandard decoder window refusal as a memory limit instead of a malformed package", async () => {
  const bytes = await vsixPackageFixture();
  const refusal = Object.assign(new Error("Frame requires too much memory"), {
    code: "ZSTD_error_frameParameter_windowTooLarge",
  });
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        if (entry.filename === "extension.vsixmanifest" && !entry.directory) {
          entry.compressionMethod = 93;
          entry.getData = () => Promise.reject(refusal);
        }
        yield entry;
      }
      return true;
    });
  try {
    const failure: unknown = await parseVsixPackage(
      bytes,
      artifactOf(bytes),
      defaults,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(failure).toMatchObject({ reason: "limit", boundary: "memory" });
    expect((failure as ArtifactReaderFailure).cause).toBe(refusal);
  } finally {
    enumeration.mockRestore();
  }
});

it("resolves dot segments in entry points under extension/", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/./lib/../extension.js",
      browser: "../outside/web.js",
    }),
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out/extension.js",
    present: true,
  });
  expect(report.entry_points.browser).toEqual({
    path: "extension/../outside/web.js",
    present: false,
  });
});

it("resolves an extension-less CommonJS main the way Node does", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/extension",
      browser: "./out/web/extension",
    }),
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points).toEqual({
    main: { path: "extension/out/extension.js", present: true },
    browser: { path: "extension/out/web/extension.js", present: true },
  });
});

it("resolves a directory main through that directory's package.json", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    extraMembers: {
      "extension/out/package.json": JSON.stringify({ main: "./start.js" }),
      "extension/out/start.js": "exports.activate = () => {};",
      "extension/out/index.js": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out/start.js",
    present: true,
  });
});

it("falls back to the directory index when its package.json main is missing", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    extraMembers: {
      "extension/out/package.json": JSON.stringify({ main: "./gone.js" }),
      "extension/out/index.js": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out/index.js",
    present: true,
  });
});

it.each(["{not json", "[]", "null"])(
  "reports a malformed directory package.json instead of using its index (%s)",
  async (manifest) => {
    const bytes = await vsixPackageFixture({
      packageJson: JSON.stringify({
        name: "hello",
        publisher: "demo",
        version: "1.2.3",
        engines: { vscode: "^1.74.0" },
        main: "./out",
      }),
      extraMembers: {
        "extension/out/package.json": manifest,
        "extension/out/index.js": "exports.activate = () => {};",
      },
    });
    const report = vsixPackageSchema.parse(
      await parseVsixPackage(bytes, artifactOf(bytes), defaults),
    );
    expect(report.entry_points.main).toEqual({
      path: "extension/out",
      present: false,
    });
    expect(report.limitations).toContain(
      VSIX_LIMITATIONS.malformedMainDirectoryPackageJson(
        "extension/out/package.json",
      ),
    );
  },
);

it("marks a missing main entry as absent without treating it as a format error", async () => {
  const bytes = await vsixPackageFixture({ includeMain: false });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out/extension.js",
    present: false,
  });
  expect(report.entry_points.browser?.present).toBe(true);
});
