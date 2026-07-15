import { Readable } from "node:stream";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import { describe, expect, it } from "vitest";

import { readJavaScriptArtifactFiles } from "../src/application/JavaScriptArtifactFiles.js";
import { reconstructJavaScriptArtifact } from "../src/application/JavaScriptArtifactReconstruction.js";
import {
  artifactLimitsForReconstruction,
  javascriptArtifactReconstructionInputSchema,
} from "../src/application/JavaScriptArtifactReconstructionInput.js";
import { scanArtifactInventory } from "../src/application/ArtifactInventory.js";
import {
  type ArtifactEntry,
  type ArtifactReader,
} from "../src/artifacts/ArtifactReader.js";
import { parseJavaScriptApplicationGraph } from "../src/domain/javascriptApplicationGraph.js";
import { writeJavaScriptArtifactFixture } from "./fixtures/javascriptArtifactApplication.js";

describe("JavaScript artifact reconstruction", () => {
  it("reconstructs package, Electron roles, Webpack/Rspack modules, and cross-layer facts without execution", async () => {
    const root = await fixtureDirectory();
    Reflect.deleteProperty(globalThis, "__rea_bundle_executed");

    const result = await reconstructJavaScriptArtifact({
      input_path: root,
      source_map_read_approved: true,
    });
    const graph = parseJavaScriptApplicationGraph(result.graph);

    expect(Reflect.get(globalThis, "__rea_bundle_executed")).toBeUndefined();
    expect(result.input_path).toBe(root);
    expect(result.statistics).toMatchObject({
      modules: 4,
      parse_failures: 0,
      omitted_text_files: 0,
      policy_filtered_text_files: 0,
    });
    expect(graph.nodes.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "package",
        "artifact",
        "electron-main",
        "electron-preload",
        "electron-renderer",
        "javascript-asset",
        "javascript-chunk",
        "javascript-module",
        "worker",
        "service-worker",
        "endpoint",
        "storage",
        "source-map",
        "source-module",
        "native-addon",
      ]),
    );
    expect(
      graph.nodes.filter(({ kind }) => kind === "javascript-chunk"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({ bundler: "webpack" }),
            }),
          ]),
        }),
        expect.objectContaining({
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({ bundler: "rspack" }),
            }),
          ]),
        }),
      ]),
    );
    expect(
      graph.nodes.filter(({ kind }) => kind === "javascript-module"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                module_key: "1",
                structural_fingerprint_algorithm: "babel-ast-v1",
              }),
            }),
          ]),
        }),
      ]),
    );
    expect(graph.edges.map(({ relation }) => relation)).toEqual(
      expect.arrayContaining([
        "contains",
        "loads",
        "imports",
        "maps_to",
        "exposes",
        "calls",
        "persists_to",
      ]),
    );
    const endpointJson = JSON.stringify(
      graph.nodes.filter(({ kind }) => kind === "endpoint"),
    );
    expect(endpointJson).toContain("token=%5BREDACTED%5D");
    expect(endpointJson).not.toContain("fixture-secret");
  });

  it("produces deterministic ASAR graphs with unpacked native linkage and complete paths/digests", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-javascript-asar-"));
    const source = join(root, "source");
    await mkdir(source);
    await writeJavaScriptArtifactFixture(source);
    const archive = join(root, "app.asar");
    await createPackageWithOptions(source, archive, { unpack: "**/*.node" });

    const first = await reconstructJavaScriptArtifact({
      input_path: archive,
      format: "asar",
      source_map_read_approved: true,
    });
    const second = await reconstructJavaScriptArtifact({
      input_path: archive,
      format: "asar",
      source_map_read_approved: true,
    });

    expect(first.graph).toEqual(second.graph);
    expect(first.inventory_graph_sha256).toBe(second.inventory_graph_sha256);
    expect(first.graph.graph_id).toBe(second.graph.graph_id);
    expect(first.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "asar-entry",
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                entry_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
                inventory_artifact_id:
                  expect.stringMatching(/^art_[a-f0-9]{64}$/u),
              }),
            }),
          ]),
        }),
        expect.objectContaining({
          kind: "native-addon",
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                path: "native/addon.node",
                unpacked: true,
              }),
            }),
          ]),
        }),
      ]),
    );
    expect(first.graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "loads",
        properties: expect.objectContaining({
          resolved_path: "native/addon.node",
        }),
      }),
    );
  });

  it("recurses into filesystem-backed ASAR containers without losing container-relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-javascript-nested-asar-"));
    const source = await fixtureDirectory();
    const outer = join(root, "outer");
    const resources = join(outer, "resources");
    await mkdir(resources, { recursive: true });
    await createPackageWithOptions(source, join(resources, "app.asar"), {
      unpack: "**/*.node",
    });

    const result = await reconstructJavaScriptArtifact({
      input_path: outer,
      source_map_read_approved: true,
    });

    expect(result.statistics.nested_asar_containers).toBe(1);
    expect(result.statistics.modules).toBe(4);
    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "artifact",
          observations: expect.arrayContaining([
            expect.objectContaining({
              label: "resources/app.asar",
              properties: expect.objectContaining({ format: "asar" }),
            }),
          ]),
        }),
        expect.objectContaining({
          kind: "javascript-asset",
          observations: expect.arrayContaining([
            expect.objectContaining({
              properties: expect.objectContaining({
                path: "resources/app.asar/main.js",
              }),
            }),
          ]),
        }),
      ]),
    );
  });

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

    expect(
      unapproved.graph.nodes.some(({ kind }) => kind === "source-map"),
    ).toBe(true);
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
    expect(result.graph.nodes.some(({ kind }) => kind === "unknown")).toBe(
      true,
    );
    expect(result.graph.limitations.join(" ")).toMatch(/incomplete|bound/iu);
  });

  it("uses an unknown omission count when AST traversal reaches its bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-javascript-ast-limit-"));
    await writeFile(
      join(root, "large.js"),
      Array.from(
        { length: 100 },
        (_, index) => `export const value${String(index)} = ${String(index)};`,
      ).join("\n"),
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
  });

  it("does not follow symlinks or read oversized JavaScript text", async () => {
    const root = await fixtureDirectory();
    const outside = await mkdtemp(join(tmpdir(), "rea-javascript-outside-"));
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
    const root = await mkdtemp(join(tmpdir(), "rea-javascript-source-maps-"));
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
    const root = await mkdtemp(join(tmpdir(), "rea-javascript-observations-"));
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
  });

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
  const root = await mkdtemp(join(tmpdir(), "rea-javascript-artifact-"));
  await writeJavaScriptArtifactFixture(root);
  return root;
};
