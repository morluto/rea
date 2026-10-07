import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildBinary } from "plist";
import { describe, expect, it } from "vitest";

import { analyzeInterfaceBuilderBundle } from "../../../src/application/InterfaceBuilderAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const compile = promisify(execFile);

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
