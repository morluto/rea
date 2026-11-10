import { expect, it } from "vitest";

import { applicationNodeContentDigest } from "../../../../src/domain/javascript/javascriptApplicationFileIdentity.js";
import { traceApplicationFeature } from "../../../../src/domain/javascript/javascriptFeatureTrace.js";
import { matchJavaScriptApplicationVersions } from "../../../../src/domain/javascript/javascriptApplicationVersionKeys.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  reconstructJavaScriptFixture,
  writeFixtureFiles,
} from "../../../support/javascriptApplicationFixture.js";

it("keeps identical source maps and original declarations in their file occurrences", async () => {
  const root = await createTestTempDirectory("rea-map-occurrences-");
  const main = `console.log('same');\n//# sourceMapping${"URL"}=main.js.map`;
  const map = JSON.stringify({
    version: 3,
    sources: ["src.ts"],
    names: [],
    mappings: "",
  });
  await writeFixtureFiles(root, {
    "left/main.js": main,
    "right/main.js": main,
    "left/main.js.map": map,
    "right/main.js.map": map,
  });
  const { graph } = await reconstructJavaScriptFixture(root);
  const maps = graph.nodes.filter(({ kind }) => kind === "source-map");
  const originals = graph.nodes.filter(
    ({ identity }) => identity.strategy === "source-map-original",
  );
  expect(maps).toHaveLength(2);
  expect(new Set(maps.map(applicationNodeContentDigest)).size).toBe(1);
  expect(originals).toHaveLength(2);
  const left = originals.find(
    ({ identity }) =>
      identity.strategy === "source-map-original" &&
      identity.map_occurrence?.path === "left/main.js.map",
  );
  expect(left).toBeDefined();
  const right = originals.find(
    ({ identity }) =>
      identity.strategy === "source-map-original" &&
      identity.map_occurrence?.path === "right/main.js.map",
  );
  if (left === undefined || right === undefined)
    throw new Error("Expected both original source occurrences");
  expect(matchJavaScriptApplicationVersions([left], [right]).pairs).toEqual([]);
  const samePath = { ...left, node_id: `jag_node_${"b".repeat(64)}` };
  expect(
    matchJavaScriptApplicationVersions([left], [samePath]).pairs[0]?.basis,
  ).toBe("source-map-identity");
  const trace = traceApplicationFeature({
    sourceEvidenceId: `ev_${"a".repeat(64)}`,
    graph,
    nativeEvidence: [],
    seed: {
      kind: "node-id",
      value: left?.node_id ?? "",
      match: "exact",
      case_sensitive: true,
    },
    direction: "incoming",
  });
  expect(
    trace.graph?.nodes.some((node) =>
      node.observations.some(
        ({ properties }) =>
          properties.path === "right/main.js" ||
          properties.path === "right/main.js.map",
      ),
    ),
  ).toBe(false);
});

it("does not join identical JSON or native file targets across paths", async () => {
  const root = await createTestTempDirectory("rea-file-target-occurrences-");
  const main = `require("./data.json"); require("./addon.node");`;
  await writeFixtureFiles(root, {
    "left/main.js": main,
    "right/main.js": main,
    "left/data.json": "{}",
    "right/data.json": "{}",
    "left/addon.node": "same",
    "right/addon.node": "same",
  });
  const { graph } = await reconstructJavaScriptFixture(root);
  for (const suffix of ["data.json", "addon.node"]) {
    const files = graph.nodes.filter((node) =>
      node.observations.some(
        ({ properties }) =>
          properties.path === `left/${suffix}` ||
          properties.path === `right/${suffix}`,
      ),
    );
    expect(files).toHaveLength(2);
    expect(new Set(files.map(applicationNodeContentDigest)).size).toBe(1);
  }
  const trace = traceApplicationFeature({
    sourceEvidenceId: `ev_${"a".repeat(64)}`,
    graph,
    nativeEvidence: [],
    seed: {
      kind: "string",
      value: "left/main.js",
      match: "exact",
      case_sensitive: true,
    },
    direction: "both",
  });
  expect(
    trace.graph?.nodes.some((node) =>
      node.observations.some(
        ({ properties }) => properties.path === "right/main.js",
      ),
    ),
  ).toBe(false);
  const native = graph.nodes.find(
    (node) =>
      node.kind === "native-addon" &&
      node.observations.some(
        ({ properties }) => properties.path === "left/addon.node",
      ),
  );
  expect(native).toBeDefined();
  if (native === undefined) throw new Error("Expected native file occurrence");
  const nativeTrace = traceApplicationFeature({
    sourceEvidenceId: `ev_${"a".repeat(64)}`,
    graph,
    nativeEvidence: [],
    seed: {
      kind: "node-id",
      value: native?.node_id ?? "",
      match: "exact",
      case_sensitive: true,
    },
    direction: "incoming",
  });
  expect(nativeTrace.native_handoffs).toEqual([
    expect.objectContaining({
      artifact_sha256: applicationNodeContentDigest(native),
      status: "requires-provider-analysis",
    }),
  ]);
});

it("keeps byte-identical bundler registrations and their trace paths separate", async () => {
  const root = await createTestTempDirectory("rea-bundler-occurrences-");
  const source = `(globalThis["webpackChunkfixture"] = globalThis["webpackChunkfixture"] || []).push([["main"],{1:(module)=>{module.exports=1;}},(__webpack_require__)=>{__webpack_require__(1);}]);`;
  await writeFixtureFiles(root, {
    "left/main.js": source,
    "right/main.js": source,
  });
  const { graph } = await reconstructJavaScriptFixture(root);
  expect(
    graph.nodes.filter(({ kind }) => kind === "javascript-chunk"),
  ).toHaveLength(2);
  const moduleNodes = graph.nodes.filter(
    (node) =>
      node.kind === "javascript-module" &&
      node.observations.some(({ properties }) => properties.module_key === "1"),
  );
  expect(moduleNodes).toHaveLength(2);
  const trace = traceApplicationFeature({
    sourceEvidenceId: `ev_${"a".repeat(64)}`,
    graph,
    nativeEvidence: [],
    seed: {
      kind: "string",
      value: "left/main.js",
      match: "exact",
      case_sensitive: true,
    },
    direction: "both",
  });
  expect(
    trace.graph?.nodes.some((node) =>
      node.observations.some(
        ({ properties }) => properties.path === "right/main.js",
      ),
    ),
  ).toBe(false);
});

it("keeps identical Electron construction sites scoped to their files", async () => {
  const root = await createTestTempDirectory("rea-electron-occurrences-");
  const source = `const {BrowserWindow, contextBridge, utilityProcess} = require("electron"); new BrowserWindow({webPreferences: {preload: "./preload.js"}}); contextBridge.exposeInMainWorld("api", {}); utilityProcess.fork("./child.js");`;
  await writeFixtureFiles(root, {
    "left/main.js": source,
    "right/main.js": source,
  });
  const { graph } = await reconstructJavaScriptFixture(root);
  for (const kind of [
    "browser-window",
    "context-bridge-api",
    "electron-utility",
  ]) {
    expect(graph.nodes.filter((node) => node.kind === kind)).toHaveLength(2);
  }
  const trace = traceApplicationFeature({
    sourceEvidenceId: `ev_${"a".repeat(64)}`,
    graph,
    nativeEvidence: [],
    seed: {
      kind: "string",
      value: "left/main.js",
      match: "exact",
      case_sensitive: true,
    },
    direction: "both",
  });
  expect(
    trace.graph?.nodes.some((node) =>
      node.observations.some(
        ({ properties }) => properties.path === "right/main.js",
      ),
    ),
  ).toBe(false);
});
