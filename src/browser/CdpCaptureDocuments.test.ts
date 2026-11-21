import { describe, expect, it } from "vitest";

import {
  captureDom,
  captureFrames,
  captureResources,
  classifyCdpFrameUrl,
  observeCdpFrameUrl,
} from "./CdpCaptureDocuments.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  frameTreeReply,
  resourceTreeReply,
} from "../../tests/fixtures/fakeCdpSend.js";

const origin = "https://app.example.test";

it("keeps reported origin evidence independent of malformed or missing frame URLs", () => {
  const allowed = new Set([origin]);
  const url = "https://user:password@app.example.test/page?token=local#old";
  for (const urlFragment of [7, null, "without-hash"]) {
    const observed = observeCdpFrameUrl({ url, urlFragment });
    expect(observed, String(urlFragment)).toEqual({
      kind: "invalid_fragment",
      scopeUrl: url,
    });
    expect(classifyCdpFrameUrl(observed, allowed), String(urlFragment)).toEqual(
      {
        scope: "approved",
        origin,
        url: undefined,
      },
    );
  }
  expect(
    classifyCdpFrameUrl(
      observeCdpFrameUrl({ urlFragment: `#${origin}` }),
      allowed,
    ),
  ).toEqual({
    scope: "unknown",
    origin: null,
    url: undefined,
  });
});

it("publishes exact approved frame URLs and counts malformed and foreign children", () => {
  const completeness = new CdpCaptureCompleteness();
  const children = [
    { id: "inline", url: `${origin}/inline?x=1#old` },
    {
      id: "replaced",
      url: "https://user:password@app.example.test/replaced?token=local#old",
      urlFragment: "#new",
    },
    { id: "cleared", url: `${origin}/cleared?x=1#old`, urlFragment: "" },
    { id: "malformed-approved", url: `${origin}/invalid`, urlFragment: 7 },
    {
      id: "malformed-foreign-number",
      url: "https://foreign.test/number",
      urlFragment: 7,
    },
    {
      id: "malformed-foreign-string",
      url: "https://foreign.test/string",
      urlFragment: "without-hash",
    },
    {
      id: "foreign",
      url: "https://foreign.test/page",
      urlFragment: `#${origin}`,
    },
  ];
  const captured = captureFrames(
    frameTreeReply({
      frameTree: {
        frame: { id: "root", url: `${origin}/` },
        childFrames: children.map((frame) => ({
          frame: { ...frame, parentId: "root" },
        })),
      },
    }),
    new Set([origin]),
    undefined,
    completeness,
  );

  expect(captured.items).toEqual([
    { frame_id: "root", parent_frame_id: null, url: `${origin}/`, origin },
    {
      frame_id: "inline",
      parent_frame_id: "root",
      url: `${origin}/inline?x=1#old`,
      origin,
    },
    {
      frame_id: "replaced",
      parent_frame_id: "root",
      url: `${origin}/replaced?token=local#new`,
      origin,
    },
    {
      frame_id: "cleared",
      parent_frame_id: "root",
      url: `${origin}/cleared?x=1`,
      origin,
    },
  ]);
  expect(completeness.snapshot()).toMatchObject({
    unavailable_sections: ["frames"],
    policy_filtered_sections: ["frames"],
    excluded: [
      { section: "frames", reason: "disallowed_origin", count: 3 },
      { section: "frames", reason: "invalid_protocol_value", count: 3 },
    ],
  });
});

const mixedDomColumns = [
  [9, 1, -1, -1, []],
  [1, 2, -1, 0, []],
  // Wrong wire types in name, parent, value, and attribute references.
  [1, "3", -1, 1, []],
  [1, 3, -1, "1", []],
  [1, 3, "0", 1, []],
  [1, 3, -1, 1, [4, "bad", 4, 5]],
  // Malformed and missing string references, including the value-only -1 sentinel.
  [1, -1, -1, 1, []],
  [1, 20, -1, 1, []],
  [1, 7, -1, 1, []],
  [1, 3, -2, 1, []],
  [1, 3, 20, 1, []],
  [1, 3, 7, 1, []],
  [1, 3, -1, 1, [-1, 5]],
  [1, 3, -1, 1, [20, 5]],
  [1, 3, -1, 1, [4, -2]],
  [1, 3, -1, 1, [4, 20]],
  [1, 3, -1, 1, [4]],
  [1, 3, -1, 1, "invalid"],
  [1, 3, 8, 2, []],
  [1, 9, -1, 1, [4, 6]],
] as const;

it("keeps DOM source positions across malformed rows and later documents", () => {
  const completeness = new CdpCaptureCompleteness();
  const generator = captureDom(
    {
      strings: [
        origin + "/app",
        "#document",
        "HTML",
        "SPAN",
        "href",
        "/decoy",
        "/kept",
        42,
        "😀a",
        "A",
        "hidden",
        "#text",
        "go",
      ],
      documents: [
        {
          documentURL: 0,
          nodes: {
            nodeType: mixedDomColumns.map(([type]) => type),
            nodeName: mixedDomColumns.map(([, name]) => name),
            nodeValue: mixedDomColumns.map(([, , value]) => value),
            parentIndex: mixedDomColumns.map(([, , , parent]) => parent),
            attributes: mixedDomColumns.map(
              ([, , , , attributes]) => attributes,
            ),
          },
        },
        {
          documentURL: 0,
          baseURL: -1,
          nodes: {
            nodeType: [9, 1, 3],
            nodeName: [1, 9, 11],
            nodeValue: [-1, -1, 12],
            parentIndex: [-1, 0, 1],
            attributes: [[], [4, -1, 10, -1], []],
          },
        },
      ],
    },
    new Set([origin]),
    completeness,
  );
  const result = generator.next();
  if (!result.done) throw new Error("Unexpected SVG identity query");
  expect(result.value.total).toBe(23);
  expect(result.value.nodeValueLengthUnit).toBe("utf16-code-units");
  expect(result.value.nodes).toEqual([
    {
      index: 0,
      node_type: 9,
      node_name: "#document",
      parent_index: -1,
      node_value_length: 0,
      attribute_names: [],
    },
    {
      index: 1,
      node_type: 1,
      node_name: "HTML",
      parent_index: 0,
      node_value_length: 0,
      attribute_names: [],
    },
    {
      index: 18,
      node_type: 1,
      node_name: "SPAN",
      parent_index: 2,
      node_value_length: 3,
      attribute_names: [],
    },
    {
      index: 19,
      node_type: 1,
      node_name: "A",
      parent_index: 1,
      node_value_length: 0,
      attribute_names: ["href"],
    },
    {
      index: 20,
      node_type: 9,
      node_name: "#document",
      parent_index: -1,
      node_value_length: 0,
      attribute_names: [],
    },
    {
      index: 21,
      node_type: 1,
      node_name: "A",
      parent_index: 20,
      node_value_length: 0,
      attribute_names: ["href", "hidden"],
    },
    {
      index: 22,
      node_type: 3,
      node_name: "#text",
      parent_index: 21,
      node_value_length: 2,
      attribute_names: [],
    },
  ]);
  expect(result.value.urls).toEqual([
    {
      node_index: 19,
      attribute: "href",
      url: `${origin}/kept`,
      destination_scope: "approved",
    },
    {
      node_index: 21,
      attribute: "href",
      url: `${origin}/app`,
      destination_scope: "approved",
    },
  ]);
  expect(completeness.snapshot()).toMatchObject({
    unavailable_sections: ["dom", "metadata"],
    excluded: [
      { section: "dom", reason: "invalid_protocol_value", count: 16 },
      { section: "metadata", reason: "invalid_protocol_value", count: 16 },
    ],
  });
});

describe("CDP DOM string and namespace validity", () => {
  it("does not infer SVG ancestry through an element with malformed namespace data", () => {
    const strings: unknown[] = [
      origin + "/app",
      "#document",
      "svg",
      "a",
      "xmlns:xlink",
      "http://www.w3.org/1999/xlink",
      "xlink:href",
      "/svg-link",
    ];
    const completeness = new CdpCaptureCompleteness();
    const generator = captureDom(
      {
        strings,
        documents: [
          {
            documentURL: 0,
            baseURL: 0,
            nodes: {
              nodeType: [9, 1, 1],
              nodeName: [1, 2, 3],
              nodeValue: [0, 0, 0],
              parentIndex: [-1, 0, 1],
              attributes: [[], [4, 99], [6, 7]],
            },
          },
        ],
      },
      new Set([origin]),
      completeness,
    );
    let captured = generator.next([]);
    while (!captured.done) captured = generator.next([]);

    expect(captured.value.nodes.map((node) => node.index)).toEqual([0, 2]);
    expect(captured.value.nodes[1]?.attribute_names).toEqual(["xlink:href"]);
    expect(captured.value.urls).toEqual([]);
    expect(
      completeness
        .snapshot()
        .excluded.some(
          ({ section, reason }) =>
            section === "metadata" && reason === "invalid_protocol_value",
        ),
    ).toBe(true);
  });
});

describe("CDP frame capture", () => {
  it("walks deeply nested frame trees and returns every frame and resource", () => {
    const rootIndex = 1_999;
    let frameTree: Record<string, unknown> = {
      frame: { id: "frame-0", parentId: "frame-1", url: `${origin}/0` },
      resources: [
        { url: `${origin}/0.js`, type: "Script", mimeType: "text/javascript" },
      ],
    };
    for (let index = 1; index <= rootIndex; index += 1) {
      frameTree = {
        frame: {
          id: `frame-${index}`,
          ...(index === rootIndex ? {} : { parentId: `frame-${index + 1}` }),
          url: `${origin}/${index}`,
        },
        resources: [
          {
            url: `${origin}/${String(index)}.js`,
            type: "Script",
            mimeType: "text/javascript",
          },
        ],
        childFrames: [frameTree],
      };
    }
    const result = { frameTree };
    const frames = captureFrames(frameTreeReply(result), new Set([origin]));
    const resources = captureResources(
      resourceTreeReply(result),
      new Set([origin]),
    );
    const frameIndexes = Array.from(
      { length: rootIndex + 1 },
      (_, index) => rootIndex - index,
    );
    expect(frames.items).toEqual(
      frameIndexes.map((index) => ({
        frame_id: `frame-${index}`,
        parent_frame_id: index === rootIndex ? null : `frame-${index + 1}`,
        url: `${origin}/${index}`,
        origin,
      })),
    );
    expect(resources.items.map(({ url }) => url)).toEqual(
      frameIndexes.map((index) => `${origin}/${index}.js`),
    );
  });
});
