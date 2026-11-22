import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import {
  webPageInspectionSchema,
  type WebPageInspection,
} from "../../../src/domain/browserObservationSchemas.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";

type ResourceMode =
  | "valid"
  | "missing"
  | "null"
  | "wrong-type"
  | "invalid-entry"
  | "child-missing"
  | "child-invalid-entry"
  | "child-wrong-type"
  | "empty";

interface ResourceFixture {
  readonly name: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

const startBrowser = async () => {
  const state = {
    mode: "valid" as ResourceMode,
    extraResources: [] as readonly ResourceFixture[],
  };
  const browser = await startFakeCdpBrowser({
    commandResult(command, origin) {
      const { mode, extraResources } = state;
      const frame = { id: "frame-main", url: `${origin}/app` };
      const child = {
        id: "child",
        parentId: "frame-main",
        url: `${origin}/child`,
      };
      const resource = (
        name: string,
        fields?: Readonly<Record<string, unknown>>,
      ) => ({
        url: origin + "/" + name,
        type: "Script",
        mimeType: "text/javascript",
        contentSize: 128,
        ...fields,
      });
      const childFrames =
        mode === "child-wrong-type"
          ? {}
          : mode === "child-invalid-entry"
            ? [{ frame: child, resources: [resource("child.js")] }, null]
            : mode === "child-missing"
              ? [{ frame: child }]
              : undefined;
      if (command.method === "Page.getFrameTree" && childFrames !== undefined)
        return { frameTree: { frame, childFrames } };
      if (command.method !== "Page.getResourceTree") return undefined;

      const inventories: Partial<Record<ResourceMode, unknown>> = {
        missing: undefined,
        null: null,
        "wrong-type": {},
        "invalid-entry": [resource("keep.js"), null],
        empty: [],
        valid: [
          resource("keep.js"),
          resource("peer.js"),
          ...extraResources.map(({ name, fields }) => resource(name, fields)),
        ],
      };
      return {
        frameTree: {
          frame,
          resources: inventories[childFrames === undefined ? mode : "valid"],
          childFrames,
        },
      };
    },
  });
  trackBrowser(browser);
  const inspect = async () => {
    const result = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!result.ok) throw result.error;
    return result.value;
  };
  return {
    state,
    inspect,
    origin: browser.allowedOrigin,
    endpoint: browser.endpoint,
  };
};

const resourceExclusions = (inspection: WebPageInspection) =>
  inspection.completeness.excluded.filter(
    ({ section }) => section === "resources",
  );

it("retains readable inventories and reports unknown coverage for missing or malformed trees", async () => {
  const { state, inspect, origin } = await startBrowser();
  const cases = [
    { mode: "missing", resources: [], count: null },
    { mode: "null", resources: [], count: null },
    { mode: "wrong-type", resources: [], count: null },
    { mode: "invalid-entry", resources: ["keep.js"], count: 1 },
    {
      mode: "child-missing",
      resources: ["keep.js", "peer.js"],
      count: null,
      frames: ["child", "frame-main"],
    },
    {
      mode: "child-invalid-entry",
      resources: ["child.js", "keep.js", "peer.js"],
      count: null,
      frames: ["child", "frame-main"],
    },
    {
      mode: "child-wrong-type",
      resources: ["keep.js", "peer.js"],
      count: null,
      frames: ["frame-main"],
    },
  ] as const;
  for (const testCase of cases) {
    const { mode, resources, count } = testCase;
    state.mode = mode;
    const capture = await inspect();
    expect(capture.completeness.unavailable_sections, mode).toContain(
      "resources",
    );
    expect(resourceExclusions(capture), mode).toEqual([
      { section: "resources", reason: "invalid_protocol_value", count },
    ]);
    expect(capture.resources.map(({ url }) => url).sort(), mode).toEqual(
      resources.map((name) => `${origin}/${name}`),
    );
    if ("frames" in testCase) {
      const frameExclusions = capture.completeness.excluded.filter(
        ({ section }) => section === "frames",
      );
      expect(
        capture.completeness.unavailable_sections.includes("frames"),
        mode,
      ).toBe(mode !== "child-missing");
      expect(frameExclusions, mode).toEqual(
        mode === "child-missing"
          ? []
          : [
              {
                section: "frames",
                reason: "invalid_protocol_value",
                count: null,
              },
            ],
      );
      expect(
        capture.frames.map(({ frame_id }) => frame_id).sort(),
        mode,
      ).toEqual(testCase.frames);
    }
  }
});

describe("resource uncertainty in production MCP registration", () => {
  it("preserves typed resource facts and comparison uncertainty through the SDK", async () => {
    const { state, origin, endpoint } = await startBrowser();
    const harness = await createApplicationMcpHarness({
      serverOptions: { browserObservation: new CdpBrowserProvider() },
    });
    onTestFinished(harness.close);
    const capture = async () => {
      const reply = await harness.client.callTool({
        name: "inspect_web_page",
        arguments: {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          target_id: "allowed-page",
          observation_ms: 0,
        },
      });
      expect(reply.isError).not.toBe(true);
      expect(reply.structuredContent).toMatchObject({
        operation: "inspect_web_page",
      });
      return webPageInspectionSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      );
    };
    const expectedResource = (
      name: string,
      contentSize: number | null = 128,
      declaration = { type: "Script", mime_type: "text/javascript" },
    ) =>
      expect.objectContaining({
        url: `${origin}/${name}`,
        origin,
        ...declaration,
        content_size: contentSize,
      });
    const healthy: ResourceFixture[] = [
      {
        name: "omitted.js",
        fields: { type: "Other", mimeType: "", contentSize: undefined },
      },
      { name: "zero.js", fields: { contentSize: 0 } },
      { name: "fractional.js", fields: { contentSize: 1.5 } },
    ];
    const malformed: ResourceFixture[] = [
      { name: "missing-type.js", fields: { type: undefined } },
      { name: "null-type.js", fields: { type: null } },
      { name: "numeric-type.js", fields: { type: 17 } },
      { name: "empty-type.js", fields: { type: "" } },
      { name: "missing-mime.js", fields: { mimeType: undefined } },
      { name: "null-mime.js", fields: { mimeType: null } },
      { name: "numeric-mime.js", fields: { mimeType: 17 } },
      { name: "negative-size.js", fields: { contentSize: -1 } },
      { name: "null-size.js", fields: { contentSize: null } },
      { name: "string-size.js", fields: { contentSize: "128" } },
      { name: "object-size.js", fields: { contentSize: {} } },
    ];
    const expectedHealthy = [
      expectedResource("keep.js"),
      expectedResource("peer.js"),
      expectedResource("fractional.js", 1.5),
      expectedResource("omitted.js", null, { type: "Other", mime_type: "" }),
      expectedResource("zero.js", 0),
    ];
    state.extraResources = healthy;
    const before = await capture();
    expect(before.resources).toHaveLength(expectedHealthy.length);
    expect(before.resources).toEqual(expect.arrayContaining(expectedHealthy));
    expect(before.completeness.unavailable_sections).not.toContain("resources");
    expect(resourceExclusions(before)).toEqual([]);

    state.extraResources = [...healthy, ...malformed];
    const after = await capture();
    expect(after.resources).toHaveLength(expectedHealthy.length + 4);
    expect(after.resources).toEqual(
      expect.arrayContaining([
        ...expectedHealthy,
        expectedResource("negative-size.js", null),
        expectedResource("null-size.js", null),
        expectedResource("object-size.js", null),
        expectedResource("string-size.js", null),
      ]),
    );
    expect(resourceExclusions(after)).toEqual([
      { section: "resources", reason: "invalid_protocol_value", count: 11 },
    ]);
    expect(after.completeness.unavailable_sections).toContain("resources");
    const comparison = await harness.client.callTool({
      name: "compare_web_captures",
      arguments: {
        before: { inspection: before },
        after: { inspection: after },
      },
    });
    expect(comparison.isError).not.toBe(true);
    expect(comparison.structuredContent).toMatchObject({
      operation: "compare_web_captures",
      normalized_result: {
        dimensions: {
          resources: { status: "unknown", total_changes: 0, changes: [] },
        },
      },
    });

    state.mode = "missing";
    const missing = await capture();
    expect(missing.resources).toEqual([]);
    expect(missing.completeness.unavailable_sections).toContain("resources");
    expect(resourceExclusions(missing)).toEqual([
      { section: "resources", reason: "invalid_protocol_value", count: null },
    ]);
  });
});

describe("resource uncertainty in public CLI Evidence", () => {
  cliTest(
    "preserves partial membership while complete inventories still prove removal",
    async ({ cli }) => {
      const { state, inspect } = await startBrowser();
      const root = await createTestTempDirectory("rea-resource-comparison-");
      const before = join(root, "before.json");
      const after = join(root, "after.json");
      await writeFile(before, JSON.stringify({ inspection: await inspect() }));
      for (const { mode, expected } of [
        {
          mode: "invalid-entry",
          expected: { status: "unknown", total_changes: 0, changes: [] },
        },
        {
          mode: "empty",
          expected: {
            status: "changed",
            total_changes: 2,
            changes: [{ change: "removed" }, { change: "removed" }],
          },
        },
      ] as const) {
        state.mode = mode;
        await writeFile(after, JSON.stringify({ inspection: await inspect() }));
        const cliResult = await cli.run({
          arguments: ["compare-web-captures", before, after, "--json"],
          environment: process.env,
        });
        expect(cliResult.exitCode).toBe(0);
        expect(cliResult.signal).toBeNull();
        expect(cliResult.json).toMatchObject({
          operation: "compare_web_captures",
          normalized_result: {
            dimensions: {
              resources: expected,
            },
          },
        });
      }
    },
  );
});
