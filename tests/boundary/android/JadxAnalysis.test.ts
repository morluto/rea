import { expect, it } from "vitest";

import {
  analyzeJadxRequest,
  type JadxToolPort,
} from "../../../src/android/JadxAnalysis.js";
import { androidInputSchemas } from "../../../src/domain/android/androidAnalysis.js";

const summary = {
  full_name: "fixture.Target",
  name: "Target",
  method_count: 2,
  field_count: 0,
  inner_class_count: 0,
  methods: [
    {
      name: "choose",
      signature: "choose(String): void",
      dex_descriptor: "(Ljava/lang/String;)V",
      is_constructor: false,
      def_pos: 0,
    },
    {
      name: "choose",
      signature: "choose(int): void",
      dex_descriptor: "(I)V",
      is_constructor: false,
      def_pos: 0,
    },
  ],
  fields: [],
  inner_classes: [],
};

const engine = {
  name: "jadx",
  version: "0.7.1",
  artifact_sha256: "a".repeat(64),
  source_revision: null,
  worker_count: 1,
  heap_limit_mib: null,
};

it("publishes exact DEX prototypes instead of discarding bridge metadata", async () => {
  const tools: JadxToolPort = {
    json: () => Promise.resolve(summary),
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const result = await analyzeJadxRequest(
    tools,
    {
      operation: "inspect_android_class",
      input: androidInputSchemas.inspect_android_class.parse({
        path: "/fixture.apk",
        class_name: "fixture.Target",
      }),
    },
    {} as never,
    engine,
  );
  expect(result).toMatchObject({
    methods: [
      { name: "choose", dex_descriptor: "(Ljava/lang/String;)V" },
      { name: "choose", dex_descriptor: "(I)V" },
    ],
  });
});

it("traces only the selected overloaded method and checks the producer identity", async () => {
  const calls: Record<string, unknown>[] = [];
  const tools: JadxToolPort = {
    json: (name, input) => {
      calls.push({ name, ...input });
      if (name === "get_class_summary") return Promise.resolve(summary);
      return Promise.resolve({
        target: "fixture.Target.choose",
        overload_index: 1,
        reported_signature: "choose(int): void",
        total: 1,
        count: 1,
        resolve_line: false,
        items: [
          {
            kind: "method",
            name: "caller",
            full_name: "fixture.Other.caller",
            containing_class: "fixture.Other",
            top_class: "fixture.Other",
            def_pos: 0,
            direct_invokes: [
              {
                dex_entry: "classes.dex",
                source_raw_method_id: "fixture.Other.caller()V",
                dex_code_unit_offset: 0,
                dex_method_index: 1,
                opcode: "INVOKE_STATIC",
              },
              {
                dex_entry: "classes.dex",
                source_raw_method_id: "fixture.Other.caller()V",
                dex_code_unit_offset: 3,
                dex_method_index: 1,
                opcode: "INVOKE_STATIC",
              },
            ],
          },
        ],
      });
    },
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const request = {
    operation: "trace_android_references",
    input: androidInputSchemas.trace_android_references.parse({
      path: "/fixture.apk",
      class_name: "fixture.Target",
      method_name: "choose",
      overload_index: 1,
    }),
  } as const;
  const result = await analyzeJadxRequest(tools, request, {} as never, engine);
  expect(result).toMatchObject({
    method_name: "choose",
    overload_index: 1,
    reported_signature: "choose(int): void",
    dex_descriptor: "(I)V",
    total: 1,
    reference_unit: "using_node",
    references: [
      {
        direct_invokes: [
          { dex_code_unit_offset: 0 },
          { dex_code_unit_offset: 3 },
        ],
      },
    ],
  });
  expect(calls[1]).toMatchObject({
    name: "get_xrefs_to_method",
    overload_index: 1,
  });
});

it("rejects an ambiguous method and a producer response for a different overload", async () => {
  const xrefs = {
    target: "fixture.Target.choose",
    overload_index: 0,
    reported_signature: "choose(String): void",
    total: 0,
    count: 0,
    resolve_line: false,
    items: [],
  };
  const tools: JadxToolPort = {
    json: (name) =>
      Promise.resolve(name === "get_class_summary" ? summary : xrefs),
    text: () => Promise.reject(new Error("unexpected text call")),
  };
  const input = {
    path: "/fixture.apk",
    class_name: "fixture.Target",
    method_name: "choose",
  };
  await expect(
    analyzeJadxRequest(
      tools,
      {
        operation: "trace_android_references",
        input,
      },
      {} as never,
      engine,
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisInputError",
  });
  await expect(
    analyzeJadxRequest(
      tools,
      {
        operation: "trace_android_references",
        input: { ...input, overload_index: 1 },
      },
      {} as never,
      engine,
    ),
  ).rejects.toMatchObject({
    _tag: "AnalysisOutputError",
  });
});

const invokeSite = {
  dex_entry: "classes.dex",
  source_raw_method_id: "fixture.Other.caller()V",
  dex_code_unit_offset: 0,
  dex_method_index: 1,
  opcode: "INVOKE_STATIC",
};
const traceWithReference = (fields: Record<string, unknown>) =>
  analyzeJadxRequest(
    {
      json: (name) =>
        Promise.resolve(
          name === "get_class_summary"
            ? summary
            : {
                target: "fixture.Target.choose",
                overload_index: 0,
                reported_signature: "choose(String): void",
                total: 1,
                count: 1,
                resolve_line: false,
                items: [
                  {
                    kind: "method",
                    name: "caller",
                    full_name: "fixture.Other.caller",
                    containing_class: "fixture.Other",
                    top_class: "fixture.Other",
                    def_pos: 0,
                    ...fields,
                  },
                ],
              },
        ),
      text: () => Promise.reject(new Error("unexpected text call")),
    },
    {
      operation: "trace_android_references",
      input: {
        path: "/fixture.apk",
        class_name: "fixture.Target",
        method_name: "choose",
        overload_index: 0,
      },
    },
    {} as never,
    engine,
  );

it.each([
  [{}, null],
  [{ direct_invokes: [] }, []],
])(
  "preserves unavailable versus observed-empty invoke sites: %j",
  async (fields, expected) => {
    const result = await traceWithReference(fields as Record<string, unknown>);
    expect(result).toMatchObject({
      references: [{ direct_invokes: expected }],
    });
  },
);

it.each([
  { ...invokeSite, dex_code_unit_offset: -1 },
  {
    dex_entry: "classes.dex",
    source_raw_method_id: "fixture.Other.caller()V",
    dex_code_unit_offset: 0,
    dex_method_index: 1,
  },
])("rejects malformed direct invoke producer evidence: %j", async (site) => {
  await expect(
    traceWithReference({ direct_invokes: [site] }),
  ).rejects.toThrow();
});

it("preserves bounded instruction coverage separately from using-node coverage", async () => {
  const result = await traceWithReference({
    direct_invokes: [invokeSite],
    direct_invokes_exhaustive: false,
  });
  expect(result).toMatchObject({
    coverage: "complete",
    reference_unit: "using_node",
    references: [
      { direct_invokes: [invokeSite], direct_invokes_exhaustive: false },
    ],
  });
});

it("rejects malformed method descriptors at the Android adapter boundary", async () => {
  const invalidSummary = {
    ...summary,
    methods: summary.methods.map((method) => ({
      ...method,
      dex_descriptor: "not-a-dex-descriptor",
    })),
  };
  await expect(
    analyzeJadxRequest(
      {
        json: () => Promise.resolve(invalidSummary),
        text: () => Promise.reject(new Error("unexpected text call")),
      },
      {
        operation: "inspect_android_class",
        input: { path: "/fixture.apk", class_name: "fixture.Target" },
      },
      {} as never,
      engine,
    ),
  ).rejects.toThrow();
});
