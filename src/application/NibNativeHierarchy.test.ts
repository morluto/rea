import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { decodeNibArchive } from "../artifacts/NibArchive.js";
import { analyzeInterfaceBuilderBundle } from "./InterfaceBuilderAnalysis.js";

const compileNestedViews = async (depth: number, withWindow = false) => {
  const root = await createTestTempDirectory("rea-nib-hierarchy-");
  const bundle = join(root, "Fixture.app");
  const resources = join(bundle, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  const source = await readFile(
    "tests/conformance/interface-builder/Main.xib",
    "utf8",
  );
  const nested =
    Array.from(
      { length: depth },
      (_, i) =>
        `<view id="nested-${i}" customClass="NSView"><rect key="frame" x="0" y="0" width="100" height="100"/><subviews>`,
    ).join("") + "</subviews></view>".repeat(depth);
  const xib = join(root, "Nested.xib");
  let xibSource = source.replace("</subviews>", `${nested}</subviews>`);
  if (withWindow)
    xibSource = xibSource
      .replace(
        '<view id="view" customClass="NSView">',
        '<window title="Example" id="window"><windowStyleMask key="styleMask" titled="YES" closable="YES"/><rect key="contentRect" x="0" y="0" width="480" height="320"/><view key="contentView" id="view" customClass="NSView">',
      )
      .replace("</view>\n  </objects>", "</view></window>\n  </objects>");
  await writeFile(xib, xibSource);
  const nib = join(resources, "Main.nib");
  execFileSync("/usr/bin/xcrun", [
    "ibtool",
    "--errors",
    "--warnings",
    "--compile",
    nib,
    xib,
  ]);
  return { bundle, archive: decodeNibArchive(await readFile(nib)) };
};

describe.skipIf(process.platform !== "darwin")(
  "native compiled NIB view hierarchy",
  () => {
    it.each([4, 40])(
      "recovers every serialized superview link for %i nested views",
      async (depth) => {
        const { bundle, archive } = await compileNestedViews(depth);
        const result = await analyzeInterfaceBuilderBundle({
          bundlePath: bundle,
          targetSha256: "a".repeat(64),
        });
        const parents = archive.objects.flatMap(({ id, values }) => {
          const parent = values.NSSuperview;
          return typeof parent === "object" &&
            parent !== null &&
            !Array.isArray(parent) &&
            typeof parent.$nib_object_ref === "number"
            ? [{ child: String(id), parent: String(parent.$nib_object_ref) }]
            : [];
        });
        expect(parents).toHaveLength(depth + 1);
        for (const pair of parents) {
          const child = result.graph.nodes.find(
            ({ attributes }) =>
              attributes.interface_builder_object_id === pair.child,
          );
          const parent = result.graph.nodes.find(
            ({ attributes }) =>
              attributes.interface_builder_object_id === pair.parent,
          );
          expect(child).toBeDefined();
          expect(parent).toBeDefined();
          expect(
            result.graph.edges.some(
              ({ from, to, relation }) =>
                from === parent?.id &&
                to === child?.id &&
                relation === "contains",
            ),
          ).toBe(true);
        }
        expect(result.documents[0]?.hierarchy_complete).toBe(true);
        expect(result.graph.truncated).toBe(false);
      },
    );

    it("retains the native window-to-content-view relation alongside superview links", async () => {
      const { bundle, archive } = await compileNestedViews(4, true);
      const result = await analyzeInterfaceBuilderBundle({
        bundlePath: bundle,
        targetSha256: "c".repeat(64),
      });
      const window = archive.objects.find(
        ({ class_name }) => class_name === "NSWindowTemplate",
      );
      const content = window?.values.NSWindowView;
      if (
        window === undefined ||
        typeof content !== "object" ||
        content === null ||
        Array.isArray(content)
      )
        throw new Error("native window content link missing");
      const windowNode = result.graph.nodes.find(
        ({ attributes }) =>
          attributes.interface_builder_object_id === String(window.id),
      );
      const viewNode = result.graph.nodes.find(
        ({ attributes }) =>
          attributes.interface_builder_object_id ===
          String(content.$nib_object_ref),
      );
      expect(windowNode).toBeDefined();
      expect(viewNode).toBeDefined();
      expect(
        result.graph.edges.some(
          ({ from, to, relation }) =>
            from === windowNode?.id &&
            to === viewNode?.id &&
            relation === "contains",
        ),
      ).toBe(true);
      expect(result.documents[0]?.hierarchy_complete).toBe(true);
      expect(result.graph.truncated).toBe(false);
    });

    it("reports partial coverage for a native hierarchy beyond the projection depth bound", async () => {
      const { bundle } = await compileNestedViews(132);
      const result = await analyzeInterfaceBuilderBundle({
        bundlePath: bundle,
        targetSha256: "d".repeat(64),
      });
      expect(result.documents[0]?.hierarchy_complete).toBe(false);
      expect(result.graph.truncated).toBe(true);
      expect(result.graph.coverage).toContainEqual(
        expect.objectContaining({
          facet: "hierarchy:Contents/Resources/Main.nib",
          status: "partial",
          reason: "serialized_view_hierarchy_incomplete",
          omitted: expect.any(Number),
        }),
      );
      expect(
        result.graph.coverage.find(
          ({ facet }) => facet === "hierarchy:Contents/Resources/Main.nib",
        )?.omitted,
      ).toBeGreaterThan(0);
    });

    it.each([false, true])(
      "reports partial hierarchy at the object budget (window=%s)",
      async (withWindow) => {
        const { bundle } = await compileNestedViews(4, withWindow);
        const result = await analyzeInterfaceBuilderBundle({
          bundlePath: bundle,
          targetSha256: "b".repeat(64),
          limits: { max_objects: 2 },
        });
        expect(result.documents[0]?.hierarchy_complete).toBe(false);
        expect(result.graph.truncated).toBe(true);
        expect(result.graph.coverage).toContainEqual(
          expect.objectContaining({
            facet: "hierarchy:Contents/Resources/Main.nib",
            status: "partial",
          }),
        );
      },
    );
  },
);
