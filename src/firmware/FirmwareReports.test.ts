import { describe, expect, it } from "vitest";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
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

describe("firmware producer chunk observations", () => {
  it("retains unknown chunks and their selected original-file range", () => {
    const normalized = normalizeUnblobReport([root()], context);
    expect(normalized.coverage).toBe("partial");
    expect(normalized.chunks[0]).toMatchObject({
      handler: null,
      range: { offset: 0, length: 20 },
      root_file_range: { offset: 64, length: 20 },
    });
    expect(normalized.missing_dependencies).toEqual([]);
  });
});

it("orders dependency names by chunk identity and leaves sibling chunks and the task unclaimed", () => {
  const record = root();
  const chunk = (
    id: string,
    start: number,
    end: number,
    dependencies: string[],
  ) => ({
    __typename__: "ChunkReport",
    id,
    start_offset: start,
    end_offset: end,
    size: end - start,
    handler_name: "archive",
    is_encrypted: false,
    extraction_reports:
      dependencies.length === 0
        ? []
        : [
            {
              __typename__: "ExtractorDependencyNotFoundReport",
              severity: "ERROR",
              dependencies,
            },
          ],
  });
  const normalized = normalizeUnblobReport(
    [
      {
        ...record,
        reports: [
          ...record.reports.filter(
            (item) => item.__typename__ !== "UnknownChunkReport",
          ),
          chunk("b-id", 0, 6, ["b-tool"]),
          chunk("a-id", 6, 13, ["a-tool"]),
          chunk("plain-id", 13, 20, []),
        ],
      },
    ],
    context,
  );
  expect(normalized.missing_dependencies).toEqual([]);
  expect(normalized.chunk_missing_dependencies).toEqual([
    { input_path: "$input", provider_id: "a-id", dependencies: ["a-tool"] },
    { input_path: "$input", provider_id: "b-id", dependencies: ["b-tool"] },
  ]);
  expect(
    normalized.chunks.map(({ provider_id, extraction_failure_kinds }) => [
      provider_id,
      extraction_failure_kinds,
    ]),
  ).toEqual([
    ["b-id", ["missing-extractor-dependency"]],
    ["a-id", ["missing-extractor-dependency"]],
    ["plain-id", []],
  ]);
});

const registerFirmwareDiagnosticOutcomeCases = () => {
  const outcomes = [
    {
      name: "task exception",
      report: {
        __typename__: "UnknownError",
        severity: "ERROR",
        exception: "inert fixture",
      },
      failed: true,
    },
    {
      name: "future declared error",
      report: { __typename__: "FutureProducerError", severity: "ERROR" },
      failed: true,
    },
    {
      name: "command warning",
      report: {
        __typename__: "ExtractCommandFailedReport",
        severity: "WARNING",
        command: "fixture",
        stdout: "",
        stderr: "",
        exit_code: 1,
      },
      failed: false,
    },
    {
      name: "resolved extraction problem",
      report: {
        __typename__: "ExtractionProblem",
        problem: "duplicate path",
        resolution: "kept first entry",
        path: "config",
      },
      failed: false,
    },
  ];

  it.each(["task", "chunk", "multi-file"] as const)(
    "preserves diagnostic outcomes at the %s owner",
    (owner) => {
      for (const { report, failed } of outcomes) {
        const record = root();
        const observation =
          owner === "task"
            ? report
            : owner === "chunk"
              ? {
                  __typename__: "ChunkReport",
                  id: "stage-id",
                  handler_name: "gzip",
                  start_offset: 0,
                  end_offset: 20,
                  size: 20,
                  is_encrypted: false,
                  extraction_reports: [report],
                }
              : {
                  __typename__: "MultiFileReport",
                  id: "stage-id",
                  handler_name: "gzip",
                  name: "rootfs",
                  paths: [],
                  extraction_reports: [report],
                };
        const normalized = normalizeUnblobReport(
          [
            {
              ...record,
              reports: [
                ...record.reports.filter(
                  (item) => item.__typename__ !== "UnknownChunkReport",
                ),
                observation,
              ],
            },
          ],
          context,
        );
        expect(normalized.coverage).toBe("partial");
        expect(normalized.diagnostics).toHaveLength(1);
        expect(normalized.diagnostics[0]).toMatchObject({
          input_path: "$input",
          report: owner === "multi-file" ? observation : report,
        });
        if (owner === "chunk") {
          expect(normalized.chunks[0]?.extraction_failure_kinds).toEqual(
            failed ? ["extractor-failure"] : [],
          );
          expect(normalized.failed_extraction_stages).toEqual([]);
        } else {
          expect(normalized.failed_extraction_stages).toEqual(
            failed
              ? [
                  {
                    input_path: "$input",
                    provider_id: owner === "task" ? null : "stage-id",
                    handler: owner === "task" ? null : "gzip",
                    dependencies: [],
                    kind: "extractor-failure",
                  },
                ]
              : [],
          );
        }
      }
    },
  );
};

describe("firmware producer error severity", () => {
  registerFirmwareDiagnosticOutcomeCases();
});

describe("Unblob chunk extraction diagnostics", () => {
  it.each([
    { dependencies: ["sasquatch"], names: ["sasquatch", "nested-tool"] },
    { dependencies: ["sasquatch", ""], names: ["sasquatch", "nested-tool"] },
    { dependencies: [], names: ["nested-tool"] },
  ])(
    "retains nested dependency diagnostics beneath $dependencies",
    ({ dependencies, names }) => {
      const dependencyFailure = {
        __typename__: "ExtractorDependencyNotFoundReport",
        severity: "ERROR",
        dependencies,
        nested_reports: [
          {
            __typename__: "ExtractorDependencyNotFoundReport",
            dependencies: ["nested-tool", "nested-tool"],
          },
        ],
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
          missing_dependencies: names,
          report: dependencyFailure,
        },
      ]);
      expect(normalized.chunk_missing_dependencies).toEqual([
        ...(dependencies.includes("sasquatch")
          ? [
              {
                input_path: "$input",
                provider_id: "gzip-id",
                dependencies: ["sasquatch"],
              },
            ]
          : []),
        ...(dependencies.length === 0 || dependencies.includes("")
          ? [
              {
                input_path: "$input",
                provider_id: "gzip-id",
                dependencies: [],
              },
            ]
          : []),
      ]);
    },
  );
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
    expect(normalized.failed_extraction_stages).toEqual([
      {
        input_path: "$input",
        provider_id: "multi-id",
        handler: "multipart-firmware",
        dependencies: ["sasquatch"],
        kind: "missing-extractor-dependency",
      },
    ]);
  });
});

describe("failed multi-file extraction stages", () => {
  it("attributes both failures to their nested multi-file stage", () => {
    const outputPath = `${context.outputRoot}/multi`;
    const childTask = {
      path: outputPath,
      depth: 1,
      blob_id: "multi-id",
      is_multi_file: true,
    };
    const stageFailure = {
      __typename__: "UnknownError",
      severity: "ERROR",
      exception: "inert multi-file extraction failure",
    };
    const missingTool = {
      __typename__: "ExtractorDependencyNotFoundReport",
      severity: "ERROR",
      dependencies: ["sasquatch"],
    };
    const record = root();
    const normalized = normalizeUnblobReport(
      [
        {
          ...record,
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
            {
              __typename__: "MultiFileReport",
              id: "multi-id",
              handler_name: "multipart-firmware",
              name: "rootfs",
              paths: [`${outputPath}/part-a`],
              extraction_reports: [missingTool, stageFailure],
            },
          ],
          subtasks: [],
        },
      ],
      context,
    );
    expect(normalized.failed_extraction_stages).toEqual([
      {
        input_path: "$output/multi",
        provider_id: "multi-id",
        handler: "multipart-firmware",
        dependencies: ["sasquatch"],
        kind: "missing-extractor-dependency",
      },
      {
        input_path: "$output/multi",
        provider_id: "multi-id",
        handler: "multipart-firmware",
        dependencies: [],
        kind: "extractor-failure",
      },
    ]);
    expect(normalized.missing_dependencies).toEqual([]);
    expect(normalized.chunk_missing_dependencies).toEqual([]);
    expect(normalized.diagnostics).toEqual([
      expect.objectContaining({
        input_path: "$output/multi",
        stage: "multipart-firmware",
        missing_dependencies: ["sasquatch"],
      }),
    ]);
  });
});

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
  it("requires each task to be contained, unique, and reachable from the selected input", () => {
    const child = fileRecord({
      path: `${context.outputRoot}/child`,
      depth: 1,
      blob_id: "child-id",
      is_multi_file: false,
    });
    const outside = fileRecord({
      ...child.task,
      path: `${context.outputRoot}/../escaped`,
    });
    const record = root();
    const connected = { ...record, subtasks: [child.task] };
    expect(
      normalizeUnblobReport([child, connected], context).derivations,
    ).toEqual([
      {
        parent_path: "$input",
        child_path: "$output/child",
        provider_blob_id: "child-id",
        handler: null,
        parent_file_range: null,
      },
    ]);
    // Reference the escaped child from the root so absence of confinement
    // cannot be masked by a later disconnected-task rejection.
    const connectedOutside = { ...record, subtasks: [outside.task] };
    expect(() =>
      normalizeUnblobReport([connectedOutside, outside], context),
    ).toThrow(AnalysisOutputError);
    expect(() => normalizeUnblobReport([record, child], context)).toThrow(
      AnalysisOutputError,
    );
    expect(() =>
      normalizeUnblobReport([connected, child, child], context),
    ).toThrow(AnalysisOutputError);
    expect(() =>
      normalizeUnblobReport(
        [connected, { ...child, reports: outside.reports }],
        context,
      ),
    ).toThrow(AnalysisOutputError);
  });

  it("requires unique root identity and valid chunk bounds", () => {
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
      ).toThrow(AnalysisOutputError);
  });
});

describe("selected firmware byte coverage", () => {
  const known = (id: string, start: number, end: number) => ({
    __typename__: "ChunkReport",
    id,
    start_offset: start,
    end_offset: end,
    size: end - start,
    handler_name: "gzip",
    is_encrypted: false,
    extraction_reports: [],
  });
  it.each([
    { name: "empty chunk inventory", spans: [], gaps: [[0, 20]] },
    {
      name: "internal and trailing holes",
      spans: [
        [2, 5],
        [7, 10],
      ],
      gaps: [
        [0, 2],
        [5, 2],
        [10, 10],
      ],
    },
    {
      name: "overlapping unordered coverage",
      spans: [
        [8, 20],
        [0, 10],
        [2, 4],
      ],
      gaps: [],
    },
    {
      name: "adjacent coverage",
      spans: [
        [10, 20],
        [0, 10],
      ],
      gaps: [],
    },
  ] as const)(
    "derives $name from byte intervals without invented chunk identities",
    ({ spans, gaps }) => {
      const record = root();
      const reports = record.reports.filter(
        (report) => report.__typename__ !== "UnknownChunkReport",
      );
      const normalized = normalizeUnblobReport(
        [
          {
            ...record,
            reports: [
              ...reports,
              ...spans.map(([start, end], index) =>
                known(String(index), start, end),
              ),
            ],
          },
        ],
        context,
      );
      expect(normalized.coverage).toBe(
        gaps.length > 0 ? "partial" : "complete",
      );
      expect(normalized.unclassified_ranges).toEqual(
        gaps.map(([offset, length]) => ({
          input_path: "$input",
          range: { offset, length },
          root_file_range: { offset: 64 + offset, length },
        })),
      );
      expect(normalized.chunks).toHaveLength(spans.length);
    },
  );
});

const reportsAtProblemOwner = (
  owner: "task" | "chunk" | "multi-file",
  problems: readonly Record<string, unknown>[],
) => {
  if (owner === "task") return problems;
  const common = {
    id: "problem-owner",
    handler_name: "fixture-handler",
    extraction_reports: problems,
  };
  return [
    owner === "chunk"
      ? {
          ...common,
          __typename__: "ChunkReport",
          start_offset: 0,
          end_offset: 20,
          size: 20,
          is_encrypted: false,
        }
      : {
          ...common,
          __typename__: "MultiFileReport",
          name: "parts",
          paths: [],
        },
  ];
};

const dependencyProblem = (
  dependencies: unknown[],
  producer_detail: string,
) => ({
  __typename__: "ExtractorDependencyNotFoundReport",
  severity: "ERROR",
  dependencies,
  producer_detail,
});

const dependencyCases = [
  {
    name: "named and unnamed dependencies beside an independent error",
    problems: [
      dependencyProblem(
        ["z-tool", "", "a-tool", "z-tool"],
        "named source declaration",
      ),
      dependencyProblem(["", ""], "unnamed source declaration"),
      { __typename__: "UnknownError", severity: "ERROR" },
    ],
    dependencies: [["a-tool", "z-tool"], []],
    missingNames: ["z-tool", "a-tool"],
    independentError: true,
  },
  {
    name: "an empty dependency list",
    problems: [dependencyProblem([], "dependency identity unavailable")],
    dependencies: [[]],
    missingNames: [],
    independentError: false,
  },
  {
    name: "an all-blank dependency list",
    problems: [dependencyProblem(["", ""], "blank source declaration")],
    dependencies: [[]],
    missingNames: [],
    independentError: false,
  },
  {
    name: "a malformed dependency list",
    problems: [
      dependencyProblem(["alleged-tool", 42], "malformed source declaration"),
    ],
    dependencies: [],
    missingNames: [],
    independentError: true,
  },
];

describe.each(["task", "chunk", "multi-file"] as const)(
  "firmware $0 dependency ownership",
  (owner) => {
    it.each(dependencyCases)(
      "attributes $name only to the producing stage",
      ({ problems, dependencies, missingNames, independentError }) => {
        const observations = reportsAtProblemOwner(owner, problems);
        const record = root();
        const normalized = normalizeUnblobReport(
          [
            {
              ...record,
              reports: [...record.reports.slice(0, 2), ...observations],
            },
          ],
          context,
        );
        const input_path = "$input";
        const provider_id = "problem-owner";
        expect(normalized.missing_dependencies).toEqual(
          owner === "task"
            ? dependencies.map((names) => ({ input_path, dependencies: names }))
            : [],
        );
        expect(normalized.chunk_missing_dependencies).toEqual(
          owner === "chunk"
            ? dependencies.map((names) => ({
                input_path,
                provider_id,
                dependencies: names,
              }))
            : [],
        );
        if (owner === "chunk") {
          expect(normalized.chunks[0]?.extraction_failure_kinds).toEqual([
            ...(dependencies.length === 0
              ? []
              : ["missing-extractor-dependency"]),
            ...(independentError ? ["extractor-failure"] : []),
          ]);
        }

        const stage = { input_path, provider_id, handler: "fixture-handler" };
        const errorOwner =
          owner === "multi-file"
            ? stage
            : { input_path, provider_id: null, handler: null };
        expect(normalized.failed_extraction_stages).toEqual([
          ...(owner === "multi-file"
            ? dependencies.map((names) => ({
                ...stage,
                dependencies: names,
                kind: "missing-extractor-dependency",
              }))
            : []),
          ...(owner !== "chunk" && independentError
            ? [
                {
                  ...errorOwner,
                  dependencies: [],
                  kind: "extractor-failure",
                },
              ]
            : []),
        ]);
        expect(normalized.diagnostics).toEqual(
          (owner === "multi-file" ? observations : problems).map(
            (report, index) => ({
              input_path,
              ...(owner === "task" ? {} : { stage: "fixture-handler" }),
              ...(missingNames.length > 0 && owner !== "task" && index === 0
                ? { missing_dependencies: missingNames }
                : {}),
              report,
            }),
          ),
        );
        expect(normalized.coverage).toBe("partial");
      },
    );
  },
);
