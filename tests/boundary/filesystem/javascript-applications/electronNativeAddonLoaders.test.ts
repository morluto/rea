import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import { expect, it } from "vitest";

import { createElectronNativeAddonResolver } from "../../../../src/application/javascript/ElectronBoundaryNativeResolution.js";
import { JavaScriptJsonDocuments } from "../../../../src/application/javascript/JavaScriptJsonDocuments.js";
import { traceApplicationFeatureEvidence } from "../../../../src/application/javascript/JavaScriptApplicationWorkflowService.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { createEvidence } from "../../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { estimateJavaScriptStaticApplicationProjection } from "../../../../src/domain/javascript/javascriptApplicationProjectionResources.js";
import type { JavaScriptArtifactFile } from "../../../../src/domain/javascript/javascriptArtifactFiles.js";
import { analyzeJavaScriptStaticSource } from "../../../../src/domain/javascript/javascriptStaticAnalysis.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { writeFixtureFiles } from "../../../support/javascriptApplicationFixture.js";
import { analyzeJavaScriptApplication } from "../../../support/javascriptApplicationScope.js";

const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const createSimulatedNativeEvidence = (
  path: string,
  bytes: Uint8Array | string,
  operation = "inspect_native_exports",
) =>
  createEvidence(
    { path, sha256: sha256Hex(bytes), format: "mach-o" },
    { id: "rizin", name: "Rizin", version: "simulated" },
    {
      operation,
      parameters: {},
      result: { summary: "Simulated native binary inspection." },
      limitations: ["No native binary executed."],
    },
  );

const STANDARD_LOADER_BINARIES = {
  ngbArm64: "ngb-darwin-arm64-binary",
  ngbLinux: "ngb-linux-x64-binary",
  sqliteBin: "bindings-sqlite-binary",
  dlopenBin: "dlopen-bridge-binary",
  templateBin: "template-darwin-arm64-binary",
} as const;

const writeStandardLoadersFixture = async (root: string): Promise<void> => {
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({
      name: "desktop-shell",
      main: "src/main.cjs",
    }),
    "src/main.cjs": `
      const { ipcMain } = require("electron");
      const vault = require("../node_modules/vault-native/index.cjs");
      const store = require("../node_modules/store-native/lib/index.cjs");
      const bridge = require("./dlopen-bridge.cjs");
      const codec = require("./codec-loader.cjs");
      ipcMain.handle("desktop:sync", () => [vault, store, bridge, codec]);
    `,
    "node_modules/vault-native/package.json": JSON.stringify({
      name: "vault-native",
      main: "index.cjs",
    }),
    "node_modules/vault-native/index.cjs": `
      const load = require("node-gyp-build");
      const { openVault } = load(__dirname);
      module.exports = { openVault };
    `,
    "node_modules/vault-native/prebuilds/darwin-arm64/vault.node":
      STANDARD_LOADER_BINARIES.ngbArm64,
    "node_modules/vault-native/prebuilds/linux-x64/vault.node":
      STANDARD_LOADER_BINARIES.ngbLinux,
    "node_modules/vault-native/prebuilds/darwin-arm64/decoy.node.js":
      "module.exports = {};",
    "node_modules/vault-native/node_modules/nested/prebuilds/darwin-arm64/ignored.node":
      "nested-package-binary",
    "node_modules/store-native/package.json": JSON.stringify({
      name: "store-native",
      main: "lib/index.cjs",
    }),
    "node_modules/store-native/lib/index.cjs": `
      const bindings = require("bindings");
      module.exports = bindings("store").query;
    `,
    "node_modules/store-native/build/Release/store.node":
      STANDARD_LOADER_BINARIES.sqliteBin,
    "src/dlopen-bridge.cjs": `
      const path = require("node:path");
      process.dlopen(module, path.join(__dirname, "native", "bridge.node"));
    `,
    "src/native/bridge.node": STANDARD_LOADER_BINARIES.dlopenBin,
    "src/codec-loader.cjs": `
      const os = require("node:os");
      const { decodeFrame } = require(\`./codecs/\${os.platform()}/codec-\${process.arch}.node\`);
      module.exports = { decodeFrame };
    `,
    "src/codecs/darwin/codec-arm64.node": STANDARD_LOADER_BINARIES.templateBin,
    "src/codecs/darwin/codec-arm64.node.js": "module.exports = {};",
  });
};

it("projects node-gyp-build, bindings, process.dlopen, and platform/arch templates into native handoffs without matching .js decoys", async () => {
  const root = await createTestTempDirectory("rea-electron-native-loaders-");
  await writeStandardLoadersFixture(root);

  const analyzed = await analyzeJavaScriptApplication({ input_path: root });
  if (!analyzed.ok) throw analyzed.error;
  const result = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(result.summary).toMatchObject({
    native_addon_bindings: 4,
    resolved_native_addon_bindings: 4,
  });

  const nativeObservations = [
    createSimulatedNativeEvidence(
      join(root, "node_modules/vault-native/prebuilds/darwin-arm64/vault.node"),
      STANDARD_LOADER_BINARIES.ngbArm64,
    ),
    createSimulatedNativeEvidence(
      join(root, "node_modules/store-native/build/Release/store.node"),
      STANDARD_LOADER_BINARIES.sqliteBin,
    ),
    createSimulatedNativeEvidence(
      join(root, "src/native/bridge.node"),
      STANDARD_LOADER_BINARIES.dlopenBin,
    ),
    createSimulatedNativeEvidence(
      join(root, "src/codecs/darwin/codec-arm64.node"),
      STANDARD_LOADER_BINARIES.templateBin,
    ),
  ];

  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "src/main.cjs" },
    direction: "outgoing",
    native_observations: nativeObservations,
  });
  if (!traced.ok) throw traced.error;

  const byPath = new Map(
    traced.value.result.native_handoffs.map((handoff) => [
      handoff.artifact_path,
      handoff,
    ]),
  );
  expect([...byPath.keys()].sort()).toEqual([
    "node_modules/store-native/build/Release/store.node",
    "node_modules/vault-native/prebuilds/darwin-arm64/vault.node",
    "node_modules/vault-native/prebuilds/linux-x64/vault.node",
    "src/codecs/darwin/codec-arm64.node",
    "src/native/bridge.node",
  ]);
  expect(
    byPath.get("node_modules/vault-native/prebuilds/darwin-arm64/vault.node"),
  ).toMatchObject({
    status: "evidence-linked",
    artifact_sha256: sha256Hex(STANDARD_LOADER_BINARIES.ngbArm64),
    requested_exports: ["openVault"],
  });
  expect(
    byPath.get("node_modules/vault-native/prebuilds/linux-x64/vault.node"),
  ).toMatchObject({
    status: "requires-provider-analysis",
    artifact_sha256: sha256Hex(STANDARD_LOADER_BINARIES.ngbLinux),
    requested_exports: ["openVault"],
  });
  expect(
    byPath.get("node_modules/store-native/build/Release/store.node"),
  ).toMatchObject({
    status: "evidence-linked",
    artifact_sha256: sha256Hex(STANDARD_LOADER_BINARIES.sqliteBin),
    requested_exports: ["query"],
  });
  expect(byPath.get("src/codecs/darwin/codec-arm64.node")).toMatchObject({
    status: "evidence-linked",
    artifact_sha256: sha256Hex(STANDARD_LOADER_BINARIES.templateBin),
    requested_exports: ["decodeFrame"],
  });
});

it("links post-pack code-signed unpacked ASAR addons under record-and-continue while preserving untrusted contradiction metadata", async () => {
  const root = await createTestTempDirectory("rea-signed-unpacked-addons-");
  const source = join(root, "source");
  const archive = join(root, "app.asar");
  const unsignedBytes = Buffer.from("unsigned pre-pack macho addon bytes");
  const signedBytes = Buffer.from(
    "codesigned post-pack unpacked macho addon bytes",
  );
  const addonLogicalPath =
    "node_modules/key-vault/prebuilds/darwin-arm64/key-vault.node";

  await mkdir(join(source, "node_modules/key-vault/prebuilds/darwin-arm64"), {
    recursive: true,
  });
  await writeFixtureFiles(source, {
    "package.json": JSON.stringify({ name: "signed-app", main: "main.cjs" }),
    "main.cjs": `
      const { ipcMain } = require("electron");
      const vault = require("./node_modules/key-vault/index.cjs");
      ipcMain.handle("vault:unlock", () => vault.unlock());
    `,
    "node_modules/key-vault/package.json": JSON.stringify({
      name: "key-vault",
      main: "index.cjs",
    }),
    "node_modules/key-vault/index.cjs": `
      const load = require("node-gyp-build");
      const { unlock } = load(__dirname.replace("app.asar", "app.asar.unpacked"));
      module.exports = { unlock };
    `,
  });
  await writeFile(join(source, addonLogicalPath), unsignedBytes);
  await createPackageWithOptions(source, archive, { unpack: "*.node" });
  await writeFile(join(`${archive}.unpacked`, addonLogicalPath), signedBytes);

  const strictResult = await analyzeJavaScriptApplication({
    input_path: archive,
  });
  if (strictResult.ok) throw new Error("Expected strict integrity rejection");
  expect(projectAnalysisError(strictResult.error)).toMatchObject({
    code: "artifact_integrity_mismatch",
    details: { logical_path: addonLogicalPath, unpacked: true },
  });

  const continued = await analyzeJavaScriptApplication({
    input_path: archive,
    integrity_policy: "record-and-continue",
  });
  if (!continued.ok) throw continued.error;
  const analysis = javascriptApplicationAnalysisResultSchema.parse(
    continued.value.normalized_result,
  );
  expect(analysis.integrity_contradictions).toMatchObject([
    {
      logical_path: addonLogicalPath,
      declared_sha256: sha256Hex(unsignedBytes),
      observed_sha256: sha256Hex(signedBytes),
      trust: "observed-untrusted",
    },
  ]);
  expect(analysis.graph.coverage.status).toBe("partial");
  expect(analysis.summary).toMatchObject({
    native_addon_bindings: 1,
    resolved_native_addon_bindings: 1,
  });

  const signedEvidence = createSimulatedNativeEvidence(
    join(`${archive}.unpacked`, addonLogicalPath),
    signedBytes,
    "inspect_macho",
  );
  const traced = traceApplicationFeatureEvidence({
    application: continued.value,
    seed: { kind: "module", value: "main.cjs" },
    direction: "outgoing",
    native_observations: [signedEvidence],
  });
  if (!traced.ok) throw traced.error;
  expect(traced.value.result.coverage.status).toBe("partial");
  expect(traced.value.result.native_handoffs).toEqual([
    expect.objectContaining({
      artifact_path: addonLogicalPath,
      artifact_sha256: sha256Hex(signedBytes),
      requested_exports: ["unlock"],
      status: "evidence-linked",
      evidence_ids: [signedEvidence.evidence_id],
    }),
  ]);
});

it("selects app.asar.unpacked binaries for rewritten loads and preserves anchored directory and URL paths", async () => {
  const root = await createTestTempDirectory("rea-unpacked-and-url-addons-");
  const packedBytes = "packed-asar-addon-bytes";
  const unpackedBytes = "loose-unpacked-addon-bytes";
  const nestedBytes = "nested-native-addon-bytes";
  const spaceUrlBytes = "space-decoded-url-addon-bytes";

  await writeFixtureFiles(root, {
    "resources/app.asar/package.json": JSON.stringify({
      name: "packaged-dir-app",
      main: "src/main.cjs",
    }),
    "resources/app.asar/src/main.cjs": `
      const { ipcMain } = require("electron");
      const path = require("node:path");
      const vault = require("../node_modules/vault/index.cjs");
      const missing = require("../node_modules/packed-only/index.cjs");
      const nested = require(\`\${path.join(__dirname, "native")}/addon.node\`);
      const urlAddon = require("./url-loader.mjs");
      ipcMain.handle("app:boot", () => [vault, missing, nested, urlAddon]);
    `,
    "resources/app.asar/src/addon.node": "wrong-sibling-decoy-bytes",
    "resources/app.asar/src/native/addon.node": nestedBytes,
    "resources/app.asar/src/url-loader.mjs": `
      import { createRequire } from "node:module";
      import { fileURLToPath } from "node:url";
      const req = createRequire(import.meta.url);
      export const space = req(
        fileURLToPath(
          new URL(\`./native%20dir/\${process.platform}/space%20addon.node?v=1#hash\`, import.meta.url),
        ),
      );
    `,
    "resources/app.asar/src/native dir/darwin/space addon.node": spaceUrlBytes,
    "resources/app.asar/node_modules/vault/package.json": JSON.stringify({
      name: "vault",
      main: "index.cjs",
    }),
    "resources/app.asar/node_modules/vault/index.cjs": `
      const load = require("node-gyp-build");
      module.exports = load(__dirname.replace("app.asar", "app.asar.unpacked"));
    `,
    "resources/app.asar/node_modules/vault/prebuilds/darwin-arm64/vault.node":
      packedBytes,
    "resources/app.asar.unpacked/node_modules/vault/prebuilds/darwin-arm64/vault.node":
      unpackedBytes,
    "resources/app.asar/node_modules/packed-only/package.json": JSON.stringify({
      name: "packed-only",
      main: "index.cjs",
    }),
    "resources/app.asar/node_modules/packed-only/index.cjs": `
      const load = require("node-gyp-build");
      module.exports = load(__dirname.replace("app.asar", "app.asar.unpacked"));
    `,
    "resources/app.asar/node_modules/packed-only/prebuilds/darwin-arm64/only.node":
      "packed-only-should-not-match",
  });

  const analyzed = await analyzeJavaScriptApplication({ input_path: root });
  if (!analyzed.ok) throw analyzed.error;
  const result = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(result.summary).toMatchObject({
    native_addon_bindings: 4,
    resolved_native_addon_bindings: 3,
  });

  const unpackedPath =
    "resources/app.asar.unpacked/node_modules/vault/prebuilds/darwin-arm64/vault.node";
  const unpackedEvidence = createSimulatedNativeEvidence(
    join(root, unpackedPath),
    unpackedBytes,
  );
  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "resources/app.asar/src/main.cjs" },
    direction: "outgoing",
    native_observations: [unpackedEvidence],
  });
  if (!traced.ok) throw traced.error;

  const byPath = new Map(
    traced.value.result.native_handoffs.map((handoff) => [
      handoff.artifact_path,
      handoff,
    ]),
  );
  expect([...byPath.keys()].sort()).toEqual([
    "resources/app.asar.unpacked/node_modules/vault/prebuilds/darwin-arm64/vault.node",
    "resources/app.asar/src/native dir/darwin/space addon.node",
    "resources/app.asar/src/native/addon.node",
  ]);
  expect(byPath.get(unpackedPath)).toMatchObject({
    artifact_sha256: sha256Hex(unpackedBytes),
    status: "evidence-linked",
  });
  expect(byPath.get("resources/app.asar/src/native/addon.node")).toMatchObject({
    artifact_sha256: sha256Hex(nestedBytes),
  });
  expect(
    byPath.get("resources/app.asar/src/native dir/darwin/space addon.node"),
  ).toMatchObject({
    artifact_sha256: sha256Hex(spaceUrlBytes),
  });
});

it("indexes native addon inventory once across repeated helper resolutions", () => {
  const mkFile = (
    path: string,
    kind: JavaScriptArtifactFile["kind"],
    textValue?: string,
  ): JavaScriptArtifactFile => ({
    path,
    sha256: sha256Hex(path),
    container_sha256: "0".repeat(64),
    bytes: 16,
    inventory_artifact_id: "resolver-cache-fixture",
    kind,
    unpacked: false,
    text:
      textValue !== undefined
        ? { included: true, value: textValue }
        : { included: false, reason: "not-applicable" },
  });
  const baseFiles = new Map<string, JavaScriptArtifactFile>([
    [
      "pkg/package.json",
      mkFile("pkg/package.json", "package-json", '{"name":"pkg"}'),
    ],
    ["pkg/a.cjs", mkFile("pkg/a.cjs", "javascript", "")],
    ["pkg/b.cjs", mkFile("pkg/b.cjs", "javascript", "")],
    [
      "pkg/prebuilds/darwin-arm64/addon.node",
      mkFile("pkg/prebuilds/darwin-arm64/addon.node", "native-addon"),
    ],
    [
      "pkg/build/Release/extra.node",
      mkFile("pkg/build/Release/extra.node", "native-addon"),
    ],
  ]);
  let fullIterations = 0;
  const countedFiles: ReadonlyMap<string, JavaScriptArtifactFile> = {
    get size() {
      return baseFiles.size;
    },
    get: (key) => baseFiles.get(key),
    has: (key) => baseFiles.has(key),
    entries: () => baseFiles.entries(),
    keys: () => baseFiles.keys(),
    values: () => baseFiles.values(),
    forEach: (cb, thisArg) => baseFiles.forEach(cb, thisArg),
    [Symbol.iterator]() {
      fullIterations += 1;
      return baseFiles[Symbol.iterator]();
    },
  };
  const resolver = createElectronNativeAddonResolver({
    files: countedFiles,
    jsonDocuments: new JavaScriptJsonDocuments(),
  });
  const ngbFinding = {
    module_kind: "require" as const,
    binding_kind: "require" as const,
    specifier: "node-gyp-build:.",
    members: [],
    namespace_access: true,
    dynamic_member_access: false,
    module_key: null,
    location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
    resolution: { kind: "node-gyp-build" as const, directory: "." },
  };
  const bindingsFinding = {
    ...ngbFinding,
    specifier: "extra.node",
    resolution: {
      kind: "bindings" as const,
      addon_name: "extra.node",
      module_root: null,
    },
  };
  expect(resolver.resolve(baseFiles.get("pkg/a.cjs")!, ngbFinding)).toEqual([
    "pkg/build/Release/extra.node",
    "pkg/prebuilds/darwin-arm64/addon.node",
  ]);
  expect(resolver.resolve(baseFiles.get("pkg/b.cjs")!, ngbFinding)).toEqual([
    "pkg/build/Release/extra.node",
    "pkg/prebuilds/darwin-arm64/addon.node",
  ]);
  expect(
    resolver.resolve(baseFiles.get("pkg/a.cjs")!, bindingsFinding),
  ).toEqual(["pkg/build/Release/extra.node"]);
  expect(
    resolver.resolve(baseFiles.get("pkg/b.cjs")!, bindingsFinding),
  ).toEqual(["pkg/build/Release/extra.node"]);
  expect(fullIterations).toBe(1);
});

it("keeps bindings probe order and node-gyp-build platform tuples", () => {
  const mkFile = (
    path: string,
    kind: JavaScriptArtifactFile["kind"],
  ): JavaScriptArtifactFile => ({
    path,
    sha256: sha256Hex(path),
    container_sha256: "0".repeat(64),
    bytes: 16,
    inventory_artifact_id: "probe-order-fixture",
    kind,
    unpacked: false,
    text: { included: false, reason: "not-applicable" },
  });
  const files = new Map<string, JavaScriptArtifactFile>([
    ["pkg/package.json", mkFile("pkg/package.json", "package-json")],
    ["pkg/index.cjs", mkFile("pkg/index.cjs", "javascript")],
    [
      "pkg/build/addon.node.js",
      mkFile("pkg/build/addon.node.js", "javascript"),
    ],
    [
      "pkg/build/Release/addon.node",
      mkFile("pkg/build/Release/addon.node", "native-addon"),
    ],
    [
      "pkg/prebuilds/linux-x64/addon.node",
      mkFile("pkg/prebuilds/linux-x64/addon.node", "native-addon"),
    ],
    [
      "pkg/prebuilds/backup/addon.node",
      mkFile("pkg/prebuilds/backup/addon.node", "native-addon"),
    ],
  ]);
  const resolver = createElectronNativeAddonResolver({
    files,
    jsonDocuments: new JavaScriptJsonDocuments(),
  });
  const source = files.get("pkg/index.cjs")!;
  const base = {
    module_kind: "require" as const,
    binding_kind: "require" as const,
    specifier: "addon.node",
    members: [],
    namespace_access: true,
    dynamic_member_access: false,
    module_key: null,
    location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
  };
  expect(
    resolver.resolve(source, {
      ...base,
      resolution: {
        kind: "bindings",
        addon_name: "addon.node",
        module_root: null,
      },
    }),
  ).toEqual([]);
  expect(
    resolver.resolve(source, {
      ...base,
      specifier: "node-gyp-build:.",
      resolution: { kind: "node-gyp-build", directory: "." },
    }),
  ).toEqual([
    "pkg/build/Release/addon.node",
    "pkg/prebuilds/linux-x64/addon.node",
  ]);
});

it("resolves dlopen require.resolve search paths without linking sibling addon.node", async () => {
  const root = await createTestTempDirectory("rea-dlopen-resolve-paths-");
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({ name: "dlopen-paths", main: "main.cjs" }),
    "addon.node": "SIBLING_WRONG_BINARY",
    "native/addon.node": "SELECTED_NATIVE_BINARY",
    "main.cjs": [
      'const { ipcMain } = require("electron");',
      'const path = require("node:path");',
      "const selectedMod = { exports: {} };",
      'process.dlopen(selectedMod, require.resolve("./addon.node", { paths: [path.join(__dirname, "native")] }));',
      "const unknownMod = { exports: {} };",
      'process.dlopen(unknownMod, require.resolve("./addon.node", { paths: [globalThis.dynamicDir] }));',
      'ipcMain.handle("native:run", () => selectedMod.exports.exec());',
    ].join("\n"),
  });

  const analyzed = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const parsed = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(parsed.summary).toMatchObject({
    native_addon_bindings: 1,
    resolved_native_addon_bindings: 1,
  });

  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "main.cjs" },
    direction: "outgoing",
    native_observations: [
      createSimulatedNativeEvidence(
        join(root, "addon.node"),
        "SIBLING_WRONG_BINARY",
      ),
      createSimulatedNativeEvidence(
        join(root, "native/addon.node"),
        "SELECTED_NATIVE_BINARY",
      ),
    ],
  });
  if (!traced.ok) throw traced.error;
  expect(traced.value.result.native_handoffs).toMatchObject([
    {
      artifact_path: "native/addon.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex("SELECTED_NATIVE_BINARY"),
    },
  ]);
});

it("traces sibling unpacked require, outside-wrapper rewritten directories, nested ASAR anchored require, and dlopen uppercase .NODE while skipping require uppercase decoys", async () => {
  const root = await createTestTempDirectory("rea-nested-asar-native-fixes-");
  const asarSource = join(root, "asar-src");
  const appRoot = join(root, "app");
  const nestedAsar = join(appRoot, "resources/app.asar");
  const unpackedOnlyBytes = "unpacked-sibling-direct-require-bytes";
  const packedNgbBytes = "packed-ngb-addon-bytes";
  const looseNgbBytes = "loose-rewritten-ngb-addon-bytes";
  const replaceAllNgbBytes = "loose-replace-all-ngb-addon-bytes";
  const duplicatedSubtreeDecoyBytes = "duplicated-replace-all-subtree-decoy";
  const nestedInsideBytes = "nested-asar-anchored-require-bytes";
  const dlopenUpperBytes = "dlopen-uppercase-native-addon-bytes";
  const decoyUpperBytes = "uppercase-node-decoy-bytes";

  await writeFixtureFiles(asarSource, {
    "package.json": JSON.stringify({
      name: "inner-asar",
      main: "pkg/index.cjs",
    }),
    "pkg/index.cjs": `
      const { run } = require("./unpacked-only.node");
      module.exports = { run };
    `,
    "ngb-pkg/package.json": JSON.stringify({
      name: "ngb-pkg",
      main: "index.cjs",
    }),
    "ngb-pkg/prebuilds/darwin-arm64/ngb.node": packedNgbBytes,
    "inside.node": nestedInsideBytes,
  });
  await mkdir(join(appRoot, "resources"), { recursive: true });
  await createPackageWithOptions(asarSource, nestedAsar, {});

  await writeFixtureFiles(appRoot, {
    "package.json": JSON.stringify({
      name: "outer-wrapper",
      main: "launcher.cjs",
    }),
    "launcher.cjs": [
      'const { ipcMain } = require("electron");',
      'const path = require("node:path");',
      'const load = require("node-gyp-build");',
      'const inner = require("./resources/app.asar/pkg/index.cjs");',
      'const rewritten = load(path.join(__dirname, "resources", "app.asar", "ngb-pkg").replace("app.asar", "app.asar.unpacked"));',
      'const rewrittenAll = load(path.join(__dirname, "resources", "app.asar", "replace-all-pkg").replaceAll("app.asar", "app.asar.unpacked"));',
      'const anchored = require(path.join(__dirname, "resources", "app.asar", "inside.node"));',
      'const upperDecoy = require(path.join(__dirname, "decoy-dir", "decoy.NODE"));',
      "const dlopenUpper = { exports: {} };",
      'process.dlopen(dlopenUpper, path.join(__dirname, "dlopen-upper", "Addon.NODE"));',
      'ipcMain.handle("wrapper:boot", () => [inner, rewritten, rewrittenAll, anchored, upperDecoy, dlopenUpper.exports]);',
    ].join("\n"),
    "decoy-dir/decoy.NODE": "module.exports = { notNative: true };",
    "dlopen-upper/Addon.NODE": dlopenUpperBytes,
    "resources/app.asar.unpacked/pkg/unpacked-only.node": unpackedOnlyBytes,
    "resources/app.asar.unpacked/ngb-pkg/prebuilds/darwin-arm64/ngb.node":
      looseNgbBytes,
    "resources/app.asar.unpacked/ngb-pkg/prebuilds/linux-x64/decoy.NODE":
      decoyUpperBytes,
    "resources/app.asar.unpacked/replace-all-pkg/prebuilds/darwin-arm64/real-all.node":
      replaceAllNgbBytes,
    "resources/app.asar.unpacked/replace-all-pkg/resources/app.asar/replace-all-pkg/prebuilds/darwin-arm64/dup.node":
      duplicatedSubtreeDecoyBytes,
  });

  const analyzed = await analyzeJavaScriptApplication({
    input_path: appRoot,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const result = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(result.summary).toMatchObject({
    resolved_native_addon_bindings: 5,
  });

  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "launcher.cjs" },
    direction: "outgoing",
    native_observations: [
      createSimulatedNativeEvidence(
        join(appRoot, "resources/app.asar.unpacked/pkg/unpacked-only.node"),
        unpackedOnlyBytes,
      ),
      createSimulatedNativeEvidence(
        join(
          appRoot,
          "resources/app.asar.unpacked/ngb-pkg/prebuilds/darwin-arm64/ngb.node",
        ),
        looseNgbBytes,
      ),
      createSimulatedNativeEvidence(
        join(
          appRoot,
          "resources/app.asar.unpacked/replace-all-pkg/prebuilds/darwin-arm64/real-all.node",
        ),
        replaceAllNgbBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "resources/app.asar/inside.node"),
        nestedInsideBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "dlopen-upper/Addon.NODE"),
        dlopenUpperBytes,
      ),
    ],
  });
  if (!traced.ok) throw traced.error;

  const byPath = new Map(
    traced.value.result.native_handoffs.map((handoff) => [
      handoff.artifact_path,
      handoff,
    ]),
  );
  expect([...byPath.keys()].sort()).toEqual([
    "dlopen-upper/Addon.NODE",
    "resources/app.asar.unpacked/ngb-pkg/prebuilds/darwin-arm64/ngb.node",
    "resources/app.asar.unpacked/pkg/unpacked-only.node",
    "resources/app.asar.unpacked/replace-all-pkg/prebuilds/darwin-arm64/real-all.node",
    "resources/app.asar/inside.node",
  ]);
  expect(
    byPath.get(
      "resources/app.asar.unpacked/ngb-pkg/prebuilds/darwin-arm64/ngb.node",
    ),
  ).toMatchObject({
    artifact_sha256: sha256Hex(looseNgbBytes),
    status: "evidence-linked",
  });
  expect(
    byPath.get(
      "resources/app.asar.unpacked/replace-all-pkg/prebuilds/darwin-arm64/real-all.node",
    ),
  ).toMatchObject({
    artifact_sha256: sha256Hex(replaceAllNgbBytes),
    status: "evidence-linked",
  });
  expect(byPath.get("dlopen-upper/Addon.NODE")).toMatchObject({
    artifact_sha256: sha256Hex(dlopenUpperBytes),
    status: "evidence-linked",
  });
  expect(
    byPath.get("resources/app.asar.unpacked/pkg/unpacked-only.node"),
  ).toMatchObject({
    artifact_sha256: sha256Hex(unpackedOnlyBytes),
    status: "evidence-linked",
  });
  expect(byPath.get("resources/app.asar/inside.node")).toMatchObject({
    artifact_sha256: sha256Hex(nestedInsideBytes),
    status: "evidence-linked",
  });
});

it("stops unpacked fallback when packed app.asar resolves a non-native module while preserving fallback for genuine misses", async () => {
  const root = await createTestTempDirectory(
    "rea-asar-non-native-stops-unpacked-fallback-",
  );
  const asarSource = join(root, "asar-src");
  const appRoot = join(root, "app");
  const nestedAsar = join(appRoot, "resources/app.asar");
  const decoyUnpackedBytes = "loose-unpacked-decoy-never-loaded-by-node";
  const decoyAnchoredBytes =
    "loose-unpacked-anchored-decoy-shadowed-by-packed-js";
  const decoyDarwinUnpackedBytes =
    "loose-unpacked-darwin-decoy-shadowed-by-packed-js";
  const genuineLinuxUnpackedBytes =
    "loose-unpacked-genuine-miss-linux-addon-bytes";
  const directDlopenUnpackedBytes =
    "loose-unpacked-direct-dlopen-exact-file-bytes";

  await writeFixtureFiles(asarSource, {
    "package.json": JSON.stringify({
      name: "inner-asar",
      main: "index.cjs",
    }),
    "index.cjs": [
      'const path = require("node:path");',
      'const { ipcMain } = require("electron");',
      'const packedJs = require("./addon.node");',
      'const anchoredJs = require(path.join(__dirname, "anchored.node"));',
      "const dlopenResolvedHolder = { exports: {} };",
      'process.dlopen(dlopenResolvedHolder, require.resolve(path.join(__dirname, "anchored.node")));',
      "const dlopenDirectHolder = { exports: {} };",
      'process.dlopen(dlopenDirectHolder, path.join(__dirname, "direct.node"));',
      "const platformAddon = require(`./plat-${process.platform}.node`);",
      'ipcMain.handle("asar:check", () => [packedJs, anchoredJs, dlopenResolvedHolder.exports, dlopenDirectHolder.exports, platformAddon]);',
    ].join("\n"),
    "addon.node.js": "module.exports = { mockedInJs: true };",
    "anchored.node.js": "module.exports = { anchoredJsShim: true };",
    "direct.node.js": "module.exports = { ignoredByDirectDlopen: true };",
    "plat-darwin.node.js": "module.exports = { darwinJsShim: true };",
  });
  await mkdir(join(appRoot, "resources"), { recursive: true });
  await createPackageWithOptions(asarSource, nestedAsar, {});

  await writeFixtureFiles(appRoot, {
    "package.json": JSON.stringify({
      name: "outer-app",
      main: "main.cjs",
    }),
    "main.cjs": 'require("./resources/app.asar/index.cjs");\n',
    "resources/app.asar.unpacked/addon.node": decoyUnpackedBytes,
    "resources/app.asar.unpacked/anchored.node": decoyAnchoredBytes,
    "resources/app.asar.unpacked/direct.node": directDlopenUnpackedBytes,
    "resources/app.asar.unpacked/plat-darwin.node": decoyDarwinUnpackedBytes,
    "resources/app.asar.unpacked/plat-linux.node": genuineLinuxUnpackedBytes,
  });

  const analyzed = await analyzeJavaScriptApplication({
    input_path: appRoot,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const parsed = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(parsed.summary).toMatchObject({
    native_addon_bindings: 5,
    resolved_native_addon_bindings: 2,
  });

  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "main.cjs" },
    direction: "outgoing",
    native_observations: [
      createSimulatedNativeEvidence(
        join(appRoot, "resources/app.asar.unpacked/addon.node"),
        decoyUnpackedBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "resources/app.asar.unpacked/anchored.node"),
        decoyAnchoredBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "resources/app.asar.unpacked/direct.node"),
        directDlopenUnpackedBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "resources/app.asar.unpacked/plat-darwin.node"),
        decoyDarwinUnpackedBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "resources/app.asar.unpacked/plat-linux.node"),
        genuineLinuxUnpackedBytes,
      ),
    ],
  });
  if (!traced.ok) throw traced.error;
  expect(
    [...traced.value.result.native_handoffs].sort((left, right) =>
      (left.artifact_path ?? "").localeCompare(right.artifact_path ?? ""),
    ),
  ).toMatchObject([
    {
      artifact_path: "resources/app.asar.unpacked/direct.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex(directDlopenUnpackedBytes),
    },
    {
      artifact_path: "resources/app.asar.unpacked/plat-linux.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex(genuineLinuxUnpackedBytes),
    },
  ]);
});

it("resolves native handoffs across sequence-wrapped callables and named node:process dlopen imports", async () => {
  const appRoot = await createTestTempDirectory(
    "rea-native-normalized-callables-",
  );
  const directBytes = "direct-seq-addon";
  const gypBytes = "gyp-seq-addon";
  const dlopenBytes = "named-dlopen-addon";

  await writeFixtureFiles(appRoot, {
    "package.json": JSON.stringify({
      name: "normalized-callables-app",
      main: "main.cjs",
    }),
    "main.cjs": `
      const { ipcMain } = require("electron");
      const { open } = (0, require)("./direct.node");
      const load = require("node-gyp-build");
      const { initGyp } = (0, load)(__dirname);
      import("./esm-dlopen.mjs");
      ipcMain.handle("native:test", () => [open, initGyp]);
    `,
    "esm-dlopen.mjs": `
      import path from "node:path";
      import { dlopen } from "node:process";
      const mod = { exports: {} };
      dlopen(mod, path.join(import.meta.dirname, "dlopened.node"));
      export default mod.exports;
    `,
    "direct.node": directBytes,
    "build/Release/addon.node": gypBytes,
    "dlopened.node": dlopenBytes,
  });

  const analyzed = await analyzeJavaScriptApplication({
    input_path: appRoot,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const parsed = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(parsed.summary).toMatchObject({
    native_addon_bindings: 3,
    resolved_native_addon_bindings: 3,
  });

  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "main.cjs" },
    direction: "outgoing",
    native_observations: [
      createSimulatedNativeEvidence(join(appRoot, "direct.node"), directBytes),
      createSimulatedNativeEvidence(
        join(appRoot, "build/Release/addon.node"),
        gypBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "dlopened.node"),
        dlopenBytes,
      ),
    ],
  });
  if (!traced.ok) throw traced.error;
  expect(
    [...traced.value.result.native_handoffs].sort((left, right) =>
      (left.artifact_path ?? "").localeCompare(right.artifact_path ?? ""),
    ),
  ).toMatchObject([
    {
      artifact_path: "build/Release/addon.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex(gypBytes),
      requested_exports: ["initGyp"],
    },
    {
      artifact_path: "direct.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex(directBytes),
      requested_exports: ["open"],
    },
    {
      artifact_path: "dlopened.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex(dlopenBytes),
    },
  ]);
});

it("restricts default bindings() search to standard tries without matching package-root or 2-segment lib/binding files", async () => {
  const appRoot = await createTestTempDirectory("rea-bindings-default-tries-");
  const rootDecoyBytes = "package-root-decoy-addon";
  const twoSegDecoyBytes = "two-segment-lib-binding-decoy";
  const validAbiBytes = "three-segment-node-pre-gyp-addon";

  await writeFixtureFiles(appRoot, {
    "package.json": JSON.stringify({
      name: "bindings-tries-app",
      main: "main.cjs",
    }),
    "main.cjs": `
      const { ipcMain } = require("electron");
      const decoyOnly = require("./node_modules/decoy-pkg/index.cjs");
      const validPreGyp = require("./node_modules/pregyp-pkg/index.cjs");
      ipcMain.handle("bindings:test", () => [decoyOnly, validPreGyp]);
    `,
    "node_modules/decoy-pkg/package.json": JSON.stringify({
      name: "decoy-pkg",
      main: "index.cjs",
    }),
    "node_modules/decoy-pkg/index.cjs": `
      const bindings = require("bindings");
      module.exports = bindings("addon");
    `,
    "node_modules/decoy-pkg/addon.node": rootDecoyBytes,
    "node_modules/decoy-pkg/lib/binding/addon.node": twoSegDecoyBytes,
    "node_modules/pregyp-pkg/package.json": JSON.stringify({
      name: "pregyp-pkg",
      main: "index.cjs",
    }),
    "node_modules/pregyp-pkg/index.cjs": `
      const bindings = require("bindings");
      module.exports = bindings("addon").open;
    `,
    "node_modules/pregyp-pkg/addon.node": rootDecoyBytes,
    "node_modules/pregyp-pkg/lib/binding/addon.node": twoSegDecoyBytes,
    "node_modules/pregyp-pkg/lib/binding/node-v127-darwin-arm64/addon.node":
      validAbiBytes,
  });

  const analyzed = await analyzeJavaScriptApplication({
    input_path: appRoot,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const parsed = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(parsed.summary).toMatchObject({
    native_addon_bindings: 2,
    resolved_native_addon_bindings: 1,
  });

  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "main.cjs" },
    direction: "outgoing",
    native_observations: [
      createSimulatedNativeEvidence(
        join(appRoot, "node_modules/decoy-pkg/addon.node"),
        rootDecoyBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "node_modules/decoy-pkg/lib/binding/addon.node"),
        twoSegDecoyBytes,
      ),
      createSimulatedNativeEvidence(
        join(
          appRoot,
          "node_modules/pregyp-pkg/lib/binding/node-v127-darwin-arm64/addon.node",
        ),
        validAbiBytes,
      ),
    ],
  });
  if (!traced.ok) throw traced.error;
  expect(traced.value.result.native_handoffs).toEqual([
    expect.objectContaining({
      artifact_path:
        "node_modules/pregyp-pkg/lib/binding/node-v127-darwin-arm64/addon.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex(validAbiBytes),
      requested_exports: ["open"],
    }),
  ]);
});

it("does not select sibling .node files for trailing-separator directory requests in path.join or rewritten app.asar.unpacked paths", async () => {
  const appRoot = await createTestTempDirectory(
    "rea-trailing-slash-native-dir-request-",
  );
  const packedSiblingBytes = "packed-sibling-file-not-directory";
  const unpackedSiblingBytes = "unpacked-sibling-file-not-directory";

  await writeFixtureFiles(appRoot, {
    "resources/app.asar/package.json": JSON.stringify({
      name: "trailing-slash-app",
      main: "main.cjs",
    }),
    "resources/app.asar/main.cjs": `
      const { ipcMain } = require("electron");
      const path = require("node:path");
      const directDirReq = require(path.join(__dirname, "addon.node/"));
      const unpackedDirReq = require(
        path.join(__dirname.replace("app.asar", "app.asar.unpacked"), "addon.node/"),
      );
      ipcMain.handle("native:dir", () => [directDirReq, unpackedDirReq]);
    `,
    "resources/app.asar/addon.node": packedSiblingBytes,
    "resources/app.asar.unpacked/addon.node": unpackedSiblingBytes,
  });

  const analyzed = await analyzeJavaScriptApplication({
    input_path: appRoot,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const parsed = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(parsed.summary).toMatchObject({
    native_addon_bindings: 0,
    resolved_native_addon_bindings: 0,
  });

  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "resources/app.asar/main.cjs" },
    direction: "outgoing",
    native_observations: [
      createSimulatedNativeEvidence(
        join(appRoot, "resources/app.asar/addon.node"),
        packedSiblingBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "resources/app.asar.unpacked/addon.node"),
        unpackedSiblingBytes,
      ),
    ],
  });
  if (!traced.ok) throw traced.error;
  expect(traced.value.result.native_handoffs).toEqual([]);

  const mkEntry = (path: string): JavaScriptArtifactFile => ({
    path,
    sha256: sha256Hex(path),
    container_sha256: "0".repeat(64),
    bytes: 16,
    inventory_artifact_id: "dir-req-fixture",
    kind: path.endsWith(".node") ? "native-addon" : "javascript",
    unpacked: path.includes("app.asar.unpacked"),
    text: { included: false, reason: "not-applicable" },
  });
  const sourceFile = mkEntry("resources/app.asar/main.cjs");
  const resolver = createElectronNativeAddonResolver({
    files: new Map([
      [sourceFile.path, sourceFile],
      [
        "resources/app.asar/addon.node",
        mkEntry("resources/app.asar/addon.node"),
      ],
      [
        "resources/app.asar.unpacked/addon.node",
        mkEntry("resources/app.asar.unpacked/addon.node"),
      ],
    ]),
    jsonDocuments: new JavaScriptJsonDocuments(),
  });
  const baseFinding = {
    module_kind: "require" as const,
    binding_kind: "require" as const,
    specifier: "addon.node/",
    members: [],
    namespace_access: true,
    dynamic_member_access: false,
    module_key: null,
    location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
  };
  expect(
    resolver.resolve(sourceFile, {
      ...baseFinding,
      resolution: {
        kind: "candidates",
        lookup: "commonjs",
        resolution_context: "filesystem-expression",
        candidates: ["addon.node/"],
      },
    }),
  ).toEqual([]);
  expect(
    resolver.resolve(sourceFile, {
      ...baseFinding,
      resolution: {
        kind: "candidates",
        lookup: "commonjs",
        resolution_context: "filesystem-expression",
        candidates: ["addon.node/"],
        asar_unpacked: true,
        asar_unpacked_scope: { directory: "." },
      },
    }),
  ).toEqual([]);
});

it("follows bindings.getRoot package.json and node_modules markers across markerless node_modules folders", async () => {
  const appRoot = await createTestTempDirectory("rea-bindings-root-markers-");
  const pkgDecoyBytes = "markerless-pkg-decoy-addon-bytes";
  const rootAddonBytes = "application-root-loaded-addon-bytes";
  const nmMarkerBytes = "empty-node-modules-marker-addon-bytes";

  await writeFixtureFiles(appRoot, {
    "package.json": JSON.stringify({
      name: "bindings-markers-app",
      main: "main.cjs",
    }),
    "main.cjs": `
      const { ipcMain } = require("electron");
      const markerless = require("./node_modules/pkg/index.cjs");
      const withNmChild = require("./node_modules/nm-marker-pkg/index.cjs");
      ipcMain.handle("bindings:markers", () => [markerless, withNmChild]);
    `,
    "node_modules/pkg/index.cjs": `
      const bindings = require("bindings");
      module.exports = bindings("addon").run;
    `,
    "node_modules/pkg/build/Release/addon.node": pkgDecoyBytes,
    "build/Release/addon.node": rootAddonBytes,
    "node_modules/nm-marker-pkg/index.cjs": `
      const bindings = require("bindings");
      module.exports = bindings("child_marked").exec;
    `,
    "node_modules/nm-marker-pkg/build/Release/child_marked.node": nmMarkerBytes,
  });
  await mkdir(join(appRoot, "node_modules/nm-marker-pkg/node_modules"), {
    recursive: true,
  });

  const analyzed = await analyzeJavaScriptApplication({
    input_path: appRoot,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const parsed = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(parsed.summary).toMatchObject({
    native_addon_bindings: 2,
    resolved_native_addon_bindings: 2,
  });

  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "main.cjs" },
    direction: "outgoing",
    native_observations: [
      createSimulatedNativeEvidence(
        join(appRoot, "node_modules/pkg/build/Release/addon.node"),
        pkgDecoyBytes,
      ),
      createSimulatedNativeEvidence(
        join(appRoot, "build/Release/addon.node"),
        rootAddonBytes,
      ),
      createSimulatedNativeEvidence(
        join(
          appRoot,
          "node_modules/nm-marker-pkg/build/Release/child_marked.node",
        ),
        nmMarkerBytes,
      ),
    ],
  });
  if (!traced.ok) throw traced.error;
  expect(
    [...traced.value.result.native_handoffs].sort((left, right) =>
      (left.artifact_path ?? "").localeCompare(right.artifact_path ?? ""),
    ),
  ).toMatchObject([
    {
      artifact_path: "build/Release/addon.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex(rootAddonBytes),
      requested_exports: ["run"],
    },
    {
      artifact_path:
        "node_modules/nm-marker-pkg/build/Release/child_marked.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex(nmMarkerBytes),
      requested_exports: ["exec"],
    },
  ]);
});

it("preserves an unknown bindings() module root when neither package.json nor node_modules is proven", async () => {
  const markerlessRoot = await createTestTempDirectory(
    "rea-bindings-unknown-root-",
  );
  await writeFixtureFiles(markerlessRoot, {
    "src/main.cjs": `
      const { ipcMain } = require("electron");
      const bindings = require("bindings");
      const orphan = bindings("orphan");
      ipcMain.handle("bindings:orphan", () => orphan);
    `,
    "src/build/Release/orphan.node": "nested-decoy-orphan-bytes",
    "build/Release/orphan.node": "root-decoy-orphan-bytes",
  });

  const analyzed = await analyzeJavaScriptApplication({
    input_path: markerlessRoot,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const parsed = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(parsed.summary).toMatchObject({
    native_addon_bindings: 1,
    resolved_native_addon_bindings: 0,
  });

  const mkEntry = (
    path: string,
    kind: JavaScriptArtifactFile["kind"],
  ): JavaScriptArtifactFile => ({
    path,
    sha256: sha256Hex(path),
    container_sha256: "0".repeat(64),
    bytes: 16,
    inventory_artifact_id: "unknown-coverage-fixture",
    kind,
    unpacked: false,
    text: { included: false, reason: "not-applicable" },
  });
  const caller = mkEntry("node_modules/pkg/index.cjs", "javascript");
  const resolver = createElectronNativeAddonResolver({
    files: new Map([
      ["package.json", mkEntry("package.json", "package-json")],
      [caller.path, caller],
      [
        "build/Release/addon.node",
        mkEntry("build/Release/addon.node", "native-addon"),
      ],
    ]),
    jsonDocuments: new JavaScriptJsonDocuments(),
    unanalyzedFiles: {
      coverage: { scope: "root", status: "unknown" },
      get: () => undefined,
      hasDirectory: () => false,
    },
  });
  expect(
    resolver.resolve(caller, {
      module_kind: "require",
      binding_kind: "require",
      specifier: "addon.node",
      members: [],
      namespace_access: true,
      dynamic_member_access: false,
      module_key: null,
      location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
      resolution: {
        kind: "bindings",
        addon_name: "addon.node",
        module_root: null,
      },
    }),
  ).toEqual([]);
});

it("evaluates string replacement before parent-segment normalization for concatenated and template ASAR paths", async () => {
  const root = await createTestTempDirectory("rea-asar-string-order-");
  const packedConcat = "packed-concat-addon-binary";
  const unpackedConcat = "unpacked-concat-decoy-binary";
  const packedTemplate = "packed-template-addon-binary";
  const unpackedTemplate = "unpacked-template-decoy-binary";
  const packedJoined = "packed-joined-decoy-binary";
  const unpackedJoined = "unpacked-joined-addon-binary";
  const packedReplaceAll = "packed-replace-all-decoy-binary";
  const unpackedReplaceAll = "unpacked-replace-all-addon-binary";
  const packedSingleJoin = "packed-single-join-decoy-binary";
  const unpackedSingleJoin = "unpacked-single-join-addon-binary";

  await writeFixtureFiles(root, {
    "resources/app.asar/package.json": JSON.stringify({
      name: "asar-string-order-app",
      main: "main.cjs",
    }),
    "resources/app.asar/main.cjs": `
      const { ipcMain } = require("electron");
      const path = require("node:path");
      const a = require((__dirname + "/../app.asar/concat.node").replace("app.asar", "app.asar.unpacked"));
      const b = require(\`\${__dirname}/../app.asar/template.node\`.replace("app.asar", "app.asar.unpacked"));
      const c = require(path.join(__dirname, "../app.asar/joined.node").replace("app.asar", "app.asar.unpacked"));
      const d = require((__dirname + "/../app.asar/all.node").replaceAll("app.asar", "app.asar.unpacked"));
      const e = require(path.join(__dirname + "/../app.asar/single-join.node").replace("app.asar", "app.asar.unpacked"));
      ipcMain.handle("order:check", () => [a.run(), b.run(), c.run(), d.run(), e.run()]);
    `,
    "resources/app.asar/concat.node": packedConcat,
    "resources/app.asar.unpacked/concat.node": unpackedConcat,
    "resources/app.asar/template.node": packedTemplate,
    "resources/app.asar.unpacked/template.node": unpackedTemplate,
    "resources/app.asar/joined.node": packedJoined,
    "resources/app.asar.unpacked/joined.node": unpackedJoined,
    "resources/app.asar/all.node": packedReplaceAll,
    "resources/app.asar.unpacked/all.node": unpackedReplaceAll,
    "resources/app.asar/single-join.node": packedSingleJoin,
    "resources/app.asar.unpacked/single-join.node": unpackedSingleJoin,
  });

  const analyzed = await analyzeJavaScriptApplication({ input_path: root });
  if (!analyzed.ok) throw analyzed.error;
  const nativeObservations = [
    createSimulatedNativeEvidence(
      join(root, "resources/app.asar/concat.node"),
      packedConcat,
    ),
    createSimulatedNativeEvidence(
      join(root, "resources/app.asar/template.node"),
      packedTemplate,
    ),
    createSimulatedNativeEvidence(
      join(root, "resources/app.asar.unpacked/joined.node"),
      unpackedJoined,
    ),
    createSimulatedNativeEvidence(
      join(root, "resources/app.asar.unpacked/all.node"),
      unpackedReplaceAll,
    ),
    createSimulatedNativeEvidence(
      join(root, "resources/app.asar.unpacked/single-join.node"),
      unpackedSingleJoin,
    ),
  ];
  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "resources/app.asar/main.cjs" },
    direction: "outgoing",
    native_observations: nativeObservations,
  });
  if (!traced.ok) throw traced.error;

  const byPath = new Map(
    traced.value.result.native_handoffs.map((handoff) => [
      handoff.artifact_path,
      handoff,
    ]),
  );
  expect([...byPath.keys()].sort()).toEqual([
    "resources/app.asar.unpacked/all.node",
    "resources/app.asar.unpacked/joined.node",
    "resources/app.asar.unpacked/single-join.node",
    "resources/app.asar/concat.node",
    "resources/app.asar/template.node",
  ]);
  expect(byPath.get("resources/app.asar/concat.node")).toMatchObject({
    artifact_sha256: sha256Hex(packedConcat),
    status: "evidence-linked",
  });
  expect(byPath.get("resources/app.asar/template.node")).toMatchObject({
    artifact_sha256: sha256Hex(packedTemplate),
    status: "evidence-linked",
  });
  expect(byPath.get("resources/app.asar.unpacked/joined.node")).toMatchObject({
    artifact_sha256: sha256Hex(unpackedJoined),
    status: "evidence-linked",
  });
  expect(byPath.get("resources/app.asar.unpacked/all.node")).toMatchObject({
    artifact_sha256: sha256Hex(unpackedReplaceAll),
    status: "evidence-linked",
  });
  expect(
    byPath.get("resources/app.asar.unpacked/single-join.node"),
  ).toMatchObject({
    artifact_sha256: sha256Hex(unpackedSingleJoin),
    status: "evidence-linked",
  });
});

it("charges a bounded multiple of serialized graph bytes for multi-member multi-prebuild native bindings", async () => {
  const root = await createTestTempDirectory("rea-native-member-budget-");
  const members = Array.from(
    { length: 60 },
    (_, index) => `nativeSymbol_${String(index).padStart(3, "0")}`,
  );
  const sourceText = [
    'import nodeGypBuild from "node-gyp-build";',
    `const { ${members.join(", ")} } = nodeGypBuild(import.meta.dirname);`,
    `export const first = ${members[0]};`,
  ].join("\n");
  const prebuilds: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "multi-prebuild-pkg",
      type: "module",
      main: "index.mjs",
    }),
    "index.mjs": sourceText,
  };
  const prebuildTuples = [
    "linux-x64",
    "linux-arm64",
    "linux-ia32",
    "linux-x64-musl",
    "darwin-x64",
    "darwin-arm64",
    "win32-x64",
    "win32-ia32",
    "win32-arm64",
    "freebsd-x64",
    "openbsd-x64",
    "android-arm64",
  ];
  const targetCount = prebuildTuples.length;
  for (const [index, tuple] of prebuildTuples.entries()) {
    prebuilds[`prebuilds/${tuple}/addon.node`] = `binary-${String(index)}`;
  }
  await writeFixtureFiles(root, prebuilds);

  const analyzed = await analyzeJavaScriptApplication({ input_path: root });
  if (!analyzed.ok) throw analyzed.error;
  const result = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  const facts = analyzeJavaScriptStaticSource(sourceText);
  const checkpointBytes = Buffer.byteLength(JSON.stringify(facts));
  const estimate = estimateJavaScriptStaticApplicationProjection(
    facts,
    checkpointBytes,
    "index.mjs",
    () => targetCount,
  );
  const serialized = Buffer.byteLength(JSON.stringify(result.graph));
  expect(estimate).toBeGreaterThanOrEqual(3 * serialized);
  expect(estimate).toBeLessThanOrEqual(9 * serialized);
});

it("canonicalizes decomposed-Unicode helper lookup keys and anchored ASAR roots against the NFC inventory while preserving authored display spelling", async () => {
  const appRoot = await createTestTempDirectory("rea-native-nfc-helper-keys-");
  const nfdCafe = "cafe\u0301";
  const nfcCafe = "caf\u00e9";
  const bindingsBytes = "nfc-bindings-addon-bytes";
  const concatAsarBytes = "nfc-concat-asar-ngb-addon-bytes";

  await writeFixtureFiles(appRoot, {
    "package.json": JSON.stringify({
      name: "nfc-helper-app",
      main: "main.cjs",
    }),
    "main.cjs": [
      'const { ipcMain } = require("electron");',
      'const bindings = require("bindings");',
      'const load = require("node-gyp-build");',
      'const { openCafe } = bindings("cafe\\u0301");',
      'const { runUnpacked } = load((__dirname + "/resources/app.asar/cafe\\u0301-pkg").replace("app.asar", "app.asar.unpacked"));',
      'ipcMain.handle("cafe:run", () => [openCafe(), runUnpacked()]);',
    ].join("\n"),
    [`build/Release/${nfcCafe}.node`]: bindingsBytes,
    [`resources/app.asar.unpacked/${nfcCafe}-pkg/prebuilds/darwin-arm64/addon.node`]:
      concatAsarBytes,
  });

  const staticFacts = analyzeJavaScriptStaticSource(
    'import bindings from "bindings"; export const addon = bindings("cafe\\u0301");',
  );
  expect(staticFacts.electron.native_addon_bindings).toMatchObject([
    {
      specifier: `${nfdCafe}.node`,
      resolution: { kind: "bindings", addon_name: `${nfdCafe}.node` },
    },
  ]);

  const analyzed = await analyzeJavaScriptApplication({
    input_path: appRoot,
    format: "directory",
  });
  if (!analyzed.ok) throw analyzed.error;
  const parsed = javascriptApplicationAnalysisResultSchema.parse(
    analyzed.value.normalized_result,
  );
  expect(parsed.summary).toMatchObject({
    native_addon_bindings: 2,
    resolved_native_addon_bindings: 2,
  });

  const traced = traceApplicationFeatureEvidence({
    application: analyzed.value,
    seed: { kind: "module", value: "main.cjs" },
    direction: "outgoing",
    native_observations: [
      createSimulatedNativeEvidence(
        join(appRoot, `build/Release/${nfcCafe}.node`),
        bindingsBytes,
      ),
      createSimulatedNativeEvidence(
        join(
          appRoot,
          `resources/app.asar.unpacked/${nfcCafe}-pkg/prebuilds/darwin-arm64/addon.node`,
        ),
        concatAsarBytes,
      ),
    ],
  });
  if (!traced.ok) throw traced.error;

  const byPath = new Map(
    traced.value.result.native_handoffs.map((handoff) => [
      handoff.artifact_path,
      handoff,
    ]),
  );
  expect([...byPath.keys()].sort()).toEqual([
    `build/Release/${nfcCafe}.node`,
    `resources/app.asar.unpacked/${nfcCafe}-pkg/prebuilds/darwin-arm64/addon.node`,
  ]);
  expect(byPath.get(`build/Release/${nfcCafe}.node`)).toMatchObject({
    artifact_sha256: sha256Hex(bindingsBytes),
    status: "evidence-linked",
    requested_exports: ["openCafe"],
  });
  expect(
    byPath.get(
      `resources/app.asar.unpacked/${nfcCafe}-pkg/prebuilds/darwin-arm64/addon.node`,
    ),
  ).toMatchObject({
    artifact_sha256: sha256Hex(concatAsarBytes),
    status: "evidence-linked",
    requested_exports: ["runUnpacked"],
  });
});
