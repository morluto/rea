import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildBinary } from "plist";
import { describe, expect, it } from "vitest";

import { analyzeInterfaceBuilderBundle } from "../../../src/artifacts/apple/InterfaceBuilderAnalysis.js";
import { encodeNibArchiveFixture } from "../../../src/artifacts/apple/NibArchive.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const compile = promisify(execFile);

type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue }
  | null;

const keyedArchiveHierarchy = (
  nodes: readonly {
    readonly id: string;
    readonly children: readonly number[];
  }[],
) => {
  const nodeClass = 1 + nodes.length * 2;
  const arrayClass = nodeClass + 1;
  const objects: PlistValue[] = Array.from(
    { length: arrayClass + 1 },
    () => null,
  );
  objects[0] = "$null";
  for (const [index, node] of nodes.entries()) {
    const nodeUid = 1 + index * 2;
    objects[nodeUid] = {
      $class: { UID: nodeClass },
      objectID: node.id,
      children: { UID: nodeUid + 1 },
    };
    objects[nodeUid + 1] = {
      $class: { UID: arrayClass },
      "NS.objects": node.children.map((child) => ({ UID: 1 + child * 2 })),
    };
  }
  objects[nodeClass] = {
    $classname: "FixtureHierarchyNode",
    $classes: ["FixtureHierarchyNode", "NSObject"],
  };
  objects[arrayClass] = {
    $classname: "__NSArrayI",
    $classes: ["__NSArrayI", "NSArray", "NSObject"],
  };
  return buildBinary({
    $archiver: "NSKeyedArchiver",
    $version: 100000,
    $objects: objects,
    $top: { root: { UID: 1 } },
  });
};

describe("compiled Interface Builder bundle reader", () => {
  it("reads nib plist archives and reports provenance", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const nib = join(
      bundle,
      "Contents",
      "Resources",
      "Main.storyboardc",
      "Main.nib",
    );
    await mkdir(nib, { recursive: true });
    await writeFile(
      join(nib, "objects.nib"),
      buildBinary({
        $archiver: "NSKeyedArchiver",
        $version: 100000,
        $objects: [
          "$null",
          { $class: { UID: 2 }, title: "Build" },
          {
            $classname: "UIButton",
            $classes: ["UIButton", "UIControl", "UIView", "NSObject"],
          },
        ],
        $top: { root: { UID: 1 } },
      }),
    );
    await writeFile(
      join(bundle, "Contents", "Resources", "Main.storyboardc", "Info.plist"),
      '<?xml version="1.0"?><plist><dict><key>notAnArchive</key><string>scene-index</string></dict></plist>',
    );
    await mkdir(join(bundle, "Contents", "Resources", "outside.nib"), {
      recursive: true,
    });
    await writeFile(
      join(bundle, "Contents", "Resources", "outside.nib", "not-nib.txt"),
      "ignored",
    );

    const analysis = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "b".repeat(64),
    });
    expect(analysis.documents).toMatchObject([
      {
        relative_path:
          "Contents/Resources/Main.storyboardc/Main.nib/objects.nib",
        document_kind: "storyboard_scene",
        object_count: 1,
      },
    ]);
    expect(analysis.documents).toHaveLength(1);
    expect(analysis.graph.target_sha256).toBe("b".repeat(64));
    expect(analysis.graph.nodes.some(({ name }) => name === "Build")).toBe(
      true,
    );
  });

  it("projects compiled AppKit actions from the control to their target", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    // NSNibControlConnector archives the sending control as NSSource and its
    // target as NSDestination; a nil target is the first responder.
    await writeFile(
      join(resources, "Panel.nib"),
      encodeNibArchiveFixture({
        classes: [
          "NSNibExternalObjectPlaceholder",
          "NSButton",
          "NSNibControlConnector",
          "NSString",
          "NSMenuItem",
        ],
        objects: [
          { classIndex: 0, values: {} },
          { classIndex: 1, values: {} },
          {
            classIndex: 2,
            values: {
              NSSource: { ref: 1 },
              NSDestination: { ref: 0 },
              NSLabel: { ref: 3 },
            },
          },
          { classIndex: 3, values: { "NS.bytes": "doOK:" } },
          { classIndex: 4, values: {} },
          {
            classIndex: 2,
            values: {
              NSSource: { ref: 4 },
              NSDestination: null,
              NSLabel: { ref: 6 },
            },
          },
          { classIndex: 3, values: { "NS.bytes": "arrangeInFront:" } },
        ],
      }),
    );

    const analysis = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "e".repeat(64),
    });
    const byId = new Map(analysis.graph.nodes.map((node) => [node.id, node]));
    const routes = analysis.graph.nodes
      .filter(({ kind }) => kind === "action")
      .map((action) => ({
        action: action.name,
        from: analysis.graph.edges
          .filter(
            ({ relation, to }) =>
              relation === "target_action" && to === action.id,
          )
          .map(({ from }) => byId.get(from)?.name),
        to: analysis.graph.edges
          .filter(
            ({ relation, from, to }) =>
              relation === "target_action" &&
              from === action.id &&
              (to === null || byId.get(to)?.kind !== "objc_selector"),
          )
          .map(({ to }) => (to === null ? null : byId.get(to)?.name)),
      }))
      .sort((left, right) => left.action.localeCompare(right.action));
    expect(routes).toEqual([
      { action: "arrangeInFront:", from: ["NSMenuItem"], to: [null] },
      {
        action: "doOK:",
        from: ["NSButton"],
        to: ["NSNibExternalObjectPlaceholder"],
      },
    ]);
  });
});

describe("keyed archive hierarchy coverage", () => {
  it("projects a deep keyed-archive hierarchy through NSArray wrappers", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    const nodes = Array.from({ length: 40 }, (_, index) => ({
      id: `view-${index}`,
      children: index === 39 ? [] : [index + 1],
    }));
    await writeFile(join(resources, "Deep.nib"), keyedArchiveHierarchy(nodes));

    const analysis = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "f".repeat(64),
    });

    expect(analysis.documents[0]?.hierarchy_complete).toBe(true);
    expect(analysis.graph.truncated).toBe(false);
    expect(analysis.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "hierarchy:Contents/Resources/Deep.nib",
        status: "complete",
        omitted: 0,
      }),
    );
    expect(
      analysis.graph.edges.filter(
        ({ relation, id }) =>
          relation === "contains" && id.includes(":hierarchy:"),
      ),
    ).toHaveLength(40);
  });

  it("preserves source order for children in an archived collection", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(
      join(resources, "Branching.nib"),
      keyedArchiveHierarchy([
        { id: "root", children: [1, 2] },
        { id: "first", children: [] },
        { id: "second", children: [] },
      ]),
    );

    const analysis = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "e".repeat(64),
    });
    const archiveIdsByNodeId = new Map(
      analysis.graph.nodes.map(({ id, attributes }) => [
        id,
        attributes.interface_builder_object_id,
      ]),
    );
    const rootId = analysis.graph.nodes.find(
      ({ attributes }) => attributes.interface_builder_object_id === "root",
    )?.id;
    const childNames = analysis.graph.edges
      .filter(
        ({ from, relation, id }) =>
          from === rootId &&
          relation === "contains" &&
          id.includes(":hierarchy:"),
      )
      .map(({ to }) => (to === null ? null : archiveIdsByNodeId.get(to)));
    expect(childNames).toEqual(["first", "second"]);
  });

  it.skipIf(process.platform !== "darwin")(
    "projects a deep NSView archive produced by Foundation NSKeyedArchiver",
    async () => {
      const root = await createTestTempDirectory("rea-ib-test-");
      const bundle = join(root, "Example.app");
      const resources = join(bundle, "Contents", "Resources");
      await mkdir(resources, { recursive: true });
      const archive = join(resources, "Foundation.nib");
      await compile("/usr/bin/xcrun", [
        "swift",
        "tests/conformance/native/keyed-archive-hierarchy.swift",
        archive,
        "40",
      ]);

      const analysis = await analyzeInterfaceBuilderBundle({
        bundlePath: bundle,
        targetSha256: "d".repeat(64),
      });
      expect(analysis.documents[0]?.hierarchy_complete).toBe(true);
      expect(analysis.graph.truncated).toBe(false);
      expect(
        analysis.graph.coverage.find(
          ({ facet }) =>
            facet === "hierarchy:Contents/Resources/Foundation.nib",
        ),
      ).toMatchObject({ status: "complete", examined: 41, omitted: 0 });
      expect(
        analysis.graph.edges.filter(
          ({ relation, id }) =>
            relation === "contains" && id.includes(":hierarchy:"),
        ),
      ).toHaveLength(41);
    },
  );
});

describe("compiled Interface Builder bundle reader cancellation", () => {
  it("honors cancellation during directory traversal", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeInterfaceBuilderBundle({
        bundlePath: root,
        targetSha256: "c".repeat(64),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });
});

describe("flat Interface Builder plist values", () => {
  it("decodes flat nib archives that hold data and date values", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const resources = join(bundle, "Contents", "Resources", "English.lproj");
    await mkdir(resources, { recursive: true });
    await writeFile(
      join(resources, "Binary.nib"),
      buildBinary({
        $archiver: "NSKeyedArchiver",
        $version: 100000,
        $objects: [
          "$null",
          { $class: { UID: 2 }, title: "Build", NSColor: { UID: 3 } },
          { $classname: "NSButton", $classes: ["NSButton", "NSObject"] },
          { $class: { UID: 4 }, NSWhite: Buffer.from("0.5\0", "ascii") },
          { $classname: "NSColor", $classes: ["NSColor", "NSObject"] },
        ],
        $top: { root: { UID: 1 } },
      }),
    );
    await writeFile(
      join(resources, "Xml.nib"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>$archiver</key><string>NSKeyedArchiver</string><key>$objects</key><array><string>$null</string><dict><key>NSWhite</key><data>MC41AA==</data><key>NSDate</key><date>2026-10-07T00:00:00Z</date></dict></array><key>$top</key><dict/></dict></plist>',
    );

    const analysis = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "d".repeat(64),
    });

    expect(
      analysis.documents.map(({ relative_path }) => relative_path).sort(),
    ).toEqual([
      "Contents/Resources/English.lproj/Binary.nib",
      "Contents/Resources/English.lproj/Xml.nib",
    ]);
    expect(analysis.graph.coverage).toContainEqual(
      expect.objectContaining({ facet: "archive_decode", status: "complete" }),
    );
    expect(analysis.graph.nodes.map(({ name }) => name)).toContain("Build");
  });
});

describe("bounded Interface Builder archive decoding", () => {
  it("counts malformed archives against the document limit", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(join(resources, "BadOne.nib"), Buffer.from("bplist00bad"));
    await writeFile(join(resources, "BadTwo.nib"), Buffer.from("bplist00bad"));

    const result = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "e".repeat(64),
      limits: { max_documents: 1 },
    });

    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "archive_decode",
        status: "partial",
        examined: 1,
        omitted: 1,
      }),
    );
    expect(result.graph.truncated).toBe(true);
  });

  it("marks archive decoding partial when __proto__ entries are omitted", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    const resources = join(bundle, "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    await writeFile(
      join(resources, "Prototype.nib"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>$archiver</key><string>NSKeyedArchiver</string><key>__proto__</key><string>hidden</string><key>$objects</key><array><string>$null</string></array><key>$top</key><dict/></dict></plist>',
    );

    const result = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "f".repeat(64),
    });

    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "archive_decode",
        status: "partial",
        reason: "dictionary_entries_omitted",
      }),
    );
    expect(result.graph.truncated).toBe(true);
    expect(result.limitations).toContain(
      "Contents/Resources/Prototype.nib: 1 dictionary entry keyed __proto__ was omitted because REA results cannot represent that key.",
    );
  });

  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/ibtool"))(
    "decodes an Xcode-compiled storyboard NIB and recovers its UI routes",
    async () => {
      const root = await createTestTempDirectory("rea-ib-compiled-test-");
      const bundle = join(root, "Example.app");
      const resources = join(bundle, "Contents", "Resources");
      const source = join(
        process.cwd(),
        "tests",
        "fixtures",
        "interface-builder",
        "MacFixture.storyboard",
      );
      await mkdir(resources, { recursive: true });
      await compile("/usr/bin/ibtool", [
        "--compile",
        join(resources, "MacFixture.storyboardc"),
        source,
      ]);

      const analysis = await analyzeInterfaceBuilderBundle({
        bundlePath: bundle,
        targetSha256: "d".repeat(64),
      });
      const names = analysis.graph.nodes.map(({ name }) => name);
      expect(names).toContain("BuildViewController");
      expect(names).toContain("Button");
      expect(names).toContain("buildTapped:");
      expect(
        analysis.graph.edges.some(
          ({ relation }) => relation === "target_action",
        ),
      ).toBe(true);
      const action = analysis.graph.nodes.find(
        ({ kind, name }) => kind === "action" && name === "buildTapped:",
      );
      expect(action).toBeDefined();
      const actionSource = analysis.graph.edges.find(
        ({ from, relation, to }) =>
          relation === "target_action" &&
          to === action?.id &&
          analysis.graph.nodes.find(({ id }) => id === from)?.kind ===
            "control",
      );
      const describeNode = (id: string | null) => {
        const node = analysis.graph.nodes.find((item) => item.id === id);
        return node === undefined ? String(id) : `${node.kind}:${node.name}`;
      };
      const actionRoutes = analysis.graph.edges
        .filter(
          ({ relation, from, to }) =>
            relation === "target_action" &&
            (from === action?.id || to === action?.id),
        )
        .map(({ from, to }) => `${describeNode(from)} -> ${describeNode(to)}`);
      expect(actionSource, actionRoutes.join("; ")).toBeDefined();
      expect(
        analysis.graph.edges.some(
          ({ from, relation, to }) =>
            from === action?.id &&
            relation === "target_action" &&
            to !== null &&
            analysis.graph.nodes.find(({ id }) => id === to)?.kind ===
              "placeholder",
        ),
      ).toBe(true);
      expect(
        analysis.graph.edges.some(({ relation }) => relation === "contains"),
      ).toBe(true);
      expect(analysis.graph.coverage).toContainEqual(
        expect.objectContaining({
          facet: "archive_decode",
          status: "complete",
        }),
      );
    },
  );
});

describe("compiled UIKit NIB connections", () => {
  it("projects UIKit runtime outlet and event connections", async () => {
    const root = await createTestTempDirectory("rea-ib-test-");
    const bundle = join(root, "Example.app");
    await mkdir(bundle, { recursive: true });
    await writeFile(
      join(bundle, "Cell.nib"),
      encodeNibArchiveFixture({
        classes: [
          "UIProxyObject",
          "UIClassSwapper",
          "UIButton",
          "UIRuntimeEventConnection",
          "UIRuntimeOutletConnection",
          "NSString",
        ],
        objects: [
          { classIndex: 0, values: { UIProxiedObjectIdentifier: { ref: 5 } } },
          { classIndex: 1, values: { UIClassName: { ref: 6 } } },
          { classIndex: 2, values: {} },
          {
            classIndex: 3,
            values: {
              UISource: { ref: 2 },
              UIDestination: { ref: 1 },
              UILabel: { ref: 7 },
              UIEventMask: 64,
            },
          },
          {
            classIndex: 4,
            values: {
              UISource: { ref: 1 },
              UIDestination: { ref: 2 },
              UILabel: { ref: 8 },
            },
          },
          { classIndex: 5, values: { "NS.bytes": "IBFilesOwner" } },
          { classIndex: 5, values: { "NS.bytes": "BuildCell" } },
          { classIndex: 5, values: { "NS.bytes": "buildTapped:" } },
          { classIndex: 5, values: { "NS.bytes": "buildButton" } },
        ],
      }),
    );

    const analysis = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "e".repeat(64),
    });
    const byId = new Map(analysis.graph.nodes.map((node) => [node.id, node]));
    const named = (id: string | null) =>
      id === null ? null : (byId.get(id)?.name ?? null);
    const action = analysis.graph.nodes.find(({ kind }) => kind === "action");
    expect(action).toMatchObject({
      name: "buildTapped:",
      attributes: { ui_event_mask: 64 },
    });
    const actionEdges = analysis.graph.edges.filter(
      ({ relation }) => relation === "target_action",
    );
    expect(
      actionEdges
        .filter(({ to }) => to === action?.id)
        .map(({ from }) => named(from)),
    ).toEqual(["UIButton"]);
    expect(
      actionEdges
        .filter(({ from }) => from === action?.id)
        .map(({ to }) => named(to)),
    ).toEqual(expect.arrayContaining(["BuildCell"]));
    const outlet = analysis.graph.nodes.find(({ kind }) => kind === "outlet");
    expect(outlet?.name).toBe("buildButton");
    expect(
      analysis.graph.edges
        .filter(
          ({ relation, from }) =>
            relation === "outlet_to" && from === outlet?.id,
        )
        .map(({ to }) => named(to)),
    ).toEqual(["UIButton"]);
    expect(
      analysis.graph.nodes.find(({ name }) => name === "IBFilesOwner")?.kind,
    ).toBe("placeholder");
    expect(analysis.graph.nodes.map(({ name }) => name)).not.toContain(
      "UIRuntimeEventConnection",
    );
  });
});
