import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { parseApplicationGraphEvidence } from "../../../src/application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { importReferenceSource } from "../../../src/application/ReferenceSourceImport.js";
import { compareSourceToBundle } from "../../../src/domain/javascript/sourceToBundleComparison.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("keeps literal hash characters in historical/current filesystem paths", async () => {
  const root = await createTestTempDirectory("rea-source-path-");
  const previous = join(root, "previous");
  const current = join(root, "current");
  await Promise.all([mkdir(previous), mkdir(current)]);
  await Promise.all([
    writeFile(join(previous, "worker#main.js"), "export const value = 1;"),
    writeFile(join(current, "worker#main.js"), "export const value = 2;"),
  ]);
  const { reference, comparison } = await compareTrees(previous, current);

  expect(reference.entries).toContainEqual(
    expect.objectContaining({
      kind: "file",
      path: "worker#main.js",
      content_state: "hashed",
    }),
  );
  expect(comparison.items).toContainEqual(
    expect.objectContaining({
      source_path: "worker#main.js",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          signals: expect.arrayContaining([
            expect.objectContaining({
              kind: "current-path-exact",
              source_value: "worker#main.js",
            }),
          ]),
        }),
      ]),
    }),
  );
});

it("matches source-map originals named relative to the map", async () => {
  const root = await createTestTempDirectory("rea-source-map-parent-");
  const previous = join(root, "previous");
  const current = join(root, "current");
  await Promise.all([
    mkdir(join(previous, "src"), { recursive: true }),
    mkdir(join(current, "dist"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(previous, "src", "a.js"), "export const value = 1;\n"),
    writeFile(
      join(current, "dist", "main.js"),
      "var value = 2;\n//# sourceMappingURL=main.js.map\n",
    ),
    writeFile(
      join(current, "dist", "main.js.map"),
      JSON.stringify({
        version: 3,
        file: "main.js",
        sources: ["../src/a.js"],
        sourcesContent: ["export const value = 2;\n"],
        names: [],
        mappings: "AAAA",
      }),
    ),
  ]);
  const { comparison } = await compareTrees(previous, current);

  expect(comparison.items).toContainEqual(
    expect.objectContaining({
      source_path: "src/a.js",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          current_node_kind: "source-module",
          signals: expect.arrayContaining([
            expect.objectContaining({
              kind: "source-map-original-path",
              current_values: ["src/a.js"],
            }),
          ]),
        }),
      ]),
    }),
  );
});

it.each([
  {
    mapPath: "pkg/dist/main.js.map",
    source: "..\\src\\a.js",
    expected: "pkg/src/a.js",
  },
  {
    mapPath: "pkg/dist/main.js.map",
    source: "../src/a.js",
    expected: "pkg/src/a.js",
  },
  {
    mapPath: "apps/pkg/dist/maps/main.js.map",
    source: "../../src/a.js",
    expected: "apps/pkg/src/a.js",
  },
  {
    mapPath: "pkg/dist/main.js.map",
    sourceRoot: "../src",
    source: "a.js",
    expected: "pkg/src/a.js",
  },
  {
    mapPath: "pkg/maps/main.js.map",
    source: "modules/a.js",
    expected: "pkg/maps/modules/a.js",
  },
  {
    mapPath: "pkg/maps/main.js.map",
    source: "generated/../src/a.js",
    expected: "pkg/maps/src/a.js",
  },
  {
    mapPath: "pkg/maps/main.js.map",
    sourceRoot: "generated/..",
    source: "src/a.js",
    expected: "pkg/maps/src/a.js",
  },
])(
  "resolves $source against $mapPath without selecting a same-basename decoy",
  async ({ mapPath, source, sourceRoot, expected }) => {
    const root = await createTestTempDirectory("rea-nested-map-");
    const previous = join(root, "previous");
    const current = join(root, "current");
    await Promise.all([
      mkdir(join(previous, expected, ".."), { recursive: true }),
      mkdir(join(previous, "src"), { recursive: true }),
      mkdir(join(current, mapPath, ".."), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(previous, expected), "export const value = 1;"),
      writeFile(join(previous, "src/a.js"), "export const decoy = 99;"),
      writeFile(
        join(current, mapPath),
        JSON.stringify({
          version: 3,
          sources: [source],
          ...(sourceRoot === undefined ? {} : { sourceRoot }),
          sourcesContent: ["export const value = 2;"],
          names: [],
          mappings: "AAAA",
        }),
      ),
    ]);
    const { comparison } = await compareTrees(previous, current);
    const correct = comparison.items.find(
      ({ source_path }) => source_path === expected,
    );
    expect(correct?.current_node_ids).toHaveLength(1);
    expect(correct?.candidates).toContainEqual(
      expect.objectContaining({
        confidence: "high",
        signals: expect.arrayContaining([
          expect.objectContaining({
            kind: "source-map-original-path",
            current_values: [expected],
          }),
        ]),
      }),
    );
    const decoy = comparison.items.find(
      ({ source_path }) => source_path === "src/a.js",
    );
    expect(decoy?.current_node_ids).toEqual([]);
    expect(
      decoy?.candidates
        .flatMap(({ signals }) => signals)
        .some(({ kind }) => kind === "current-path-exact"),
    ).toBe(false);
    // A suffix alone must not claim a second map-relative original identity.
    expect(
      decoy?.candidates
        .flatMap(({ signals }) => signals)
        .some(({ kind }) => kind === "source-map-original-path"),
    ).toBe(false);
  },
);

it("retains every map location when identical map artifacts merge", async () => {
  const root = await createTestTempDirectory("rea-source-map-merged-");
  const previous = join(root, "previous");
  const current = join(root, "current");
  const map = JSON.stringify({
    version: 3,
    sources: ["../src/x.js"],
    sourcesContent: ["export const value = 2;"],
    names: [],
    mappings: "AAAA",
  });
  for (const prefix of ["a", "b"]) {
    await Promise.all([
      mkdir(join(previous, prefix, "src"), { recursive: true }),
      mkdir(join(current, prefix, "maps"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(previous, prefix, "src/x.js"), "export const value = 1;"),
      writeFile(join(current, prefix, "maps/main.js.map"), map),
    ]);
  }
  const { comparison } = await compareTrees(previous, current);
  for (const prefix of ["a", "b"]) {
    const path = `${prefix}/src/x.js`;
    const item = comparison.items.find(
      ({ source_path }) => source_path === path,
    );
    expect(item?.current_node_ids).toHaveLength(1);
    expect(item?.candidates).toContainEqual(
      expect.objectContaining({
        confidence: "high",
        signals: expect.arrayContaining([
          expect.objectContaining({
            kind: "source-map-original-path",
            current_values: [path],
          }),
        ]),
      }),
    );
  }
});

it.each([
  { source: "file:/repo/src/a.js", hasPath: true },
  { source: "file:/repo/src/a.js?version=2#original", hasPath: true },
  { source: "webpack:///src/a.js", hasPath: true },
  { source: "https://example.com/src/a.js#original", hasPath: true },
  { source: "node:internal/src/a.js", hasPath: false },
  { source: "data:text/javascript,virtual/src/a.js", hasPath: false },
  { source: "data:text/javascript,virtual/../src/a.js", hasPath: false },
  { source: "data:\\src\\a.js", hasPath: false },
])(
  "projects a filesystem path from $source only when it is hierarchical",
  async ({ source, hasPath }) => {
    const root = await createTestTempDirectory("rea-source-map-uri-");
    const previous = join(root, "previous");
    const current = join(root, "current");
    await Promise.all([
      mkdir(join(previous, "src"), { recursive: true }),
      mkdir(join(current, "maps"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(previous, "src/a.js"), "export const value = 1;"),
      writeFile(
        join(current, "maps/main.js.map"),
        JSON.stringify({
          version: 3,
          sources: [source],
          sourcesContent: ["export const value = 2;"],
          names: [],
          mappings: "AAAA",
        }),
      ),
    ]);
    const { comparison, application } = await compareTrees(previous, current);
    expect(application.graph.nodes).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ original_source: source }),
      }),
    );
    if (hasPath)
      expect(comparison.items[0]?.candidates).toContainEqual(
        expect.objectContaining({
          confidence: "high",
          signals: expect.arrayContaining([
            expect.objectContaining({ kind: "source-map-original-path" }),
          ]),
        }),
      );
    else expect(comparison.items[0]?.candidates).toEqual([]);
  },
);

it.each(["#original.js", "?version.js", "?version.js#original.js"])(
  "uses the relative URL pathname rather than a literal %s filename",
  async (suffix) => {
    const root = await createTestTempDirectory("rea-source-map-suffix-");
    const previous = join(root, "previous");
    const current = join(root, "current");
    await Promise.all([
      mkdir(join(previous, "src"), { recursive: true }),
      mkdir(join(current, "maps"), { recursive: true }),
    ]);
    const source = `../src/a.js${suffix}`;
    await Promise.all([
      writeFile(join(previous, "src/a.js"), "export const value = 1;"),
      writeFile(join(previous, `src/a.js${suffix}`), "export const decoy = 3;"),
      writeFile(
        join(current, "maps/main.js.map"),
        JSON.stringify({
          version: 3,
          sources: [source],
          sourcesContent: ["export const value = 2;"],
          names: [],
          mappings: "AAAA",
        }),
      ),
    ]);
    const { comparison, application } = await compareTrees(previous, current);
    const actual = comparison.items.find(
      ({ source_path }) => source_path === "src/a.js",
    );
    expect(actual?.current_node_ids).toHaveLength(1);
    expect(actual?.candidates).toContainEqual(
      expect.objectContaining({
        confidence: "high",
        signals: expect.arrayContaining([
          expect.objectContaining({
            kind: "source-map-original-path",
            current_values: ["src/a.js"],
          }),
        ]),
      }),
    );
    const decoy = comparison.items.find(
      ({ source_path }) => source_path === `src/a.js${suffix}`,
    );
    expect(decoy?.current_node_ids).toEqual([]);
    expect(decoy?.candidates).toEqual([]);
    expect(application.graph.nodes).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ original_source: source }),
      }),
    );
  },
);

it.each([
  { source: "", historicalPath: "maps.js" },
  { source: ".", historicalPath: "maps.js" },
  { source: "./", historicalPath: "maps.js" },
  { source: "child/..", historicalPath: "maps.js" },
  { source: "child.js/", historicalPath: "maps.js/child.js" },
  { source: "#original.js", historicalPath: "maps.js" },
  { source: "?version.js", historicalPath: "maps.js" },
  { source: "./?version.js", historicalPath: "maps.js" },
])(
  "keeps the directory-only source name $source out of file path indices",
  async ({ source, historicalPath }) => {
    const root = await createTestTempDirectory("rea-source-map-empty-");
    const previous = join(root, "previous");
    const current = join(root, "current");
    await Promise.all([
      mkdir(join(previous, historicalPath, ".."), { recursive: true }),
      mkdir(join(current, "maps.js"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(previous, historicalPath), "export const value = 1;"),
      writeFile(
        join(current, "maps.js/main.js.map"),
        JSON.stringify({
          version: 3,
          sources: [source],
          sourcesContent: ["export const value = 2;"],
          names: [],
          mappings: "AAAA",
        }),
      ),
    ]);
    const { comparison } = await compareTrees(previous, current);
    expect(comparison.items[0]?.source_path).toBe(historicalPath);
    expect(comparison.items[0]?.candidates).toEqual([]);
  },
);

it("resolves parent segments against a nested source map's directory", async () => {
  const root = await createTestTempDirectory("rea-source-map-nested-");
  const previous = join(root, "previous");
  const current = join(root, "current");
  await Promise.all([
    mkdir(join(previous, "web", "src"), { recursive: true }),
    mkdir(join(current, "web", "maps"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(previous, "web", "src", "a.js"),
      "export const value = 1;\n",
    ),
    writeFile(
      join(current, "web", "main.js"),
      "var value = 2;\n//# sourceMappingURL=maps/main.js.map\n",
    ),
    writeFile(
      join(current, "web", "maps", "main.js.map"),
      JSON.stringify({
        version: 3,
        file: "../main.js",
        sources: ["../src/a.js"],
        sourcesContent: ["export const value = 2;\n"],
        names: [],
        mappings: "AAAA",
      }),
    ),
  ]);
  const { comparison } = await compareTrees(previous, current);

  expect(comparison.items).toContainEqual(
    expect.objectContaining({
      source_path: "web/src/a.js",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          current_node_kind: "source-module",
          signals: expect.arrayContaining([
            expect.objectContaining({
              kind: "source-map-original-path",
              current_values: ["web/src/a.js"],
            }),
          ]),
        }),
      ]),
    }),
  );
});

it("rejects static application Evidence whose subject path disagrees with its result", async () => {
  const root = await createTestTempDirectory("rea-application-subject-path-");
  const analyzed = await analyzeJavaScriptApplication({ input_path: root });
  if (!analyzed.ok) throw analyzed.error;
  const subject = analyzed.value.subject;
  if (subject === null) throw new Error("Analysis Evidence subject missing");
  const inconsistent = {
    ...analyzed.value,
    subject: {
      ...subject,
      local_path: join(root, "relocated"),
    },
  };

  expect(() => parseApplicationGraphEvidence(inconsistent)).toThrow(
    "JavaScript application Evidence subject does not match its result",
  );
});

const compareTrees = async (previous: string, current: string) => {
  const reference = await importReferenceSource({
    root: previous,
    caller: "source-to-bundle-path-test",
    policy: { secretPatterns: [] },
  });
  if (!reference.ok) throw new Error(reference.error.message);
  const analyzed = await analyzeJavaScriptApplication({ input_path: current });
  if (!analyzed.ok) throw analyzed.error;
  const application = parseApplicationGraphEvidence(analyzed.value);
  const comparison = compareSourceToBundle({
    reference: reference.value,
    application: {
      evidenceId: application.evidence.evidence_id,
      rootArtifactSha256: application.rootArtifactSha256,
      graph: application.graph,
    },
  });
  return { reference: reference.value, comparison, application };
};
