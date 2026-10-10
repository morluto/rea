import { describe, expect, it } from "vitest";
import { buildBinary, parseBinary } from "plist";

import {
  buildInterfaceBuilderAnalysis,
  interfaceBuilderLimitsSchema,
} from "./interfaceBuilderGraph.js";
import { parseInterfaceBuilderRecords } from "./interfaceBuilderKeyedArchive.js";

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
      limits: interfaceBuilderLimitsSchema.parse({ max_objects: 3 }),
    });
    expect(result.graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "target_action",
        resolution: "unresolved",
        reason: "endpoint_omitted_by_object_limit",
        evidence: [
          expect.objectContaining({
            kind: "interface_builder_resource",
            artifact_path: "Legacy.nib",
            artifact_sha256: hash,
          }),
        ],
      }),
    );
    const retainedNodes = new Set(result.graph.nodes.map(({ id }) => id));
    expect(
      result.graph.edges.every(
        ({ from, to }) =>
          retainedNodes.has(from) && (to === null || retainedNodes.has(to)),
      ),
    ).toBe(true);
    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "graph_nodes",
        status: "partial",
        reason: "max_objects_reached",
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

describe("Interface Builder parser bounds", () => {
  it("reports connections discarded by the parser's hard ceiling", () => {
    const connections = Array.from({ length: 40_001 }, (_, index) => ({
      type: "custom-connection",
      label: `action${String(index)}:`,
    }));
    const raw = {
      "com.apple.ibtool.document.objects": {
        button: { class: "UIButton" },
      },
      "com.apple.ibtool.document.connections": { button: connections },
    };
    const parsed = parseInterfaceBuilderRecords(raw);
    expect(parsed.connections).toHaveLength(40_000);
    expect(parsed.omittedConnections).toBe(1);

    const result = buildInterfaceBuilderAnalysis({
      targetSha256: hash,
      toolVersion: "test",
      documents: [
        {
          relativePath: "Main.storyboardc/scene.nib",
          archiveSha256: hash,
          documentKind: "storyboard_scene",
          raw,
        },
      ],
      limits: interfaceBuilderLimitsSchema.parse({}),
    });
    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "connections:Main.storyboardc/scene.nib",
        status: "partial",
        omitted: 1,
      }),
    );
  });
});

describe("keyed archive decoding and graph limits", () => {
  it("preserves keyed archive UID identities, arrays, and control actions", () => {
    const parsed = parseInterfaceBuilderRecords({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: [
        "$null",
        {
          subviews: [{ UID: 2 }],
          $class: { UID: 5 },
        },
        { $class: { UID: 6 } },
        { $class: { UID: 7 } },
        {
          source: { UID: 3 },
          destination: { UID: 2 },
          label: "runAction:",
          $class: { UID: 8 },
        },
        { $classname: "UIView", $classes: ["UIView", "NSObject"] },
        { $classname: "UIButton", $classes: ["UIButton", "UIView"] },
        {
          $classname: "ViewController",
          $classes: ["ViewController", "NSObject"],
        },
        {
          $classname: "NSNibControlConnector",
          $classes: ["NSNibControlConnector", "NSObject"],
        },
        [{ UID: 1 }],
      ],
      $top: { root: { UID: 9 } },
    });

    expect(parsed.objects.map(({ id }) => id)).toContain("2");
    expect(parsed.hierarchy).toMatchObject([
      {
        objectID: "1",
        children: [{ objectID: "2" }],
      },
    ]);
    expect(parsed.connections).toContainEqual(
      expect.objectContaining({
        kind: "action",
        source_id: "2",
        destination_id: "3",
        label: "runAction:",
      }),
    );
  });

  it("reports records omitted by the parser's hard object ceiling", () => {
    const objects = Object.fromEntries(
      Array.from({ length: 20_001 }, (_, index) => [
        `object-${index}`,
        { class: "UIView" },
      ]),
    );
    const parsed = parseInterfaceBuilderRecords({
      "com.apple.ibtool.document.objects": objects,
    });

    expect(parsed.objects).toHaveLength(20_000);
    expect(parsed.objectCount).toBe(20_001);
    expect(parsed.omittedObjects).toBe(1);
  });

  it("keeps hierarchy edges out of the connection edge budget", () => {
    const relativePath = "Main.nib";
    const result = buildInterfaceBuilderAnalysis({
      targetSha256: hash,
      toolVersion: "test",
      documents: [
        {
          relativePath,
          archiveSha256: hash,
          documentKind: "nib",
          raw: {
            "com.apple.ibtool.document.objects": {
              button: { class: "UIButton" },
              controller: { customClass: "MainViewController" },
              parent: { class: "UIView" },
              child: { class: "UIView" },
            },
            "com.apple.ibtool.document.connections": {
              button: [
                {
                  type: "action",
                  label: "run:",
                  destinationId: "controller",
                },
              ],
            },
            "com.apple.ibtool.document.hierarchy": [
              {
                objectID: "parent",
                children: [
                  { objectID: "child", children: [{ objectID: "button" }] },
                ],
              },
            ],
          },
        },
      ],
      limits: interfaceBuilderLimitsSchema.parse({
        max_objects: 20,
        max_connections: 1,
      }),
    });

    expect(
      result.graph.edges.filter(({ relation }) => relation === "target_action"),
    ).toHaveLength(3);
    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: `connections:${relativePath}`,
        status: "complete",
        omitted: 0,
      }),
    );
  });
});

describe("keyed archive object references", () => {
  it("keeps referenced objects as stubs so shared and cyclic references stay finite", () => {
    // Each view references its window, superview, and next key view, so
    // inlining references would expand the table into an exponential tree.
    const viewCount = 40;
    const views = Array.from({ length: viewCount }, (_, index) => ({
      $class: { UID: 1 },
      NSWindow: { UID: 2 },
      NSSuperview: { UID: index === 0 ? 2 : 3 + index - 1 },
      NSNextKeyView: { UID: 3 + ((index + 1) % viewCount) },
      NSSubviews: index + 1 < viewCount ? [{ UID: 3 + index + 1 }] : [],
      NSTitle: { UID: 3 + viewCount },
    }));
    const parsed = parseInterfaceBuilderRecords({
      $archiver: "NSKeyedArchiver",
      $objects: [
        "$null",
        { $classname: "NSView", $classes: ["NSView", "NSObject"] },
        { $class: { UID: 3 + viewCount + 1 }, NSContentView: { UID: 3 } },
        ...views,
        "Title",
        { $classname: "NSWindow", $classes: ["NSWindow", "NSObject"] },
      ],
      $top: { root: { UID: 2 } },
    });

    expect(parsed.objects).toHaveLength(viewCount + 1);
    const view = parsed.objects.find(({ id }) => id === "3");
    expect(view?.name).toBe("NSView");
    expect(view?.attributes).toEqual({
      NSWindow: { archiveUID: 2, className: "NSWindow" },
      NSSuperview: { archiveUID: 2, className: "NSWindow" },
      NSNextKeyView: { archiveUID: 4, className: "NSView" },
      NSSubviews: [{ archiveUID: 4, className: "NSView" }],
      NSTitle: "Title",
    });
    expect(parsed.hierarchy).toMatchObject([
      {
        objectID: "2",
        children: [{ objectID: "3", children: [{ objectID: "4" }] }],
      },
    ]);
  });

  it("resolves XML CF$UID references and the archived nil", () => {
    const parsed = parseInterfaceBuilderRecords({
      $archiver: "NSKeyedArchiver",
      $objects: [
        "$null",
        {
          $class: { CF$UID: 3 },
          NSSource: { CF$UID: 2 },
          source: { CF$UID: 2 },
          destination: { CF$UID: 0 },
          label: { CF$UID: 4 },
        },
        { $class: { CF$UID: 5 } },
        {
          $classname: "NSNibOutletConnector",
          $classes: ["NSNibOutletConnector", "NSObject"],
        },
        { $class: { CF$UID: 6 }, "NS.string": "delegate" },
        { $classname: "NSButton", $classes: ["NSButton", "NSObject"] },
        {
          $classname: "NSMutableString",
          $classes: ["NSMutableString", "NSString", "NSObject"],
        },
      ],
      $top: {},
    });

    expect(parsed.connections).toEqual([
      expect.objectContaining({
        kind: "outlet",
        source_id: "2",
        destination_id: null,
        label: "delegate",
      }),
    ]);
    expect(parsed.objects.find(({ id }) => id === "2")).toMatchObject({
      class_name: "NSButton",
    });
  });
});

describe("AppKit keyed archive connectors", () => {
  it("reads outlet and control connectors from NS-prefixed keys", () => {
    const parsed = parseInterfaceBuilderRecords({
      $archiver: "NSKeyedArchiver",
      $objects: [
        "$null",
        { $class: { UID: 6 } },
        { $class: { UID: 7 }, identifier: "unrelated-identifier" },
        {
          $class: { UID: 8 },
          NSSource: { UID: 1 },
          NSDestination: { UID: 2 },
          NSLabel: { UID: 5 },
        },
        {
          $class: { UID: 9 },
          NSSource: { UID: 2 },
          NSDestination: { UID: 1 },
          NSLabel: { UID: 10 },
        },
        "o_button",
        {
          $classname: "NSCustomObject",
          $classes: ["NSCustomObject", "NSObject"],
        },
        { $classname: "NSButton", $classes: ["NSButton", "NSObject"] },
        {
          $classname: "NSNibOutletConnector",
          $classes: ["NSNibOutletConnector", "NSNibConnector", "NSObject"],
        },
        {
          $classname: "NSNibControlConnector",
          $classes: ["NSNibControlConnector", "NSNibConnector", "NSObject"],
        },
        "buttonClicked:",
      ],
      $top: {},
    });

    expect(parsed.connections).toEqual([
      expect.objectContaining({
        kind: "outlet",
        source_id: "1",
        destination_id: "2",
        label: "o_button",
      }),
      expect.objectContaining({
        kind: "action",
        source_id: "2",
        destination_id: "1",
        label: "buttonClicked:",
      }),
    ]);
  });

  it("projects an AppKit action from the control through the selector to its target", () => {
    const analysis = buildInterfaceBuilderAnalysis({
      targetSha256: hash,
      toolVersion: "test",
      documents: [
        {
          relativePath: "MainMenu.nib",
          archiveSha256: hash,
          documentKind: "nib",
          raw: {
            $archiver: "NSKeyedArchiver",
            $objects: [
              "$null",
              { $class: { UID: 4 } },
              { $class: { UID: 5 } },
              {
                $class: { UID: 6 },
                NSSource: { UID: 2 },
                NSDestination: { UID: 1 },
                NSLabel: "buttonClicked:",
              },
              { $classname: "BuildDelegate", $classes: ["NSObject"] },
              { $classname: "NSButton", $classes: ["NSButton", "NSObject"] },
              {
                $classname: "NSNibControlConnector",
                $classes: ["NSNibControlConnector", "NSObject"],
              },
            ],
            $top: {},
          },
        },
      ],
      limits: interfaceBuilderLimitsSchema.parse({}),
    });
    const byId = new Map(analysis.graph.nodes.map((node) => [node.id, node]));
    const action = analysis.graph.nodes.find(({ kind }) => kind === "action");
    const from = analysis.graph.edges
      .filter(
        ({ to, relation }) => relation === "target_action" && to === action?.id,
      )
      .map(({ from: id }) => byId.get(id)?.name);
    const to = analysis.graph.edges
      .filter(
        ({ from: id, relation }) =>
          relation === "target_action" && id === action?.id,
      )
      .map(({ to: id }) => (id === null ? null : byId.get(id)?.kind));
    expect(from).toEqual(["NSButton"]);
    expect(to).toEqual(expect.arrayContaining(["objc_selector", "unknown"]));
  });
});

it("names the archive once per evidence record", () => {
  const relativePath = "Views/Main.storyboardc/scene.nib/objects.nib";
  const result = buildInterfaceBuilderAnalysis({
    targetSha256: hash,
    toolVersion: "test",
    documents: [
      {
        relativePath,
        archiveSha256: hash,
        documentKind: "storyboard_scene",
        raw: {
          "com.apple.ibtool.document.objects": {
            controller: { customClass: "StoreViewController" },
            next: { customClass: "BuildViewController" },
          },
          "com.apple.ibtool.document.connections": {
            controller: [
              { type: "segue", identifier: "showBuild", destinationId: "next" },
            ],
          },
        },
      },
    ],
    limits: interfaceBuilderLimitsSchema.parse({}),
  });
  const evidence = [...result.graph.nodes, ...result.graph.edges].flatMap(
    (item) => item.evidence,
  );
  expect(new Set(evidence.map(({ artifact_path }) => artifact_path))).toEqual(
    new Set([relativePath]),
  );
  expect(evidence.map(({ description }) => description)).toEqual(
    expect.arrayContaining([
      "compiled document",
      "object controller",
      "segue showBuild",
    ]),
  );
  expect(
    evidence.filter(({ description }) => description.includes(relativePath)),
  ).toEqual([]);
});
