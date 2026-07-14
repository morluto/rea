import { describe, expect, it } from "vitest";

import {
  captureAccessibility,
  captureDom,
  captureFrames,
  captureResources,
} from "../src/browser/CdpCaptureDocuments.js";
import { inspectWebPageInputSchema } from "../src/domain/browserObservation.js";

const origin = "https://app.example.test";

describe("CDP document capture", () => {
  it("walks deeply nested frame trees iteratively and retains a bounded prefix", () => {
    let frameTree: Record<string, unknown> = {
      frame: { id: "frame-0", url: `${origin}/0` },
      resources: [{ url: `${origin}/0.js`, type: "Script" }],
    };
    for (let index = 1; index < 2_000; index += 1) {
      frameTree = {
        frame: {
          id: `frame-${String(index)}`,
          url: `${origin}/${String(index)}`,
        },
        resources: [{ url: `${origin}/${String(index)}.js`, type: "Script" }],
        childFrames: [frameTree],
      };
    }
    const result = { frameTree };
    const frames = captureFrames(result, new Set([origin]), 3);
    const resources = captureResources(result, new Set([origin]), 2);
    expect(frames).toMatchObject({ total: 2_000 });
    expect(frames.items).toHaveLength(3);
    expect(resources).toMatchObject({ total: 2_000 });
    expect(resources.items).toHaveLength(2);
  });

  it("rebases parent indexes when allowed DOM documents are combined", () => {
    const input = inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: [origin],
      target_id: "page-1",
      approved: true,
    });
    const snapshot = {
      strings: [`${origin}/main`, `${origin}/frame`, "#document", "DIV", ""],
      documents: [
        {
          documentURL: 0,
          nodes: {
            nodeType: [9, 1],
            nodeName: [2, 3],
            nodeValue: [4, 4],
            parentIndex: [-1, 0],
            attributes: [[], []],
          },
        },
        {
          documentURL: 1,
          nodes: {
            nodeType: [9, 1],
            nodeName: [2, 3],
            nodeValue: [4, 4],
            parentIndex: [-1, 0],
            attributes: [[], []],
          },
        },
      ],
    };
    const capture = captureDom(snapshot, new Set([origin]), input);
    expect(capture.nodes.map((node) => node.parent_index)).toEqual([
      -1, 0, -1, 2,
    ]);
  });

  it("bounds approved accessibility text by UTF-8 bytes without splitting characters", () => {
    const capture = captureAccessibility(
      [
        {
          nodes: [
            {
              nodeId: "node-1",
              role: { value: "button" },
              name: { value: "😀a" },
              description: { value: "éé" },
            },
          ],
        },
      ],
      10,
      {
        includeText: true,
        maximumFieldBytes: 4,
        maximumTotalBytes: 7,
      },
    );

    expect(capture.nodes[0]).toMatchObject({ name: "😀", description: "é" });
    expect(capture.textCapture).toEqual({
      status: "truncated",
      retained_bytes: 6,
      excluded_fields: 0,
      truncated_fields: 2,
    });
  });

  it("counts accessibility fields omitted without text approval", () => {
    const capture = captureAccessibility(
      [
        {
          nodes: [
            {
              nodeId: "node-1",
              name: { value: "private name" },
              description: { value: "private description" },
            },
          ],
        },
      ],
      10,
      {
        includeText: false,
        maximumFieldBytes: 1_024,
        maximumTotalBytes: 64 * 1_024,
      },
    );

    expect(capture.nodes[0]).toMatchObject({ name: null, description: null });
    expect(capture.textCapture).toEqual({
      status: "not_approved",
      retained_bytes: 0,
      excluded_fields: 2,
      truncated_fields: 0,
    });
  });
});
