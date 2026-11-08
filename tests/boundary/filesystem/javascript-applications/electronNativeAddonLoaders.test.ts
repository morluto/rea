import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import { expect, it } from "vitest";

import { traceApplicationFeatureEvidence } from "../../../../src/application/javascript/JavaScriptApplicationWorkflowService.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { createEvidence } from "../../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";
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
