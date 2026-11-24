import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import type { WebPageInspection } from "../../../src/domain/browserObservationSchemas.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { compareWebCapturesInputSchema } from "../../../src/domain/webCaptureDiffSchemas.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

type SnapshotMode =
  | "valid"
  | "omitted-node"
  | "changed-node"
  | "missing-documents"
  | "invalid-documents"
  | "empty-documents"
  | "mixed-documents"
  | "missing-strings";

const snapshot = (origin: string, mode: SnapshotMode) => {
  const document = {
    documentURL: 0,
    nodes: {
      nodeType: [9, 1, 1],
      nodeName: [1, 7, mode === "changed-node" ? 6 : 3],
      nodeValue: [2, 2, 2],
      parentIndex: [-1, 0, 1],
      attributes: [[], [], mode === "omitted-node" ? null : [4, 5]],
    },
  };
  let documents: unknown = [document];
  if (mode === "missing-documents") documents = undefined;
  if (mode === "invalid-documents") documents = {};
  if (mode === "empty-documents") documents = [];
  if (mode === "mixed-documents")
    documents = [
      document,
      null,
      { documentURL: 0 },
      { documentURL: 0, nodes: null },
    ];
  return {
    strings:
      mode === "missing-strings"
        ? undefined
        : [
            origin + "/app",
            "#document",
            "",
            "A",
            "href",
            "/target",
            "SPAN",
            "HTML",
          ],
    documents,
  };
};

const startBrowser = async () => {
  const state = {
    mode: "valid" as SnapshotMode,
    nested: false,
    renamed: false,
    parentOverride: undefined as { value: unknown } | undefined,
  };
  const browser = await startFakeCdpBrowser({
    commandResult(command, origin) {
      if (command.method === "DOMSnapshot.captureSnapshot")
        return snapshot(origin, state.mode);
      if (command.method !== "Page.getFrameTree") return undefined;
      const id = (name: string) => (state.renamed ? "new-" + name : name);
      const child = {
        frame: {
          id: id("b"),
          parentId:
            state.parentOverride === undefined
              ? id(state.nested ? "a" : "main")
              : state.parentOverride.value,
          loaderId: "loader-b",
          url: origin + "/b",
        },
      };
      const parent = {
        frame: {
          id: id("a"),
          parentId: id("main"),
          loaderId: "loader-a",
          url: origin + "/a",
        },
        childFrames: state.nested ? [child] : [],
      };
      return {
        frameTree: {
          frame: {
            id: id("main"),
            loaderId: "loader-main",
            url: origin + "/app",
          },
          childFrames: state.nested ? [parent] : [parent, child],
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
  return { state, inspect, origin: browser.allowedOrigin };
};

const compare = (before: WebPageInspection, after: WebPageInspection) =>
  compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  );

const unknownDimension = { status: "unknown", total_changes: 0, changes: [] };

const documentExclusions = (capture: WebPageInspection) =>
  capture.completeness.excluded.filter(
    ({ section }) => section === "dom" || section === "metadata",
  );

it("reports unknown document coverage for an unreadable snapshot", async () => {
  const { state, inspect } = await startBrowser();
  for (const mode of [
    "missing-documents",
    "invalid-documents",
    "empty-documents",
    "missing-strings",
  ] as const) {
    state.mode = mode;
    const capture = await inspect();
    expect(capture.dom, mode).toMatchObject({ total_nodes: 0, nodes: [] });
    expect(capture.metadata.dom_urls, mode).toEqual([]);
    expect(capture.completeness.unavailable_sections, mode).toEqual(
      expect.arrayContaining(["dom", "metadata"]),
    );
    expect(documentExclusions(capture), mode).toEqual([
      { section: "dom", reason: "invalid_protocol_value", count: null },
      { section: "metadata", reason: "invalid_protocol_value", count: null },
    ]);
    expect(capture.accessibility.total_nodes, mode).toBeGreaterThan(0);
  }
});

it("retains valid document evidence beside malformed siblings without proving equality", async () => {
  const { state, inspect, origin } = await startBrowser();
  state.mode = "mixed-documents";
  const capture = await inspect();
  expect(capture.dom.total_nodes).toBe(3);
  expect(capture.dom.nodes.map(({ node_name }) => node_name)).toEqual([
    "#document",
    "HTML",
    "A",
  ]);
  expect(capture.metadata.dom_urls.map(({ url }) => url)).toEqual([
    `${origin}/target`,
  ]);
  expect(capture.completeness.unavailable_sections).toEqual(
    expect.arrayContaining(["dom", "metadata"]),
  );
  expect(documentExclusions(capture)).toEqual([
    { section: "dom", reason: "invalid_protocol_value", count: 3 },
    { section: "metadata", reason: "invalid_protocol_value", count: 3 },
  ]);
  expect(compare(capture, capture).dimensions).toMatchObject({
    dom_structure: unknownDimension,
    metadata: unknownDimension,
  });
});

it("keeps frame ancestry unknown when a retained child has no readable parent", async () => {
  const { state, inspect } = await startBrowser();
  const before = await inspect();
  for (const parent of [undefined, null, 17, ""]) {
    state.parentOverride = { value: parent };
    const after = await inspect();
    const label = String(parent);
    expect(
      after.frames.map(({ frame_id, parent_frame_id }) => [
        frame_id,
        parent_frame_id,
      ]),
      label,
    ).toEqual([
      ["main", null],
      ["a", "main"],
      ["b", null],
    ]);
    expect(after.completeness.unavailable_sections, label).toContain("frames");
    expect(after.completeness.excluded, label).toContainEqual({
      section: "frames",
      reason: "invalid_protocol_value",
      count: 1,
    });
    expect(
      compare(before, after).dimensions.dom_structure,
      label,
    ).toMatchObject(unknownDimension);
    expect(compare(after, after).dimensions.dom_structure, label).toMatchObject(
      unknownDimension,
    );
  }
});

it("compares document changes and frame ancestry independently of volatile frame IDs", async () => {
  const { state, inspect } = await startBrowser();
  const before = await inspect();
  state.renamed = true;
  expect(
    compare(before, await inspect()).dimensions.dom_structure,
  ).toMatchObject({
    status: "unchanged",
    total_changes: 0,
    changes: [],
  });

  state.mode = "changed-node";
  expect(
    compare(before, await inspect()).dimensions.dom_structure,
  ).toMatchObject({
    status: "changed",
    total_changes: 1,
    changes: [{ identity: "document", change: "modified" }],
  });

  state.mode = "valid";
  state.nested = true;
  const nested = await inspect();
  expect(
    nested.frames.find(({ frame_id }) => frame_id === "new-b")?.parent_frame_id,
  ).toBe("new-a");
  expect(compare(before, nested).dimensions.dom_structure).toMatchObject({
    status: "changed",
    total_changes: 1,
    changes: [{ identity: "frames", change: "modified" }],
  });
});

describe("DOM evidence through the public CLI", () => {
  cliTest(
    "preserves omissions and independently proven frame changes",
    async ({ cli }) => {
      const { state, inspect } = await startBrowser();
      const root = await createTestTempDirectory("rea-dom-comparison-");
      const before = join(root, "before.json");
      const after = join(root, "after.json");
      const baseline = await inspect();
      await writeFile(before, JSON.stringify({ inspection: baseline }));
      state.mode = "omitted-node";
      for (const nested of [false, true]) {
        state.nested = nested;
        const partial = await inspect();
        expect(partial.dom, `nested=${nested}`).toMatchObject({
          total_nodes: 3,
          nodes: [
            expect.objectContaining({ node_name: "#document" }),
            expect.objectContaining({ node_name: "HTML" }),
          ],
        });
        expect(partial.metadata.dom_urls).toEqual([]);
        expect(documentExclusions(partial)).toEqual([
          { section: "dom", reason: "invalid_protocol_value", count: 1 },
          { section: "metadata", reason: "invalid_protocol_value", count: 1 },
        ]);
        if (!nested) {
          const reverse = compare(partial, baseline);
          expect(reverse.overall_status).toBe("unknown");
          expect(reverse.dimensions).toMatchObject({
            dom_structure: unknownDimension,
            metadata: unknownDimension,
          });
        }
        await writeFile(after, JSON.stringify({ inspection: partial }));
        const cliResult = await cli.run({
          arguments: ["compare-web-captures", before, after, "--json"],
          environment: process.env,
        });
        expect(cliResult.exitCode).toBe(0);
        expect(cliResult.signal).toBeNull();
        expect(cliResult.json).toMatchObject({
          operation: "compare_web_captures",
          normalized_result: {
            overall_status: nested ? "changed" : "unknown",
            dimensions: {
              dom_structure: nested
                ? {
                    status: "changed",
                    total_changes: 1,
                    changes: [{ identity: "frames", change: "modified" }],
                  }
                : unknownDimension,
              metadata: unknownDimension,
            },
          },
        });
      }
    },
  );
});
