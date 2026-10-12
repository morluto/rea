import { describe, expect, it } from "vitest";
import {
  normalizeBinwalkReport,
  normalizeUnblobReport,
} from "./FirmwareReports.js";

const context = {
  inputPath: "/private/input.bin",
  outputRoot: "/private/output",
  sha256: "a".repeat(64),
  length: 20,
  offset: 64,
  maxDepth: 3,
};
const root = () => ({
  task: {
    path: context.inputPath,
    depth: 0,
    blob_id: "",
    is_multi_file: false,
  },
  reports: [
    {
      __typename__: "StatReport",
      path: context.inputPath,
      size: 20,
      is_file: true,
      is_dir: false,
      is_link: false,
      link_target: null,
    },
    { __typename__: "HashReport", sha256: context.sha256 },
    {
      __typename__: "UnknownChunkReport",
      id: "unknown",
      start_offset: 0,
      end_offset: 20,
      size: 20,
      randomness: null,
    },
  ],
  subtasks: [],
});

describe("firmware producer boundaries", () => {
  it("retains unknown chunks and their selected original-file range", () => {
    const normalized = normalizeUnblobReport([root()], context);
    expect(normalized.coverage).toBe("partial");
    expect(normalized.chunks[0]).toMatchObject({
      handler: null,
      range: { offset: 0, length: 20 },
      root_file_range: { offset: 64, length: 20 },
    });
  });
  it("preserves unfamiliar report types as explicit diagnostics", () => {
    const record = root();
    const normalized = normalizeUnblobReport(
      [
        {
          ...record,
          reports: [
            ...record.reports,
            { __typename__: "FutureError", reason: "new producer facet" },
          ],
        },
      ],
      context,
    );
    expect(normalized.diagnostics).toEqual([
      {
        input_path: "$input",
        report: { __typename__: "FutureError", reason: "new producer facet" },
      },
    ]);
    expect(normalized.coverage).toBe("partial");
  });
});

describe("Unblob multi-file extraction diagnostics", () => {
  it("names a missing extractor dependency and stage while retaining the raw report", () => {
    const dependencyFailure = {
      __typename__: "ExtractorDependencyNotFoundReport",
      severity: "ERROR",
      dependencies: ["sasquatch"],
    };
    const record = root();
    const normalized = normalizeUnblobReport(
      [
        {
          ...record,
          reports: [
            ...record.reports.filter(
              (item) => item.__typename__ !== "UnknownChunkReport",
            ),
            {
              __typename__: "ChunkReport",
              id: "gzip-id",
              start_offset: 0,
              end_offset: 20,
              size: 20,
              handler_name: "gzip",
              is_encrypted: false,
              extraction_reports: [dependencyFailure],
            },
          ],
        },
      ],
      context,
    );
    expect(normalized.coverage).toBe("partial");
    expect(normalized.diagnostics).toEqual([
      {
        input_path: "$input",
        stage: "gzip",
        missing_dependencies: ["sasquatch"],
        report: dependencyFailure,
      },
    ]);
  });
});

describe("Unblob task derivation identities", () => {
  it("joins chunk and MultiFile derivations to their producer blob reports", () => {
    const outputPath = `${context.outputRoot}/multi`;
    const chunkPath = `${context.outputRoot}/chunk-child`;
    const childTask = {
      path: outputPath,
      depth: 1,
      blob_id: "multi-id",
      is_multi_file: false,
    };
    const extractionFailure = {
      __typename__: "ExtractorDependencyNotFoundReport",
      severity: "ERROR",
      dependencies: ["sasquatch"],
    };
    const multiFileReport = {
      __typename__: "MultiFileReport",
      id: "multi-id",
      handler_name: "multipart-firmware",
      name: "rootfs",
      paths: [`${outputPath}/part-a`, `${outputPath}/part-b`],
      extraction_reports: [extractionFailure],
    };
    const parent = root();
    const normalized = normalizeUnblobReport(
      [
        {
          ...parent,
          reports: [
            ...parent.reports.filter(
              (item) => item.__typename__ !== "UnknownChunkReport",
            ),
            {
              __typename__: "ChunkReport",
              id: "chunk-id",
              start_offset: 4,
              end_offset: 10,
              size: 6,
              handler_name: "gzip",
              is_encrypted: false,
              extraction_reports: [],
            },
            multiFileReport,
          ],
          subtasks: [
            {
              path: chunkPath,
              depth: 1,
              blob_id: "chunk-id",
              is_multi_file: false,
            },
            childTask,
          ],
        },
        {
          task: {
            path: chunkPath,
            depth: 1,
            blob_id: "chunk-id",
            is_multi_file: false,
          },
          reports: [
            {
              __typename__: "StatReport",
              path: chunkPath,
              size: 4,
              is_file: true,
              is_dir: false,
              is_link: false,
              link_target: null,
            },
          ],
          subtasks: [],
        },
        {
          task: childTask,
          reports: [
            {
              __typename__: "StatReport",
              path: outputPath,
              size: 0,
              is_dir: true,
              is_file: false,
              is_link: false,
              link_target: null,
            },
          ],
          subtasks: [],
        },
      ],
      context,
    );

    expect(normalized.coverage).toBe("partial");
    expect(normalized.derivations).toEqual([
      {
        parent_path: "$input",
        child_path: "$output/chunk-child",
        provider_blob_id: "chunk-id",
        handler: "gzip",
        parent_file_range: { offset: 4, length: 6 },
      },
      {
        parent_path: "$input",
        child_path: "$output/multi",
        provider_blob_id: "multi-id",
        handler: "multipart-firmware",
        parent_file_range: null,
      },
    ]);
    expect(normalized.diagnostics).toEqual([
      {
        input_path: "$input",
        stage: "multipart-firmware",
        missing_dependencies: ["sasquatch"],
        report: multiFileReport,
      },
    ]);
  });
});

describe("Unblob blob identity validation", () => {
  it("joins reports within each parent, allows missing provenance and rejects local duplicates", () => {
    const rootChild = {
      path: `${context.outputRoot}/root-child`,
      depth: 1,
      blob_id: "shared-id",
      is_multi_file: false,
    };
    const containerTask = {
      path: `${context.outputRoot}/container`,
      depth: 1,
      blob_id: "container-id",
      is_multi_file: false,
    };
    const nestedChild = {
      path: `${context.outputRoot}/container/nested-child`,
      depth: 2,
      blob_id: "shared-id",
      is_multi_file: false,
    };
    const fileRecord = <T extends { path: string }>(task: T) => ({
      task,
      reports: [
        {
          __typename__: "StatReport",
          path: task.path,
          size: 1,
          is_file: true,
          is_dir: false,
          is_link: false,
          link_target: null,
        },
      ],
      subtasks: [],
    });
    const chunk = (
      id: string,
      handler: string,
      start: number,
      end: number,
    ) => ({
      __typename__: "ChunkReport",
      id,
      start_offset: start,
      end_offset: end,
      size: end - start,
      handler_name: handler,
      is_encrypted: false,
      extraction_reports: [],
    });
    const base = root();
    const rootReports = [
      ...base.reports.filter(
        (report) => report.__typename__ !== "UnknownChunkReport",
      ),
      chunk("shared-id", "root-handler", 0, 4),
      chunk("container-id", "container-handler", 4, 10),
    ];
    const normalized = normalizeUnblobReport(
      [
        {
          ...base,
          reports: rootReports,
          subtasks: [rootChild, containerTask],
        },
        fileRecord(rootChild),
        {
          task: containerTask,
          reports: [
            {
              __typename__: "StatReport",
              path: containerTask.path,
              size: 10,
              is_file: true,
              is_dir: false,
              is_link: false,
              link_target: null,
            },
            chunk("shared-id", "nested-handler", 2, 5),
          ],
          subtasks: [nestedChild],
        },
        fileRecord(nestedChild),
      ],
      context,
    );

    expect(normalized.derivations).toMatchObject([
      { handler: "root-handler", parent_file_range: { offset: 0, length: 4 } },
      {
        handler: "container-handler",
        parent_file_range: { offset: 4, length: 6 },
      },
      {
        handler: "nested-handler",
        parent_file_range: { offset: 2, length: 3 },
      },
    ]);

    const noOrigin = {
      ...base,
      reports: base.reports.filter(
        (report) => report.__typename__ !== "UnknownChunkReport",
      ),
      subtasks: [rootChild],
    };
    expect(
      normalizeUnblobReport([noOrigin, fileRecord(rootChild)], context)
        .derivations[0],
    ).toMatchObject({ handler: null, parent_file_range: null });

    expect(() =>
      normalizeUnblobReport(
        [
          {
            ...base,
            reports: [...rootReports, chunk("shared-id", "duplicate", 10, 12)],
            subtasks: [rootChild],
          },
          fileRecord(rootChild),
        ],
        context,
      ),
    ).toThrow("Duplicate blob identity in parent task");
  });
});

describe("firmware producer boundaries", () => {
  it("rejects unknown tasks outside the owned output and disconnected task graphs", () => {
    const record = root();
    for (const path of [
      "/private/output/../escaped",
      "/private/output/unconnected",
    ]) {
      const child = { ...record, task: { ...record.task, path, depth: 1 } };
      expect(() => normalizeUnblobReport([record, child], context)).toThrow();
    }
  });
  it("rejects absent root identity, inconsistent chunk bounds and duplicate tasks", () => {
    const record = root();
    expect(() => normalizeUnblobReport([], context)).toThrow("exactly one");
    expect(() =>
      normalizeUnblobReport(
        [
          {
            ...record,
            reports: record.reports.filter(
              (report) => report.__typename__ !== "HashReport",
            ),
          },
        ],
        context,
      ),
    ).toThrow("hash");
    expect(() =>
      normalizeUnblobReport(
        [
          {
            ...record,
            reports: [
              ...record.reports,
              {
                __typename__: "UnknownChunkReport",
                id: "bad",
                start_offset: 10,
                end_offset: 21,
                size: 11,
              },
            ],
          },
        ],
        context,
      ),
    ).toThrow("bounds");
    expect(() => normalizeUnblobReport([record, record], context)).toThrow(
      "exactly one",
    );
  });
  it("rejects empty, combined and extracting Binwalk reports", () => {
    const record = {
      Analysis: { file_path: context.inputPath, file_map: [], extractions: {} },
    };
    expect(normalizeBinwalkReport([record], context.inputPath, 20)).toEqual([]);
    for (const report of [
      [],
      [record, record],
      [
        {
          Analysis: {
            ...record.Analysis,
            extractions: { hit: { status: "success" } },
          },
        },
      ],
    ])
      expect(() =>
        normalizeBinwalkReport(report, context.inputPath, 20),
      ).toThrow();
  });
});
