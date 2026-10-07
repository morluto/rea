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
  it("retains nested MultiFile extraction failures in partial coverage", () => {
    const outputPath = `${context.outputRoot}/multi`;
    const childTask = {
      path: outputPath,
      depth: 1,
      blob_id: "multi-id",
      is_multi_file: true,
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
          reports: parent.reports.filter(
            (item) => item.__typename__ !== "UnknownChunkReport",
          ),
          subtasks: [childTask],
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
            multiFileReport,
          ],
          subtasks: [],
        },
      ],
      context,
    );

    expect(normalized.coverage).toBe("partial");
    expect(normalized.diagnostics).toEqual([
      { input_path: "$output/multi", report: multiFileReport },
    ]);
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
