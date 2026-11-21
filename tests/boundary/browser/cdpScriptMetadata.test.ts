import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createJavaScriptRuntimeObservationEvidence } from "../../../src/application/javascript/JavaScriptRuntimeObservationEvidence.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { publishWebScripts } from "../../../src/application/PublishWebScripts.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { webScriptExportManifestSchema } from "../../../src/domain/webScriptExport.js";
import { selectScriptCapture } from "../../../src/domain/webScriptCaptureAdapters.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { inspectElectronPageInputSchema } from "../../../src/domain/javascript/electronObservation.js";
import { parseRuntimeCapture } from "../../../src/domain/javascript/javascriptRuntimeReconciliationCaptureParsing.js";
import { projectRuntimeCaptures } from "../../../src/domain/javascript/javascriptRuntimeReconciliationRuntime.js";
import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { startFakeV8Inspector } from "../../fixtures/inspector/fakeV8Inspector.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const metadataCases = [
  {
    name: "omitted metadata remains unknown",
    reported: {},
    expected: { cdp_hash: null, length: null, is_module: null },
  },
  {
    name: "explicit empty hash, zero length, and non-module are preserved",
    reported: { hash: "", length: 0, isModule: false },
    expected: { cdp_hash: "", length: 0, is_module: false },
  },
  {
    name: "known module metadata is preserved",
    reported: { hash: "reported-hash", length: 123, isModule: true },
    expected: { cdp_hash: "reported-hash", length: 123, is_module: true },
  },
  {
    name: "malformed metadata is unknown instead of repaired",
    reported: { hash: 42, length: -1, isModule: "false" },
    expected: { cdp_hash: null, length: null, is_module: null },
  },
  {
    name: "invalid length preserves adjacent valid facts",
    reported: { hash: "reported-hash", length: 1.5, isModule: true },
    expected: { cdp_hash: "reported-hash", length: null, is_module: true },
  },
];

const resources: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

const createMetadataDirectory = () =>
  createTestTempDirectory("rea-cdp-script-metadata-");

const metadataFile = (index: number): string => `metadata-${String(index)}.js`;
const writeMetadataFiles = async (root: string): Promise<void> => {
  await Promise.all(
    metadataCases.map((_, index) =>
      writeFile(
        join(root, metadataFile(index)),
        `export const observed = ${String(index)};`,
      ),
    ),
  );
};

const metadataEvents = (location: (index: number) => string) =>
  metadataCases.map(({ reported }, index) => ({
    method: "Debugger.scriptParsed",
    params: {
      scriptId: metadataFile(index),
      url: location(index),
      executionContextId: 1,
      ...reported,
    },
  }));

type MetadataExpectation = (typeof metadataCases)[number]["expected"];

const expectMetadataCases = (
  items: readonly unknown[],
  expectedRecord: (index: number, metadata: MetadataExpectation) => object,
): void => {
  expect(items).toHaveLength(metadataCases.length);
  for (const [index, { name, expected }] of metadataCases.entries())
    expect(items, name).toContainEqual(
      expect.objectContaining(expectedRecord(index, expected)),
    );
};

describe.each(["browser", "electron"] as const)(
  "%s script metadata",
  (kind) => {
    it("retains each reported metadata variant through capture and consumers", async () => {
      const root = await createMetadataDirectory();
      if (kind === "electron")
        await Promise.all([
          writeFile(join(root, "index.html"), "<html></html>"),
          writeMetadataFiles(root),
        ]);
      const file = (index: number) => join(root, metadataFile(index));
      const browserUrl = (origin: string, index: number) =>
        `${origin}/${metadataFile(index)}`;
      const browser = await startFakeCdpBrowser({
        ...(kind === "electron"
          ? { electronFileUrl: pathToFileURL(join(root, "index.html")).href }
          : {}),
        commandEvents: ({ method }, origin) =>
          method === "Debugger.enable"
            ? metadataEvents((index) =>
                kind === "browser"
                  ? browserUrl(origin, index)
                  : pathToFileURL(file(index)).href,
              ).map((event) => ({
                ...event,
                sessionId: "session-1",
                params: { ...event.params, scriptLanguage: "JavaScript" },
              }))
            : undefined,
      });
      resources.push(() => browser.close());
      const input = {
        cdp_endpoint: browser.endpoint,
        observation_ms: 0,
        include_script_sources: true,
      };

      if (kind === "electron") {
        const result = await new CdpElectronProvider().inspectPage(
          inspectElectronPageInputSchema.parse({
            ...input,
            target_id: "electron-page",
          }),
        );
        if (!result.ok) throw result.error;
        expectMetadataCases(result.value.scripts.items, (index, expected) => ({
          file_path: file(index),
          ...expected,
        }));
        return;
      }

      const result = await new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse({
          ...input,
          target_id: "allowed-page",
        }),
      );
      if (!result.ok) throw result.error;

      const artifactResources = new ArtifactResourceScope();
      resources.push(() => artifactResources.close());
      const capturePath = join(root, "capture.json");
      const captureBytes = JSON.stringify(result.value);
      await writeFile(capturePath, captureBytes);
      const exported = await publishWebScripts(
        { capture_path: capturePath, output_directory: join(root, "exported") },
        selectScriptCapture(result.value),
        createHash("sha256").update(captureBytes).digest("hex"),
        { resources: artifactResources },
      );
      const manifest = webScriptExportManifestSchema.parse(
        JSON.parse(await readFile(exported.manifest.path, "utf8")),
      );
      const url = (index: number) => browserUrl(browser.allowedOrigin, index);
      expectMetadataCases(result.value.scripts.items, (index, expected) => ({
        url: url(index),
        ...expected,
      }));
      for (const records of [exported.scripts, manifest.scripts])
        expectMetadataCases(records, (index, expected) => ({
          url: url(index),
          source: expect.objectContaining({ is_module: expected.is_module }),
          content: expect.objectContaining({ state: "exported" }),
        }));
    });
  },
);

it("retains Inspector metadata variants across runtime reconciliation", async () => {
  const root = await createMetadataDirectory();
  await writeMetadataFiles(root);
  const file = (index: number) => join(root, metadataFile(index));
  const inspector = await startFakeV8Inspector({
    targetUrl: pathToFileURL(file(0)).href,
    scriptEvents: metadataEvents((index) => pathToFileURL(file(index)).href),
  });
  resources.push(() => inspector.close());
  const input = {
    inspector_endpoint: inspector.endpoint,
    target_id: inspector.targetId,
    observation_ms: 50,
  };
  const provider = new V8InspectorProvider();
  const result = await provider.observe(input);
  if (!result.ok) throw result.error;
  const evidence = createJavaScriptRuntimeObservationEvidence(
    "observe_javascript_runtime",
    input,
    result.value,
    provider.identity(),
  );
  const projected = projectRuntimeCaptures([
    parseRuntimeCapture(evidence, ["runtime_observations", 0]),
  ]);
  const scriptNodes = projected.nodes.filter(
    ({ kind }) => kind === "runtime-script-instance",
  );
  const properties = scriptNodes.map(
    ({ observations }) => observations[0]?.properties,
  );
  expectMetadataCases(result.value.scripts.items, (index, expected) => ({
    location: { kind: "file", file_path: file(index) },
    ...expected,
  }));
  expectMetadataCases(properties, (index, expected) => ({
    location: file(index),
    ...expected,
  }));
});

describe("Inspector script exclusions", () => {
  const reconcileV8Scripts = async (
    scriptEvents: readonly { method: string; params: object }[],
  ) => {
    const root = await createMetadataDirectory();
    await writeFile(join(root, "app.js"), "export const observed = true;");
    const inspector = await startFakeV8Inspector({
      targetUrl: pathToFileURL(join(root, "app.js")).href,
      scriptEvents,
    });
    resources.push(() => inspector.close());
    const input = {
      inspector_endpoint: inspector.endpoint,
      target_id: inspector.targetId,
      observation_ms: 50,
    };
    const provider = new V8InspectorProvider();
    const result = await provider.observe(input);
    if (!result.ok) throw result.error;
    const parsed = parseRuntimeCapture(
      createJavaScriptRuntimeObservationEvidence(
        "observe_javascript_runtime",
        input,
        result.value,
        provider.identity(),
      ),
      ["runtime_observations", 0],
    );
    return {
      producer: result.value.scripts.excluded,
      completeness: parsed?.inspection.completeness,
    };
  };
  const invalidFailedToParse = {
    method: "Debugger.scriptFailedToParse",
    params: { scriptId: 42, url: "", executionContextId: 1 },
  };
  const missingUrl = {
    method: "Debugger.scriptParsed",
    params: { scriptId: "missing-url", executionContextId: 1 },
  };

  it("keeps invalid protocol scripts out of policy filtering", async () => {
    const { producer, completeness } = await reconcileV8Scripts([
      invalidFailedToParse,
      missingUrl,
    ]);
    expect(producer).toEqual({
      unsupported_location: 0,
      invalid_protocol_value: 2,
    });
    expect(completeness).toMatchObject({
      status: "attach_limited",
      conditions: ["attach_limited"],
      policy_filtered_sections: [],
      excluded: [
        { section: "scripts", reason: "invalid_protocol_value", count: 2 },
      ],
    });
    expect(completeness?.unavailable_sections).toContain("scripts");
  });

  it("reports unsupported and invalid script exclusions separately", async () => {
    const { producer, completeness } = await reconcileV8Scripts([
      invalidFailedToParse,
      {
        method: "Debugger.scriptParsed",
        params: {
          scriptId: "data-script",
          url: "data:text/javascript,0",
          executionContextId: 1,
        },
      },
    ]);
    expect(producer).toEqual({
      unsupported_location: 1,
      invalid_protocol_value: 1,
    });
    expect(completeness).toMatchObject({
      status: "policy_filtered",
      conditions: ["attach_limited", "policy_filtered"],
      policy_filtered_sections: ["scripts"],
      excluded: [
        { section: "scripts", reason: "invalid_protocol_value", count: 1 },
        { section: "scripts", reason: "out_of_target_scope", count: 1 },
      ],
    });
    expect(completeness?.unavailable_sections).toContain("scripts");
  });
});
