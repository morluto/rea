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
import type { JavaScriptArtifactFile } from "../../../../src/domain/javascript/javascriptArtifactFiles.js";
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
  const decoyDarwinUnpackedBytes =
    "loose-unpacked-darwin-decoy-shadowed-by-packed-js";
  const genuineLinuxUnpackedBytes =
    "loose-unpacked-genuine-miss-linux-addon-bytes";

  await writeFixtureFiles(asarSource, {
    "package.json": JSON.stringify({
      name: "inner-asar",
      main: "index.cjs",
    }),
    "index.cjs": [
      'const { ipcMain } = require("electron");',
      'const packedJs = require("./addon.node");',
      "const platformAddon = require(`./plat-${process.platform}.node`);",
      'ipcMain.handle("asar:check", () => [packedJs, platformAddon]);',
    ].join("\n"),
    "addon.node.js": "module.exports = { mockedInJs: true };",
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
    native_addon_bindings: 2,
    resolved_native_addon_bindings: 1,
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
  expect(traced.value.result.native_handoffs).toMatchObject([
    {
      artifact_path: "resources/app.asar.unpacked/plat-linux.node",
      status: "evidence-linked",
      artifact_sha256: sha256Hex(genuineLinuxUnpackedBytes),
    },
  ]);
});
