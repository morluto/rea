import { describe, expect, it } from "vitest";
import { buildBinary, parseBinary } from "plist";

import {
  buildInterfaceBuilderAnalysis,
  interfaceBuilderLimitsSchema,
  parseInterfaceBuilderRecords,
} from "./interfaceBuilderGraph.js";

const hash = "a".repeat(64);

describe("compiled Interface Builder graph projection", () => {
  it("normalizes object, hierarchy, action, outlet, and segue facts", () => {
    const raw = {
      "com.apple.ibtool.document.objects": {
        controller: { customClass: "StoreViewController", label: "Store" },
        button: { class: "UIButton", title: "Build" },
        next: { customClass: "BuildViewController" },
      },
      "com.apple.ibtool.document.connections": {
        button: [
          {
            type: "action",
            label: "buildTapped:",
            destinationId: "controller",
          },
          { type: "segue", identifier: "showBuild", destinationId: "next" },
        ],
        controller: [
          { type: "outlet", label: "buildButton", destinationId: "button" },
        ],
      },
      "com.apple.ibtool.document.hierarchy": [
        { objectID: "controller", children: [{ objectID: "button" }] },
      ],
      "com.apple.ibtool.document.classes": { StoreViewController: {} },
    };
    const decoded = parseInterfaceBuilderRecords(raw);
    expect(decoded.objects).toHaveLength(3);
    expect(decoded.connections.map(({ kind }) => kind)).toEqual([
      "action",
      "segue",
      "outlet",
    ]);
    const result = buildInterfaceBuilderAnalysis({
      targetSha256: hash,
      toolVersion: "test",
      documents: [
        {
          relativePath: "Views/Main.storyboardc/scene.nib/objects.nib",
          archiveSha256: hash,
          documentKind: "storyboard_scene",
          raw,
        },
      ],
      limits: interfaceBuilderLimitsSchema.parse({}),
    });
    expect(result.graph.nodes.some(({ name }) => name === "buildTapped:")).toBe(
      true,
    );
    expect(result.graph.nodes[0]?.evidence[0]).toMatchObject({
      artifact_path: "Views/Main.storyboardc/scene.nib/objects.nib",
      artifact_sha256: hash,
    });
    expect(result.graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "segue_to",
        resolution: "observed",
      }),
    );
    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "hierarchy:Views/Main.storyboardc/scene.nib/objects.nib",
        status: "complete",
      }),
    );
  });

  it("keeps missing external destinations as unresolved evidence", () => {
    const result = buildInterfaceBuilderAnalysis({
      targetSha256: hash,
      toolVersion: "test",
      documents: [
        {
          relativePath: "Legacy.nib",
          archiveSha256: hash,
          documentKind: "nib",
          raw: {
            "com.apple.ibtool.document.objects": {
              button: { class: "UIButton" },
            },
            "com.apple.ibtool.document.connections": {
              button: [
                { type: "action", label: "save:", destinationId: "external" },
              ],
            },
          },
        },
      ],
      limits: interfaceBuilderLimitsSchema.parse({ max_objects: 1 }),
    });
    expect(result.graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "target_action",
        resolution: "unresolved",
        reason: "destination_object_missing_or_external",
        evidence: [
          expect.objectContaining({
            kind: "interface_builder_resource",
            artifact_path: "Legacy.nib",
            artifact_sha256: hash,
          }),
        ],
      }),
    );
    expect(result.graph.truncated).toBe(true);
  });

  it("reads recognized objects from a compiled NSKeyedArchiver object table", () => {
    const bytes = buildBinary({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: [
        "$null",
        { $class: { UID: 2 }, title: "Build", identifier: "build-button" },
        {
          $classname: "UIButton",
          $classes: ["UIButton", "UIControl", "UIView", "NSObject"],
        },
      ],
      $top: { root: { UID: 1 } },
    });
    const parsed = parseInterfaceBuilderRecords(parseBinary(bytes));
    expect(parsed.objects).toMatchObject([
      {
        id: "1",
        kind: "control",
        class_name: "UIButton",
        name: "Build",
      },
    ]);
  });
});
