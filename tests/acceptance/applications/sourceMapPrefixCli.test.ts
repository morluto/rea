import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "recovers retained prefixed source-map originals and byte identity through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-retained-map-prefix-");
    const original = "export const answer: number = 42;";
    const mapText = `\uFEFF)]}'retained response\r\n${JSON.stringify({
      version: 3,
      sources: ["original.ts"],
      sourcesContent: [original],
      names: [],
      mappings: "AAAA",
    })}`;
    const mapPath = join(root, "bundle.js.map");
    await writeFile(
      join(root, "bundle.js"),
      "export const answer = 42;\n//# sourceMappingURL=bundle.js.map\n",
    );
    await writeFile(mapPath, mapText);

    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const mapDigest = createHash("sha256").update(mapText).digest("hex");
    const originalDigest = createHash("sha256").update(original).digest("hex");
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        kind: "source-module",
        identity: expect.objectContaining({
          strategy: "source-map-original",
          source_map_sha256: mapDigest,
          original_source: "original.ts",
          source_sha256: originalDigest,
        }),
        observations: expect.arrayContaining([
          expect.objectContaining({
            source_map_reference: expect.objectContaining({
              source_name: "original.ts",
              map_path: "bundle.js.map",
            }),
            properties: expect.objectContaining({
              source_index: 0,
              declaration_index: 0,
              source_name_available: true,
              content_available: true,
              content_sha256: originalDigest,
            }),
            evidence: expect.objectContaining({
              artifact: expect.objectContaining({ sha256: mapDigest }),
            }),
          }),
        ]),
      }),
    );
    expect(graph.coverage.status).toBe("complete");
    expect(await readFile(mapPath, "utf8")).toBe(mapText);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains nullable source-map declarations and aligned content through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-nullable-map-");
    const original = "export const answer: number = 42;";
    const unnamed = "retained source text without a declared name";
    const maps = {
      "absent.js.map": JSON.stringify({
        version: 3,
        sources: ["unembedded.ts"],
        sourcesContent: null,
        names: [],
        mappings: "AAAA",
      }),
      "mixed.js.map": JSON.stringify({
        version: 3,
        sources: [null, "original.ts"],
        sourcesContent: [unnamed, original],
        names: [],
        mappings: "ACAA",
      }),
      "unnamed-empty.js.map": JSON.stringify({
        version: 3,
        sources: [null, "original.ts"],
        sourcesContent: [null, original],
        names: [],
        mappings: "ACAA",
      }),
    };
    await writeFixtureFiles(root, {
      ...maps,
      "absent.js":
        "export const absent = 1;\n//# sourceMappingURL=absent.js.map\n",
      "mixed.js":
        "export const answer = 42;\n//# sourceMappingURL=mixed.js.map\n",
      "unnamed-empty.js":
        "export const answer = 42;\n//# sourceMappingURL=unnamed-empty.js.map\n",
    });
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const digest = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    expect(
      graph.nodes.filter(
        (node) => node.identity.strategy === "source-map-original",
      ),
    ).toHaveLength(3);
    for (const [name, mapPath, content, sourceIndex] of [
      ["unembedded.ts", "absent.js.map", null, 0],
      ["original.ts", "mixed.js.map", original, 1],
      ["original.ts", "unnamed-empty.js.map", original, 1],
    ] as const) {
      const mapDigest = digest(maps[mapPath]);
      expect(graph.nodes).toContainEqual(
        expect.objectContaining({
          kind: "source-module",
          identity: expect.objectContaining({
            strategy: "source-map-original",
            source_map_sha256: mapDigest,
            original_source: name,
            source_sha256: content === null ? null : digest(content),
          }),
          observations: expect.arrayContaining([
            expect.objectContaining({
              source_map_reference: expect.objectContaining({
                source_name: name,
                map_path: mapPath,
              }),
              properties: expect.objectContaining({
                source_index: sourceIndex,
                declaration_index: sourceIndex,
                source_name_available: true,
                content_available: content !== null,
              }),
              evidence: expect.objectContaining({
                artifact: expect.objectContaining({ sha256: mapDigest }),
              }),
            }),
          ]),
        }),
      );
    }
    for (const [mapPath, content] of [
      ["mixed.js.map", unnamed],
      ["unnamed-empty.js.map", null],
    ] as const)
      expect(graph.nodes).toContainEqual(
        expect.objectContaining({
          kind: "unknown",
          observations: expect.arrayContaining([
            expect.objectContaining({
              source_map_reference: null,
              properties: expect.objectContaining({
                source_index: 0,
                declaration_index: 0,
                source_name_available: false,
                content_available: content !== null,
                content_sha256: content === null ? null : digest(content),
              }),
              evidence: expect.objectContaining({
                artifact: expect.objectContaining({
                  sha256: digest(maps[mapPath]),
                }),
              }),
            }),
          ]),
        }),
      );
    expect(graph.coverage.status).toBe("complete");
    for (const [path, text] of Object.entries(maps))
      expect(await readFile(join(root, path), "utf8")).toBe(text);
  },
);

cliTest.for(["CLI", "stdio MCP"] as const)(
  "preserves source-root declarations and URL path identity through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-source-root-identity-");
    const cases = [
      {
        sourceRoot: "https://cdn.example/src//",
        resolution: { kind: "suffix", path: "cdn.example/src//a.js" },
      },
      {
        sourceRoot: "webpack://",
        resolution: {
          kind: "unresolved",
          reason:
            "Source reference uses a non-hierarchical URL without a file pathname.",
        },
      },
      {
        sourceRoot: "webpack:///",
        resolution: { kind: "suffix", path: "a.js" },
      },
    ] as const;
    const maps = cases.map(({ sourceRoot }, index) => ({
      path: `${String(index)}.js.map`,
      text: JSON.stringify({
        version: 3,
        sourceRoot,
        sources: ["a.js"],
        names: [],
        mappings: "AAAA",
      }),
    }));
    await writeFixtureFiles(
      root,
      Object.fromEntries(maps.map(({ path, text }) => [path, text])),
    );
    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    for (const [index, { sourceRoot, resolution }] of cases.entries()) {
      const map = maps[index]!;
      expect(graph.nodes).toContainEqual(
        expect.objectContaining({
          kind: "source-module",
          identity: expect.objectContaining({
            strategy: "source-map-original",
            source_map_sha256: createHash("sha256")
              .update(map.text)
              .digest("hex"),
            original_source: "a.js",
          }),
          observations: expect.arrayContaining([
            expect.objectContaining({
              source_map_reference: {
                source_name: "a.js",
                source_root: sourceRoot,
                map_path: map.path,
                resolution,
              },
            }),
          ]),
        }),
      );
      expect(await readFile(join(root, map.path), "utf8")).toBe(map.text);
    }
  },
);
