import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import { FirmwareAnalysisService } from "../application/firmware/FirmwareAnalysisService.js";
import { ok } from "../domain/result.js";
import { startFirmwareDeadline } from "./FirmwareDeadline.js";
import {
  FirmwareFileAccess,
  inventoryFirmwareOutput,
} from "./FirmwareFiles.js";
import { publishFirmwareExtraction } from "./FirmwarePublication.js";
import { normalizeUnblobReport } from "./FirmwareReports.js";

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const known = (id: string, start: number, end: number) => ({
  __typename__: "ChunkReport",
  id,
  start_offset: start,
  end_offset: end,
  size: end - start,
  handler_name: "authored-handler",
  is_encrypted: false,
  extraction_reports: [],
});
const cases = [
  { name: "opaque child", spans: [], gaps: [[0, 6]], coverage: "partial" },
  {
    name: "partly classified child",
    spans: [[2, 4]],
    gaps: [
      [0, 2],
      [4, 2],
    ],
    coverage: "partial",
  },
  {
    name: "fully classified child",
    spans: [[0, 6]],
    gaps: [],
    coverage: "complete",
  },
  {
    name: "explicit unknown child",
    spans: [],
    gaps: [],
    coverage: "partial",
    unknown: true,
  },
  {
    name: "empty child",
    spans: [],
    gaps: [],
    coverage: "complete",
    empty: true,
  },
] as const;

/** Inert gzip bytes and matching authored Unblob task reports; no engine runs. */
const capture = async (selection: (typeof cases)[number]) => {
  const root = await createTestTempDirectory("rea-nested-firmware-coverage-");
  const staging = join(root, "staging");
  await mkdir(staging);
  const child = Buffer.from("empty" in selection ? "" : "opaque");
  const compressed = gzipSync(child);
  const original = Buffer.concat([
    Buffer.from("prefix!"),
    compressed,
    Buffer.from("suffix"),
  ]);
  const path = join(root, "firmware.bin");
  const inputPath = join(root, "selected.gz");
  const childPath = join(staging, "child.bin");
  await writeFile(path, original);
  await writeFile(inputPath, compressed);
  await writeFile(childPath, child);
  const task = {
    path: childPath,
    depth: 1,
    blob_id: "container",
    is_multi_file: false,
  };
  const stat = (path: string, size: number) => ({
    __typename__: "StatReport",
    path,
    size,
    is_file: true,
    is_dir: false,
    is_link: false,
    link_target: null,
  });
  const raw = [
    {
      task: { path: inputPath, depth: 0, blob_id: "", is_multi_file: false },
      reports: [
        stat(inputPath, compressed.length),
        { __typename__: "HashReport", sha256: hash(compressed) },
        known("container", 0, compressed.length),
      ],
      subtasks: [task],
    },
    {
      task,
      reports: [
        stat(childPath, child.length),
        { __typename__: "HashReport", sha256: hash(child) },
        ...selection.spans.map(([start, end], index) =>
          known(String(index), start, end),
        ),
        ...("unknown" in selection
          ? [
              {
                __typename__: "UnknownChunkReport",
                id: "opaque",
                start_offset: 0,
                end_offset: child.length,
                size: child.length,
              },
            ]
          : []),
      ],
      subtasks: [],
    },
  ];
  return {
    root,
    staging,
    path,
    inputPath,
    child,
    original,
    raw,
    context: {
      inputPath,
      outputRoot: staging,
      sha256: hash(compressed),
      length: compressed.length,
      offset: 7,
      maxDepth: 3,
    },
  };
};

/** Exercise actual file publication and the shared Evidence boundary. */
const evidence = async (fixture: Awaited<ReturnType<typeof capture>>) => {
  const files = new FirmwareFileAccess();
  const output = join(fixture.root, "published");
  try {
    const normalized = normalizeUnblobReport(fixture.raw, fixture.context);
    const published = await publishFirmwareExtraction({
      files,
      workspacePath: fixture.root,
      deadline: startFirmwareDeadline("publication", 120_000),
      analysisTimeoutMs: 120_000,
      outputDirectory: output,
      entries: await inventoryFirmwareOutput(
        fixture.staging,
        1024,
        10,
        1024,
        "extract_firmware",
      ),
      normalized,
      selection: {
        offset: 7,
        length: fixture.context.length,
        sha256: fixture.context.sha256,
      },
      maxDepth: 3,
      engine: {
        name: "unblob",
        version: "authored-fixture",
        executable_path: "/inert/unused/unblob",
        executable_sha256: "a".repeat(64),
        source_revision: null,
        worker_count: 1,
      },
      signal: new AbortController().signal,
      retainCleanup: () => {
        throw new Error("Unexpected fixture cleanup failure");
      },
    });
    const execution = createAnalysisExecution(
      published,
      { id: "unblob", name: "Authored Unblob report", version: "fixture" },
      {
        subject: {
          path: fixture.path,
          sha256: hash(fixture.original),
          format: "file",
        },
        rawResult: fixture.raw,
      },
    );
    const result = await new FirmwareAnalysisService({
      execute: async () => ok(execution),
    }).execute("extract_firmware", {
      path: fixture.path,
      range: { offset: 7, length: fixture.context.length },
      output_directory: output,
    });
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toHaveProperty(
      "extraction_gaps",
      published.extraction_gaps,
    );
    expect(result.value.normalized_result).toHaveProperty(
      "extraction_continuations",
      published.extraction_continuations,
    );
    expect(
      (await readFile(join(output, "child.bin"))).equals(fixture.child),
    ).toBe(true);
    expect((await readFile(fixture.path)).equals(fixture.original)).toBe(true);
    expect(result.value.raw_result).toEqual(fixture.raw);
    return { value: result.value, published };
  } finally {
    await files.close();
  }
};

it.each(cases)(
  "retains $name coverage and child-relative gaps in service Evidence",
  async (selection) => {
    const fixture = await capture(selection);
    const result = await evidence(fixture);
    expect(result.value.normalized_result).toMatchObject({
      coverage: selection.coverage,
    });
    const implicit = result.published.extraction_gaps.filter(
      (gap) => gap.kind === "unclassified-range",
    );
    expect(implicit).toMatchObject(
      selection.gaps.map(([offset, length]) => ({
        input_path: "$output/child.bin",
        range: { offset, length },
        root_file_range: null,
      })),
    );
    expect(implicit).toHaveLength(selection.gaps.length);
    if ("unknown" in selection)
      expect(result.published.extraction_gaps).toMatchObject([
        {
          kind: "unknown-chunk-handler",
          input_path: "$output/child.bin",
          range: { offset: 0, length: 6 },
          root_file_range: null,
        },
      ]);
    if (selection.gaps.length > 0)
      for (const continuation of result.published.extraction_continuations)
        expect(continuation.instruction).not.toContain("was carved");
    for (const gap of result.published.extraction_gaps) {
      expect(result.published.extraction_continuations).toContainEqual({
        id: gap.continuation_id,
        instruction: expect.stringContaining("relative to the published child"),
      });
    }
  },
);
