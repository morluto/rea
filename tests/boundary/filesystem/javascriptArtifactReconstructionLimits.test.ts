import { Readable } from "node:stream";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { readJavaScriptArtifactFiles } from "../../../src/application/JavaScriptArtifactFiles.js";
import { reconstructJavaScriptArtifact } from "../../../src/application/JavaScriptArtifactReconstruction.js";
import {
  artifactLimitsForReconstruction,
  javascriptArtifactReconstructionInputSchema,
} from "../../../src/application/JavaScriptArtifactReconstructionInput.js";
import { scanArtifactInventory } from "../../../src/application/ArtifactInventory.js";
import {
  type ArtifactEntry,
  type ArtifactReader,
} from "../../../src/artifacts/ArtifactReader.js";
import { writeJavaScriptArtifactFixture } from "../../fixtures/javascriptArtifactApplication.js";

it("discovers source maps without reading them until separately approved", async () => {
  const root = await fixtureDirectory();
  const unapproved = await reconstructJavaScriptArtifact({
    input_path: root,
    source_map_read_approved: false,
  });
  const approved = await reconstructJavaScriptArtifact({
    input_path: root,
    source_map_read_approved: true,
  });

  expect(unapproved.graph.nodes.some(({ kind }) => kind === "source-map")).toBe(
    true,
  );
  expect(
    unapproved.graph.nodes.some(({ kind }) => kind === "source-module"),
  ).toBe(false);
  expect(unapproved.graph.coverage).toMatchObject({
    status: "partial",
    truncated: false,
    omitted_count: null,
  });
  expect(unapproved.statistics.policy_filtered_text_files).toBe(1);
  expect(unapproved.graph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "unknown",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              operation: "parse-local-source-map",
            }),
            evidence: expect.objectContaining({ state: "unavailable" }),
          }),
        ]),
      }),
    ]),
  );
  expect(
    approved.graph.nodes.some(({ kind }) => kind === "source-module"),
  ).toBe(true);
});

it("reports text and AST limits as truncation instead of absence", async () => {
  const root = await fixtureDirectory();
  const result = await reconstructJavaScriptArtifact({
    input_path: root,
    source_map_read_approved: true,
    limits: {
      max_text_file_bytes: 128,
      max_total_text_bytes: 1_024,
      max_ast_nodes: 50,
    },
  });

  expect(result.statistics.limit_omitted_text_files).toBeGreaterThan(0);
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: true,
  });
  expect(result.graph.coverage.omitted_count).toBeGreaterThan(0);
  expect(result.graph.nodes.some(({ kind }) => kind === "unknown")).toBe(true);
  expect(result.graph.limitations.join(" ")).toMatch(/incomplete|bound/iu);
});

it("uses an unknown omission count when AST traversal reaches its bound", async () => {
  const root = await createTestTempDirectory("rea-javascript-ast-limit-");
  await writeFile(
    join(root, "large.js"),
    [
      'import "./unobserved.js";',
      ...Array.from(
        { length: 100 },
        (_, index) => `export const value${String(index)} = ${String(index)};`,
      ),
    ].join("\n"),
  );

  const result = await reconstructJavaScriptArtifact({
    input_path: root,
    limits: { max_ast_nodes: 50 },
  });

  expect(result.statistics.limit_omitted_text_files).toBe(0);
  expect(result.statistics.truncated_scopes).toBe(1);
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: true,
    omitted_count: null,
  });
  const derivedImport = result.graph.edges.find(
    ({ relation, properties }) =>
      relation === "imports" && properties.specifier === "./unobserved.js",
  );
  expect(derivedImport?.evidence.coverage).toEqual({
    status: "partial",
    truncated: true,
    omitted_count: null,
    limits: expect.arrayContaining([
      { name: "max-ast-nodes", value: 50, unit: "items" },
    ]),
  });
});

it("does not follow symlinks or read oversized JavaScript text", async () => {
  const root = await fixtureDirectory();
  const outside = await createTestTempDirectory("rea-javascript-outside-");
  const outsideFile = join(outside, "secret.js");
  await writeFile(
    outsideFile,
    'fetch("https://outside-secret.invalid/credential");',
  );
  await symlink(outsideFile, join(root, "escape.js"));
  await writeFile(
    join(root, "oversized.js"),
    `const oversizedSecret = "${"private-marker-".repeat(256)}";`,
  );

  const result = await reconstructJavaScriptArtifact({
    input_path: root,
    limits: { max_text_file_bytes: 512 },
  });
  const encoded = JSON.stringify(result);

  expect(result.statistics.limit_omitted_text_files).toBeGreaterThan(0);
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: true,
  });
  expect(encoded).not.toContain(outsideFile);
  expect(encoded).not.toContain("outside-secret.invalid");
  expect(encoded).not.toContain("private-marker-private-marker");
});

it("keeps malformed JavaScript, package metadata, and source maps as explicit unknowns", async () => {
  const root = await fixtureDirectory();
  await Promise.all([
    writeFile(join(root, "package.json"), "{"),
    writeFile(join(root, "broken.js"), "function broken( {"),
    writeFile(join(root, "renderer", "renderer.js.map"), "{"),
  ]);

  const result = await reconstructJavaScriptArtifact({
    input_path: root,
    source_map_read_approved: true,
  });
  const unknownOperations = result.graph.nodes
    .filter(({ kind }) => kind === "unknown")
    .flatMap(({ observations }) =>
      observations.map(({ properties }) => properties.operation),
    );

  expect(result.statistics.parse_failures).toBeGreaterThan(0);
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: false,
    omitted_count: null,
  });
  expect(unknownOperations).toEqual(
    expect.arrayContaining([
      "parse-javascript",
      "parse-package-json",
      "parse-local-source-map",
    ]),
  );
});

it("applies one source-map source budget across every local map", async () => {
  const root = await createTestTempDirectory("rea-javascript-source-maps-");
  await Promise.all([
    writeFile(
      join(root, "a.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["a-one.ts", "a-two.ts"],
        sourcesContent: ["one", "two"],
        names: [],
        mappings: "",
      }),
    ),
    writeFile(
      join(root, "b.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["b-one.ts", "b-two.ts"],
        sourcesContent: ["three", "four"],
        names: [],
        mappings: "",
      }),
    ),
  ]);

  const result = await reconstructJavaScriptArtifact({
    input_path: root,
    source_map_read_approved: true,
    limits: { max_source_map_sources: 3 },
  });

  expect(
    result.graph.nodes.filter(({ kind }) => kind === "source-module"),
  ).toHaveLength(3);
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: true,
    omitted_count: null,
  });
});

it("bounds repeated content observations while retaining every containment path", async () => {
  const root = await createTestTempDirectory("rea-javascript-observations-");
  await Promise.all(
    Array.from({ length: 70 }, (_, index) =>
      writeFile(
        join(root, `duplicate-${String(index).padStart(2, "0")}.js`),
        "export const same = 1;\n",
      ),
    ),
  );

  const result = await reconstructJavaScriptArtifact({ input_path: root });
  const duplicateNode = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-asset" &&
      observations.some(({ properties }) =>
        String(properties.path).startsWith("duplicate-"),
      ),
  );
  const duplicateEdges = result.graph.edges.filter(
    ({ relation, properties }) =>
      relation === "contains" &&
      String(properties.path).startsWith("duplicate-"),
  );

  expect(duplicateNode?.observations).toHaveLength(64);
  expect(duplicateEdges).toHaveLength(70);
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: true,
    omitted_count: 6,
  });
}, 15_000);

it("rejects traversal from a production reader seam and malformed ASAR containers", async () => {
  const root = await fixtureDirectory();
  const input = javascriptArtifactReconstructionInputSchema.parse({
    input_path: root,
  });
  const snapshot = await scanArtifactInventory(
    root,
    artifactLimitsForReconstruction(input),
  );
  await expect(
    readJavaScriptArtifactFiles(new TraversalReader(), snapshot, input),
  ).rejects.toMatchObject({ reason: "path" });

  const malformed = join(root, "malformed.asar");
  await writeFile(malformed, "not an asar");
  await expect(
    reconstructJavaScriptArtifact({ input_path: malformed }),
  ).rejects.toMatchObject({
    name: "ArtifactReaderFailure",
    reason: "format",
  });
});

it("preserves cancellation and explicit format diagnostics", async () => {
  const root = await fixtureDirectory();
  const controller = new AbortController();
  controller.abort();
  await expect(
    reconstructJavaScriptArtifact({ input_path: root }, controller.signal),
  ).rejects.toMatchObject({ reason: "cancelled" });
  await expect(
    reconstructJavaScriptArtifact({ input_path: root, format: "asar" }),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringContaining(root),
  });
  expect(() =>
    javascriptArtifactReconstructionInputSchema.parse({
      input_path: root,
      limits: { max_entries: 100_000 },
    }),
  ).toThrow(/graph contract/iu);
});

class TraversalReader implements ArtifactReader {
  readonly format = "directory" as const;

  async *entries(): AsyncIterable<ArtifactEntry> {
    yield {
      path: "../escape.js",
      kind: "file",
      declaredSize: 1,
      compressedSize: null,
      executable: false,
      encrypted: false,
      byteOffset: null,
      declaredSha256: null,
      unpacked: false,
      limitations: [],
      adapterKey: "/tmp/escape.js",
    };
  }

  open(): Promise<Readable> {
    return Promise.resolve(Readable.from("x"));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  provenance(): readonly [] {
    return [];
  }
}

const fixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-javascript-artifact-");
  await writeJavaScriptArtifactFixture(root);
  return root;
};
