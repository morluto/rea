import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBinary } from "plist";
import { afterEach, describe, expect, it } from "vitest";

import { analyzeInterfaceBuilderBundle } from "./InterfaceBuilderAnalysis.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("compiled Interface Builder bundle reader", () => {
  it("reads nib plist archives without following symlinks and reports provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-ib-test-"));
    roots.push(root);
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

  it("honors cancellation during directory traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-ib-test-"));
    roots.push(root);
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

  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/ibtool"))(
    "decodes an Xcode-compiled storyboard NIB and recovers its UI routes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "rea-ib-compiled-test-"));
      roots.push(root);
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
      execFileSync("/usr/bin/ibtool", [
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
      expect(actionSource).toBeDefined();
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
