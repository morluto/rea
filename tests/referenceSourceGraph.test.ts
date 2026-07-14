import { describe, expect, it } from "vitest";

import {
  computeHistoricalSourceGraphSha256,
  createHistoricalSourceGraph,
  createHistoricalSourceManifest,
  historicalSourceGraphSchema,
  parseHistoricalSourceGraph,
  parseHistoricalSourceManifest,
  type HistoricalSourceGraphInput,
} from "../src/domain/referenceSourceGraph.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
type Entry = HistoricalSourceGraphInput["entries"][number];
type DirectoryEntry = Extract<Entry, { kind: "directory" }>;
type FileEntry = Extract<Entry, { kind: "file" }>;
type SymlinkEntry = Extract<Entry, { kind: "symlink" }>;

const directoryEntry = (
  treeState: DirectoryEntry["tree_state"] = "enumerated",
): DirectoryEntry => ({
  path: "src",
  kind: "directory",
  classifications: ["source"],
  tree_state: treeState,
  limitations: [],
});

const fileEntry = (overrides: Partial<FileEntry> = {}): FileEntry => ({
  path: "src/main.ts",
  kind: "file",
  sha256: HASH_B,
  size: 20,
  language: "TypeScript",
  classifications: ["source"],
  content_state: "hashed",
  limitations: [],
  ...overrides,
});

const symlinkEntry = (overrides: Partial<SymlinkEntry> = {}): SymlinkEntry => ({
  path: "src/package.json",
  kind: "symlink",
  target: "main.ts",
  target_state: "internal",
  classifications: ["manifest"],
  limitations: [],
  ...overrides,
});

const graphInput = (): HistoricalSourceGraphInput => ({
  schema: "HistoricalSourceGraph/v1",
  authority: "historical-reference",
  root_alias: "$REFERENCE_ROOT",
  inventory_state: "complete",
  entries: [directoryEntry(), fileEntry(), symlinkEntry()],
  relationships: [
    {
      from_path: "src/main.ts",
      to: "node:fs",
      kind: "imports",
      resolution: "external",
      parse_state: "parsed",
    },
    {
      from_path: "src/main.ts",
      to: "src",
      kind: "references",
      resolution: "internal",
      parse_state: "parsed",
    },
  ],
  parse_failures: [],
  exclusions: [],
  languages: ["TypeScript"],
  manifests: [],
  vcs: { kind: "git", head: HASH_A, dirty: false },
  provenance: { importer: "rea", importer_version: "1", caller: "test" },
  limitations: [],
});

describe("historical source graph", () => {
  it("builds and verifies internal root and manifest commitments", () => {
    const graph = createHistoricalSourceGraph(graphInput());
    const first = createHistoricalSourceManifest(graph);
    const second = createHistoricalSourceManifest(structuredClone(graph));

    expect(first).toEqual(second);
    expect(parseHistoricalSourceGraph(graph)).toEqual(graph);
    expect(parseHistoricalSourceManifest(first)).toEqual(first);
    expect(first.graph_sha256).toBe(computeHistoricalSourceGraphSha256(graph));
  });

  it("rejects stale roots and commits file, directory, and symlink semantics", () => {
    const original = createHistoricalSourceGraph(graphInput());
    expect(() =>
      parseHistoricalSourceGraph({ ...original, root_sha256: HASH_A }),
    ).toThrow(/root commitment/u);

    for (const mutate of [
      (input: HistoricalSourceGraphInput) => {
        input.entries[0] = directoryEntry("partial");
        input.inventory_state = "partial";
      },
      (input: HistoricalSourceGraphInput) => {
        input.entries[1] = fileEntry({ sha256: "c".repeat(64) });
      },
      (input: HistoricalSourceGraphInput) => {
        input.entries[2] = symlinkEntry({
          target: "other.json",
          target_state: "missing",
        });
        input.inventory_state = "partial";
      },
      (input: HistoricalSourceGraphInput) => {
        input.exclusions = [
          { path: "private.env", reason: "configured-secret" },
        ];
        input.inventory_state = "partial";
      },
    ]) {
      const changed = graphInput();
      mutate(changed);
      expect(createHistoricalSourceGraph(changed).root_sha256).not.toBe(
        original.root_sha256,
      );
    }
  });

  it("derives language and manifest indexes and enforces code-point order", () => {
    const input = graphInput();
    input.entries[1] = fileEntry({ classifications: ["source", "test"] });
    expect(() =>
      createHistoricalSourceGraph({ ...input, languages: [] }),
    ).toThrow(/derived/u);
    expect(() =>
      createHistoricalSourceGraph({ ...input, manifests: ["src/main.ts"] }),
    ).toThrow(/derived/u);
    expect(() =>
      createHistoricalSourceGraph({
        ...input,
        entries: input.entries.toReversed(),
      }),
    ).toThrow(/Unicode code point/u);
    expect(() =>
      createHistoricalSourceGraph({
        ...input,
        entries: input.entries.map((entry) =>
          entry.path === "src/main.ts"
            ? { ...entry, classifications: ["test", "source"] }
            : entry,
        ),
      }),
    ).toThrow(/Unicode code point/u);
  });

  it("preserves partial observations but rejects every partial complete graph", () => {
    const partial = graphInput();
    partial.inventory_state = "partial";
    partial.entries[1] = fileEntry({
      sha256: null,
      size: null,
      content_state: "unreadable",
      limitations: ["Permission denied"],
    });
    partial.parse_failures = [
      { path: "src/main.ts", parser: "typescript", reason: "Malformed input" },
    ];
    expect(createHistoricalSourceGraph(partial).inventory_state).toBe(
      "partial",
    );

    for (const change of [
      { entries: partial.entries },
      { parse_failures: partial.parse_failures },
      {
        exclusions: [{ path: "secret", reason: "configured-secret" as const }],
      },
      { limitations: ["Incomplete"] },
      {
        relationships: [
          {
            ...graphInput().relationships[0]!,
            parse_state: "partial" as const,
          },
        ],
      },
    ])
      expect(() =>
        createHistoricalSourceGraph({ ...graphInput(), ...change }),
      ).toThrow(/Complete inventory/u);
  });

  it("keeps distinct failure reasons for the same path and parser", () => {
    const partial = graphInput();
    partial.inventory_state = "partial";
    partial.parse_failures = [
      { path: "src/main.ts", parser: "babel", reason: "First failure" },
      { path: "src/main.ts", parser: "babel", reason: "Second failure" },
    ];

    expect(createHistoricalSourceGraph(partial).parse_failures).toEqual(
      partial.parse_failures,
    );
    partial.parse_failures.push(partial.parse_failures[1]!);
    expect(() => createHistoricalSourceGraph(partial)).toThrow(
      /parse_failures.*unique/iu,
    );
  });

  it("rejects strict unknown fields, invalid VCS, dangling internal edges, and false manifests", () => {
    expect(() =>
      createHistoricalSourceGraph({ ...graphInput(), surprise: true }),
    ).toThrow();
    expect(() =>
      createHistoricalSourceGraph({
        ...graphInput(),
        vcs: { kind: "git", head: "main", dirty: false },
      }),
    ).toThrow();
    expect(() =>
      createHistoricalSourceGraph({
        ...graphInput(),
        relationships: [
          { ...graphInput().relationships[1]!, to: "missing.ts" },
        ],
      }),
    ).toThrow(/normalized and inventoried/u);
    expect(() =>
      createHistoricalSourceGraph({
        ...graphInput(),
        inventory_state: "partial",
        entries: graphInput().entries.map((entry) =>
          entry.kind === "symlink"
            ? { ...entry, target: "/etc/passwd", target_state: "external" }
            : entry,
        ),
      }),
    ).toThrow();
    expect(() =>
      createHistoricalSourceGraph({
        ...graphInput(),
        inventory_state: "partial",
        entries: graphInput().entries.map((entry) =>
          entry.kind === "symlink"
            ? {
                ...entry,
                target: "<outside-root>",
                target_state: "external",
              }
            : entry,
        ),
      }),
    ).not.toThrow();
    expect(() =>
      createHistoricalSourceGraph({
        ...graphInput(),
        relationships: [
          { ...graphInput().relationships[1]!, to: "../escape.ts" },
        ],
      }),
    ).toThrow(/normalized and inventoried/u);
    expect(() =>
      historicalSourceGraphSchema.parse({
        ...createHistoricalSourceGraph(graphInput()),
        extra: true,
      }),
    ).toThrow();

    const manifest = createHistoricalSourceManifest(
      createHistoricalSourceGraph(graphInput()),
    );
    expect(() =>
      parseHistoricalSourceManifest({ ...manifest, entry_count: 999 }),
    ).toThrow(/identifier does not match/u);
  });
});
