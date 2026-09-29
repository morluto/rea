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
    const nib = join(bundle, "Contents", "Resources", "Main.storyboardc", "Main.nib");
    await mkdir(nib, { recursive: true });
    await writeFile(
      join(nib, "objects.nib"),
      buildBinary({
        $archiver: "NSKeyedArchiver",
        $version: 100000,
        $objects: [
          "$null",
          { $class: { UID: 2 }, title: "Build" },
          { $classname: "UIButton", $classes: ["UIButton", "UIControl", "UIView", "NSObject"] },
        ],
        $top: { root: { UID: 1 } },
      }),
    );
    await writeFile(
      join(bundle, "Contents", "Resources", "Main.storyboardc", "Info.plist"),
      "<?xml version=\"1.0\"?><plist><dict><key>notAnArchive</key><string>scene-index</string></dict></plist>",
    );
    await mkdir(join(bundle, "Contents", "Resources", "outside.nib"), {
      recursive: true,
    });
    await writeFile(join(bundle, "Contents", "Resources", "outside.nib", "not-nib.txt"), "ignored");

    const analysis = await analyzeInterfaceBuilderBundle({
      bundlePath: bundle,
      targetSha256: "b".repeat(64),
    });
    expect(analysis.documents).toMatchObject([
      {
        relative_path: "Contents/Resources/Main.storyboardc/Main.nib/objects.nib",
        document_kind: "storyboard_scene",
        object_count: 1,
      },
    ]);
    expect(analysis.documents).toHaveLength(1);
    expect(analysis.graph.target_sha256).toBe("b".repeat(64));
    expect(analysis.graph.nodes.some(({ name }) => name === "Build")).toBe(true);
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
});
