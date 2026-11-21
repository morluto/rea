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
  MAX_INSPECT_VSIX_PACKAGE_MANIFEST_JSON_VALUES,
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

const expansionBudget = vi.hoisted(() => ({
  override: undefined as number | undefined,
}));

vi.mock("../domain/artifactExpansionBudget.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../domain/artifactExpansionBudget.js")
    >();
  return {
    ...actual,
    artifactExpansionBudgetBytes: (archiveBytes: number): number =>
      expansionBudget.override ??
      actual.artifactExpansionBudgetBytes(archiveBytes),
  };
});

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

it("counts a single contributed command object as one command", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      contributes: { commands: { command: "demo.run", title: "Run" } },
    }),
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.contributes.commands).toEqual([
    { command: "demo.run", title: "Run" },
  ]);
  expect(report.contributes.commands_total).toBe(1);
  expect(report.contributes.commands_omitted).toBe(0);
  expect(report.contributes.keys).toEqual([{ name: "commands", count: 1 }]);
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

it(
  "stops decoding members once the package-wide decode budget is spent",
  { tags: ["long-running"] },
  async () => {
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
    expect(
      wasm.filter((entry) => entry.sha256 === null).length,
    ).toBeGreaterThan(0);
    expect(
      report.limitations.some((limitation) =>
        limitation.includes("total decode budget was spent"),
      ),
    ).toBe(true);
  },
);

it("charges members that inflate past an understated size to the package budget", async () => {
  // Each member declares one byte but its decoder keeps producing output, so
  // every read fails after decoding its full 16 KiB allowance. Three such
  // failures spend the 48 KiB package budget; later members must not get a
  // fresh allowance.
  const names = Array.from(
    { length: 6 },
    (_, index) => `extension/dist/module-${String(index)}.wasm`,
  );
  const bytes = await vsixPackageFixture({
    extraBinaryMembers: Object.fromEntries(names.map((name) => [name, WASM])),
  });
  const chunk = new Uint8Array(4 * 1024);
  let decoded = 0;
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        if (!entry.directory && names.includes(entry.filename)) {
          entry.uncompressedSize = 1;
          entry.getData = (async (writer: {
            init?: (size?: number) => Promise<void>;
            writeUint8Array: (array: Uint8Array) => Promise<void>;
          }) => {
            await writer.init?.();
            for (let index = 0; index < 16; index++) {
              await writer.writeUint8Array(chunk);
              decoded += chunk.length;
            }
            throw new Error("decoder overran its declared size");
          }) as unknown as typeof entry.getData;
        }
        yield entry;
      }
      return true;
    });
  const maximum = 48 * 1024;
  expansionBudget.override = maximum;
  try {
    const report = vsixPackageSchema.parse(
      await parseVsixPackage(bytes, artifactOf(bytes), {
        ...defaults,
        max_member_bytes: 16 * 1024,
      }),
    );
    expect(decoded).toBe(maximum);
    expect(
      report.interesting_members
        .filter((entry) => entry.path.endsWith(".wasm"))
        .every((entry) => entry.sha256 === null),
    ).toBe(true);
    for (const name of names.slice(0, 3))
      expect(report.limitations).toContain(
        VSIX_LIMITATIONS.memberOversize(name, 16 * 1024),
      );
    for (const name of names.slice(3))
      expect(report.limitations).toContain(
        VSIX_LIMITATIONS.packageExpansionSpent(name, maximum),
      );
  } finally {
    expansionBudget.override = undefined;
    enumeration.mockRestore();
  }
});

it("skips zero-declared members once the package budget is spent", async () => {
  // Each member declares zero bytes and inflates to its full 16 KiB
  // allowance. After three members spend the 48 KiB package budget, later
  // members must not start their decoders at all.
  const names = Array.from(
    { length: 6 },
    (_, index) => `extension/dist/module-${String(index)}.wasm`,
  );
  const bytes = await vsixPackageFixture({
    extraBinaryMembers: Object.fromEntries(names.map((name) => [name, WASM])),
  });
  const chunk = new Uint8Array(4 * 1024);
  let decoded = 0;
  const started: string[] = [];
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        if (!entry.directory && names.includes(entry.filename)) {
          const name = entry.filename;
          entry.uncompressedSize = 0;
          entry.getData = (async (writer: {
            init?: (size?: number) => Promise<void>;
            writeUint8Array: (array: Uint8Array) => Promise<void>;
          }) => {
            started.push(name);
            await writer.init?.();
            for (let index = 0; index < 16; index++) {
              await writer.writeUint8Array(chunk);
              decoded += chunk.length;
            }
            throw new Error("decoder overran its declared size");
          }) as unknown as typeof entry.getData;
        }
        yield entry;
      }
      return true;
    });
  const maximum = 48 * 1024;
  expansionBudget.override = maximum;
  try {
    const report = vsixPackageSchema.parse(
      await parseVsixPackage(bytes, artifactOf(bytes), {
        ...defaults,
        max_member_bytes: 16 * 1024,
      }),
    );
    expect(started).toEqual(names.slice(0, 3));
    expect(decoded).toBe(maximum);
    for (const name of names.slice(3))
      expect(report.limitations).toContain(
        VSIX_LIMITATIONS.packageExpansionSpent(name, maximum),
      );
  } finally {
    expansionBudget.override = undefined;
    enumeration.mockRestore();
  }
});

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
  expect(report.extension_dependencies).toEqual({
    vsixmanifest: null,
    package_json: ["other.dep"],
    disagreement: false,
  });
  expect(report.extension_pack.vsixmanifest).toBeNull();
  expect(report.extension_pack.disagreement).toBe(false);
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
  expect(report.extension_dependencies.vsixmanifest).toBeNull();
  expect(report.extension_dependencies.disagreement).toBe(false);
  expect(report.extension_pack.vsixmanifest).toBeNull();
  expect(report.extension_pack.disagreement).toBe(false);
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
  expect(report.extension_dependencies.package_json).toBeNull();
  expect(report.extension_dependencies.disagreement).toBe(false);
  expect(report.extension_pack.package_json).toBeNull();
  expect(report.extension_pack.disagreement).toBe(false);
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

/** A package.json whose unused `padding` array alone fills the value allowance. */
const manyValuesPackageJson = (main: string): string =>
  `{"name":"hello","publisher":"demo","version":"1.2.3","engines":{"vscode":"^1.74.0"},"main":${JSON.stringify(main)},"padding":[${"0,".repeat(MAX_INSPECT_VSIX_PACKAGE_MANIFEST_JSON_VALUES)}0]}`;

it("refuses a package.json with more JSON values than its parse allowance", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: manyValuesPackageJson("./out/extension.js"),
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
        name: "json_values",
        maximum: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_JSON_VALUES,
        required: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_JSON_VALUES + 1,
      },
    },
  });
});

it("reports the package.json value refusal as a fixed parser allowance", async () => {
  const root = await createTestTempDirectory("rea-vsix-json-values-");
  const path = join(root, "demo.hello-1.2.3.vsix");
  await writeFile(
    path,
    await vsixPackageFixture({
      packageJson: manyValuesPackageJson("./out/extension.js"),
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
        limit: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_JSON_VALUES,
        unit: "values",
      },
    });
    expect(JSON.stringify(projectAnalysisError(result.error))).not.toMatch(
      /more memory|Raise /,
    );
  } finally {
    await provider.close();
  }
});

it("does not parse or use index files when the directory package.json exceeds the value allowance", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    extraMembers: {
      "extension/out/package.json": manyValuesPackageJson("./start.js"),
      "extension/out/start.js": "exports.activate = () => {};",
      "extension/out/index.js": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), {
      ...defaults,
      max_manifest_bytes: MAX_INSPECT_VSIX_PACKAGE_MANIFEST_BYTES,
    }),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out",
    present: false,
  });
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.overgrownMainDirectoryPackageJson(
      "extension/out/package.json",
      MAX_INSPECT_VSIX_PACKAGE_MANIFEST_JSON_VALUES,
    ),
  );
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

it("keeps an oversize mode-executable member in the executable inventory", async () => {
  const helper = new Uint8Array(2048);
  const bytes = await vsixPackageFixture({
    extraBinaryMembers: { "extension/bin/server": helper },
    binaryMemberModes: { "extension/bin/server": 0o100755 },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), {
      ...defaults,
      max_member_bytes: 16,
    }),
  );
  expect(report.interesting_members).toContainEqual({
    path: "extension/bin/server",
    kind: "executable",
    bytes: helper.length,
    sha256: null,
    classification: "inferred",
  });
  expect(
    report.contents.find((member) => member.path === "extension/bin/server")
      ?.kind,
  ).toBe("executable");
  expect(report.member_kind_counts.executable).toBe(1);
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.memberOversize("extension/bin/server", 16),
  );
});

it("keeps a read mode-executable member with no known magic in the executable inventory", async () => {
  const helper = new Uint8Array(2048);
  const bytes = await vsixPackageFixture({
    extraBinaryMembers: { "extension/bin/server": helper },
    binaryMemberModes: { "extension/bin/server": 0o100755 },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), {
      ...defaults,
      max_member_bytes: 4096,
    }),
  );
  expect(report.interesting_members).toContainEqual({
    path: "extension/bin/server",
    kind: "executable",
    bytes: helper.length,
    sha256: createHash("sha256").update(helper).digest("hex"),
    classification: "inferred",
  });
  expect(
    report.contents.find((member) => member.path === "extension/bin/server")
      ?.kind,
  ).toBe("executable");
  expect(report.member_kind_counts.executable).toBe(1);
});

it("does not infer an executable from an unread symlink's mode", async () => {
  const target = new Uint8Array(2048);
  const bytes = await vsixPackageFixture({
    extraBinaryMembers: { "extension/bin/link": target },
    binaryMemberModes: { "extension/bin/link": 0o120777 },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), {
      ...defaults,
      max_member_bytes: 16,
    }),
  );
  expect(
    report.interesting_members.some(
      (member) => member.path === "extension/bin/link",
    ),
  ).toBe(false);
  expect(
    report.contents.find((member) => member.path === "extension/bin/link")
      ?.kind,
  ).toBe("unknown");
  expect(report.member_kind_counts.executable).toBe(0);
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

it("keeps activation events literal before classifying them as eager", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      activationEvents: ["* ", "onStartupFinished ", "*", "onStartupFinished"],
    }),
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.activation_events).toEqual([
    { event: "* ", eager: false },
    { event: "onStartupFinished ", eager: false },
    { event: "*", eager: true },
    { event: "onStartupFinished", eager: true },
  ]);
});

it("keeps contributed command identifiers literal next to their activation events", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      activationEvents: ["onCommand:demo.run "],
      contributes: {
        commands: [
          { command: "demo.run ", title: "Run" },
          { command: "", title: "Empty" },
        ],
      },
    }),
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.contributes.commands).toEqual([
    { command: "demo.run ", title: "Run" },
    { command: null, title: "Empty" },
  ]);
  expect(report.activation_events).toEqual([
    { event: "onCommand:demo.run ", eager: false },
  ]);
});

t("keeps declared API proposal names literal", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      enabledApiProposals: [
        "terminalDataWriteEvent ",
        "terminalDataWriteEvent",
        "a,b",
        "",
        "terminalDataWriteEvent",
      ],
    }),
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.enabled_api_proposals).toEqual([
    "terminalDataWriteEvent ",
    "terminalDataWriteEvent",
    "a,b",
  ]);
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

it("keeps an escaped entry point unresolved when a traversal member has its path", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "../outside.js",
      browser: "../outside",
    }),
    extraMembers: {
      "extension/../outside.js": "exports.x = 1;",
      "extension/../OUTSIDE": "exports.y = 1;",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(
    report.contents.find((entry) => entry.name === "extension/../outside.js"),
  ).toMatchObject({ path: "extension/../outside.js", traverses: true });
  expect(report.entry_points.main).toEqual({
    path: "extension/../outside.js",
    present: false,
  });
  expect(report.entry_points.browser).toEqual({
    path: "extension/../outside",
    present: false,
  });
  expect(report.limitations).not.toContain(
    VSIX_LIMITATIONS.entryPointCaseOnlyMatch(
      "extension/../outside",
      "extension/../OUTSIDE",
    ),
  );
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

it.each([
  ["/missing/start.js", "extension/out/index.js", true],
  ["/out/start.js", "extension/out/index.js", true],
])(
  "treats an absolute directory package.json main (%s) as outside the package",
  async (nestedMain, path, present) => {
    const bytes = await vsixPackageFixture({
      packageJson: JSON.stringify({
        name: "hello",
        publisher: "demo",
        version: "1.2.3",
        engines: { vscode: "^1.74.0" },
        main: "./out",
      }),
      extraMembers: {
        "extension/out/package.json": JSON.stringify({ main: nestedMain }),
        "extension/out/missing/start.js": "exports.activate = () => {};",
        "extension/out/out/start.js": "exports.activate = () => {};",
        "extension/out/index.js": "exports.activate = () => {};",
      },
    });
    const report = vsixPackageSchema.parse(
      await parseVsixPackage(bytes, artifactOf(bytes), defaults),
    );
    expect(report.entry_points.main).toEqual({ path, present });
  },
);

it.each([
  ["../../outside.js", "extension/out/index.js", true],
  ["../../extension/out/start.js", "extension/out/index.js", true],
])(
  "keeps a directory package.json main (%s) inside the extension root",
  async (nestedMain, path, present) => {
    const bytes = await vsixPackageFixture({
      packageJson: JSON.stringify({
        name: "hello",
        publisher: "demo",
        version: "1.2.3",
        engines: { vscode: "^1.74.0" },
        main: "./out",
      }),
      extraMembers: {
        "extension/out/package.json": JSON.stringify({ main: nestedMain }),
        "outside.js": "exports.activate = () => {};",
        "extension/out/start.js": "exports.activate = () => {};",
        "extension/out/index.js": "exports.activate = () => {};",
      },
    });
    const report = vsixPackageSchema.parse(
      await parseVsixPackage(bytes, artifactOf(bytes), defaults),
    );
    expect(report.entry_points.main).toEqual({ path, present });
  },
);

it("keeps a directory package.json main targeting the extension root from matching archive-root files", async () => {
  const withIndex = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    extraMembers: {
      "extension/out/package.json": JSON.stringify({ main: ".." }),
      "extension.js": "exports.activate = () => {};",
      "extension/index.js": "exports.activate = () => {};",
    },
  });
  const withIndexReport = vsixPackageSchema.parse(
    await parseVsixPackage(withIndex, artifactOf(withIndex), defaults),
  );
  expect(withIndexReport.entry_points.main).toEqual({
    path: "extension/index.js",
    present: true,
  });

  const withoutIndex = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    extraMembers: {
      "extension/out/package.json": JSON.stringify({ main: ".." }),
      "extension.js": "exports.activate = () => {};",
    },
  });
  const withoutIndexReport = vsixPackageSchema.parse(
    await parseVsixPackage(withoutIndex, artifactOf(withoutIndex), defaults),
  );
  expect(withoutIndexReport.entry_points.main).toEqual({
    path: "extension/out",
    present: false,
  });
});

it("reports an absolute directory package.json main absent without an index", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    extraMembers: {
      "extension/out/package.json": JSON.stringify({
        main: "/missing/start.js",
      }),
      "extension/out/missing/start.js": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out",
    present: false,
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

const utf16Manifest = (text: string, bigEndian: boolean): Uint8Array => {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]);
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    const high = unit >> 8;
    const low = unit & 0xff;
    bytes[2 + index * 2] = bigEndian ? high : low;
    bytes[3 + index * 2] = bigEndian ? low : high;
  }
  return bytes;
};

it.each([
  ["UTF-16LE", utf16Manifest('{"main":"./start.js"}', false)],
  ["UTF-16BE", utf16Manifest('{"main":"./start.js"}', true)],
  [
    "invalid UTF-8",
    Uint8Array.from([
      ...new TextEncoder().encode('{"main":"./start.js","x":"'),
      0xff,
      ...new TextEncoder().encode('"}'),
    ]),
  ],
])(
  "reports a %s directory package.json malformed as Node does",
  async (_encoding, manifest) => {
    const bytes = await vsixPackageFixture({
      packageJson: JSON.stringify({
        name: "hello",
        publisher: "demo",
        version: "1.2.3",
        engines: { vscode: "^1.74.0" },
        main: "./out",
      }),
      extraMembers: {
        "extension/out/start.js": "exports.activate = () => {};",
        "extension/out/index.js": "exports.activate = () => {};",
      },
      extraBinaryMembers: { "extension/out/package.json": manifest },
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

it("reads a UTF-8 BOM directory package.json main as Node does", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    extraMembers: {
      "extension/out/start.js": "exports.activate = () => {};",
    },
    extraBinaryMembers: {
      "extension/out/package.json": Uint8Array.from([
        0xef,
        0xbb,
        0xbf,
        ...new TextEncoder().encode('{"main":"./start.js"}'),
      ]),
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

it("does not use index files when the directory package.json is duplicated", async () => {
  const packageJson = JSON.stringify({
    name: "hello",
    publisher: "demo",
    version: "1.2.3",
    engines: { vscode: "^1.74.0" },
    main: "./out",
  });
  const directoryManifest = JSON.stringify({ main: "./start.js" });
  const bytes = await vsixPackageFixture({
    packageJson,
    extraMembers: {
      "extension/out/package.json": directoryManifest,
      "./extension/out/package.json": directoryManifest,
      "extension/out/start.js": "exports.activate = () => {};",
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
    VSIX_LIMITATIONS.unreadMainDirectoryPackageJson(
      "extension/out/package.json",
    ),
  );
});

it("does not use index files when the directory package.json exceeds the manifest budget", async () => {
  const packageJson = JSON.stringify({
    name: "hello",
    publisher: "demo",
    version: "1.2.3",
    engines: { vscode: "^1.74.0" },
    main: "./out",
  });
  const directoryManifest = JSON.stringify({
    main: "./start.js",
    padding: "x".repeat(packageJson.length + defaultVsixManifest.length),
  });
  const bytes = await vsixPackageFixture({
    packageJson,
    extraMembers: {
      "extension/out/package.json": directoryManifest,
      "extension/out/start.js": "exports.activate = () => {};",
      "extension/out/index.js": "exports.activate = () => {};",
      "extension/out/Index.json": "{}",
    },
  });
  const maxManifestBytes = directoryManifest.length - 1;
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), {
      ...defaults,
      max_manifest_bytes: maxManifestBytes,
    }),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out",
    present: false,
  });
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.oversizedMainDirectoryPackageJson(
      "extension/out/package.json",
      maxManifestBytes,
    ),
  );
  expect(
    report.limitations.filter((line) => line.startsWith("Entry point ")),
  ).toEqual([]);
});

it("treats a trailing-slash main as directory-only and skips a sibling file", async () => {
  const bytes = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/",
    }),
    extraMembers: {
      "extension/out.js": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out",
    present: false,
  });
});

it("resolves a trailing-slash main to the directory index over a sibling file", async () => {
  const bytes = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/",
    }),
    extraMembers: {
      "extension/out.js": "exports.activate = () => {};",
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

it("resolves a trailing-slash main through the directory package.json", async () => {
  const bytes = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/",
    }),
    extraMembers: {
      "extension/out.js": "exports.activate = () => {};",
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

it("looks up a main with trailing whitespace by its literal name", async () => {
  const bytes = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/start.js ",
    }),
    extraMembers: {
      "extension/out/start.js": "exports.activate = () => {};",
      "extension/out/start.js ": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out/start.js ",
    present: true,
  });
});

it("does not trim whitespace from a directory package.json main", async () => {
  const bytes = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/",
    }),
    extraMembers: {
      "extension/out/package.json": JSON.stringify({ main: " start.js" }),
      "extension/out/start.js": "exports.activate = () => {};",
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

it("keeps a main whose trailing separator is followed by whitespace a file path", async () => {
  const bytes = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/ ",
    }),
    extraMembers: {
      "extension/out/ .js": "exports.activate = () => {};",
      "extension/out/index.js": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out/ .js",
    present: true,
  });
});

it.each(["./out/.", "./out/sub/.."])(
  "keeps directory-only intent for main %s",
  async (main) => {
    const bytes = await vsixPackageFixture({
      includeMain: false,
      packageJson: JSON.stringify({
        name: "hello",
        publisher: "demo",
        version: "1.2.3",
        engines: { vscode: "^1.74.0" },
        main,
      }),
      extraMembers: {
        "extension/out.js": "exports.activate = () => {};",
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
  },
);

it.each([".", "./", "./out/.."])(
  "resolves main %s at the package root to its index file",
  async (main) => {
    const bytes = await vsixPackageFixture({
      includeMain: false,
      packageJson: JSON.stringify({
        name: "hello",
        publisher: "demo",
        version: "1.2.3",
        engines: { vscode: "^1.74.0" },
        main,
      }),
      extraMembers: {
        "extension/index.js": "exports.activate = () => {};",
      },
    });
    const report = vsixPackageSchema.parse(
      await parseVsixPackage(bytes, artifactOf(bytes), defaults),
    );
    expect(report.entry_points.main).toEqual({
      path: "extension/index.js",
      present: true,
    });
  },
);

it("matches entry points by exact member case, reporting a case-only match", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/Extension.js",
      browser: "./out/Web",
    }),
    extraMembers: { "extension/out/web.js": "exports.activate = () => {};" },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points).toEqual({
    main: { path: "extension/out/Extension.js", present: false },
    browser: { path: "extension/out/Web", present: false },
  });
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.entryPointCaseOnlyMatch(
      "extension/out/Extension.js",
      "extension/out/extension.js",
    ),
  );
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.entryPointCaseOnlyMatch(
      "extension/out/Web",
      "extension/out/web.js",
    ),
  );
});

it("does not blame case when a malformed directory package.json stops main", async () => {
  const bytes = await vsixPackageFixture({
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    includeMain: false,
    extraMembers: {
      "extension/out/package.json": "[",
      "extension/out/index.js": "exports.activate = () => {};",
      "extension/out/Index.json": "{}",
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
  expect(
    report.limitations.filter((line) => line.startsWith("Entry point ")),
  ).toEqual([]);
});

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

it("keeps backslashes literal in package.json entry points instead of matching slash-separated members", async () => {
  const bytes = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out\\start.js",
      browser: "./out\\web\\extension.js",
    }),
    extraMembers: {
      "extension/out/start.js": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points).toEqual({
    main: { path: "extension/out\\start.js", present: false },
    browser: { path: "extension/out\\web\\extension.js", present: false },
  });
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.entryPointBackslash("extension/out\\start.js"),
  );
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.entryPointBackslash("extension/out\\web\\extension.js"),
  );
});

it("does not treat a trailing backslash in main as a POSIX directory marker", async () => {
  const bytes = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out\\",
    }),
    extraMembers: {
      "extension/out.js": "exports.activate = () => {};",
      "extension/out/index.js": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(bytes, artifactOf(bytes), defaults),
  );
  expect(report.entry_points.main).toEqual({
    path: "extension/out\\",
    present: false,
  });
  expect(report.limitations).toContain(
    VSIX_LIMITATIONS.entryPointBackslash("extension/out\\"),
  );
});

it("keeps backslashes literal in a directory main's nested package.json", async () => {
  const bytes = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    extraMembers: {
      "extension/out/package.json": JSON.stringify({
        main: "./sub\\start.js",
      }),
      "extension/out/sub/start.js": "exports.activate = () => {};",
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
    VSIX_LIMITATIONS.entryPointBackslash("extension/out/sub\\start.js"),
  );
});

it("still resolves slash-separated and extensionless entry points, including backslash-named ZIP members", async () => {
  const slashAndExtensionless = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out/start",
      browser: "./out/web/extension.js",
    }),
    extraMembers: {
      "extension\\out\\start.js": "exports.activate = () => {};",
    },
  });
  const report = vsixPackageSchema.parse(
    await parseVsixPackage(
      slashAndExtensionless,
      artifactOf(slashAndExtensionless),
      defaults,
    ),
  );
  expect(report.entry_points).toEqual({
    main: { path: "extension/out/start.js", present: true },
    browser: { path: "extension/out/web/extension.js", present: true },
  });

  const nestedSlash = await vsixPackageFixture({
    includeMain: false,
    packageJson: JSON.stringify({
      name: "hello",
      publisher: "demo",
      version: "1.2.3",
      engines: { vscode: "^1.74.0" },
      main: "./out",
    }),
    extraMembers: {
      "extension/out/package.json": JSON.stringify({ main: "./sub/start" }),
      "extension/out/sub/start.js": "exports.activate = () => {};",
    },
  });
  const nestedReport = vsixPackageSchema.parse(
    await parseVsixPackage(nestedSlash, artifactOf(nestedSlash), defaults),
  );
  expect(nestedReport.entry_points.main).toEqual({
    path: "extension/out/sub/start.js",
    present: true,
  });
});
