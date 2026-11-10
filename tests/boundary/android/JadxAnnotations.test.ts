import { expect, it } from "vitest";

import {
  analyzeJadxRequest,
  type JadxToolPort,
} from "../../../src/android/JadxAnalysis.js";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";

const engine = {
  name: "jadx",
  version: "0.7.1",
  artifact_sha256: "a".repeat(64),
  source_revision: null,
  worker_count: 1,
  heap_limit_mib: null,
};

/** An interface method as the bridge reports it: a path, a header list and a parameter. */
const endpoint = {
  name: "scan",
  raw_name: "scan",
  signature: "scan(RequestBody, Continuation): Object",
  dex_descriptor:
    "(Lokhttp3/RequestBody;Lkotlin/coroutines/Continuation;)Ljava/lang/Object;",
  is_constructor: false,
  def_pos: 0,
  annotations: [
    {
      dex_type: "Lretrofit2/http/Headers;",
      visibility: "runtime",
      elements: [
        {
          name: "value",
          value: {
            type: "array",
            item_count: 1,
            items: [
              { type: "string", value: "Content-Type: application/json" },
            ],
          },
        },
      ],
    },
    {
      dex_type: "Lretrofit2/http/POST;",
      visibility: "runtime",
      elements: [
        { name: "value", value: { type: "string", value: "v1/items/lookup" } },
      ],
    },
  ],
  parameter_annotations: [
    {
      index: 0,
      annotations: [
        {
          dex_type: "Lretrofit2/http/Body;",
          visibility: "runtime",
          elements: [],
        },
      ],
    },
  ],
};
const plain = {
  name: "close",
  raw_name: "close",
  signature: "close(): void",
  dex_descriptor: "()V",
  is_constructor: false,
  def_pos: 0,
};

const classSummary = (extra: Record<string, unknown> = {}) => ({
  full_name: "fixture.Api",
  raw_name: "fixture.Api",
  name: "Api",
  method_count: 2,
  field_count: 0,
  inner_class_count: 0,
  methods: [plain, endpoint],
  fields: [],
  inner_classes: [],
  inner_class_raw_names: [],
  ...extra,
});

const toolsReplying = (
  summary: Record<string, unknown>,
  calls: Record<string, unknown>[] = [],
): JadxToolPort => ({
  listClasses: () => Promise.reject(new Error("unexpected class inventory")),
  text: () => Promise.reject(new Error("unexpected text call")),
  json: (name, input) => {
    calls.push({ name, ...input });
    if (name === "get_class_summary")
      return Promise.resolve(summary as JsonValue);
    if (name === "get_method_body")
      return Promise.resolve({
        class_name: "fixture.Api",
        method_name: input.method_name as string,
        full_name: `fixture.Api.${String(input.method_name)}`,
        overload_index: 0,
        overload_count: 1,
        dex_descriptor:
          input.method_name === "scan" ? endpoint.dex_descriptor : "()V",
        mode: "java",
        fell_back: false,
        markers: ["abstract_method"],
        body: "",
      });
    return Promise.reject(new Error(`unexpected ${name}`));
  },
});

const inspectMethod = (methodName: string, summary = classSummary()) =>
  analyzeJadxRequest(
    toolsReplying(summary),
    {
      operation: "inspect_android_method",
      input: {
        path: "/fixture.apk",
        class_name: "fixture.Api",
        method_name: methodName,
      },
    },
    { loaded: {} as never, engine },
  );

it("reports the annotations of an interface method without inferring what they mean", async () => {
  const result = androidResultSchemas.inspect_android_method.parse(
    await inspectMethod("scan"),
  );
  expect(result.body_status).toBe("not_available");
  expect(result.method.annotations).toEqual(endpoint.annotations);
  expect(result.method.parameter_annotations).toEqual(
    endpoint.parameter_annotations,
  );
  // Only the observed facts are present: no HTTP verb, path or body field is derived.
  expect(Object.keys(result.method).sort()).toEqual(
    [
      "annotations",
      "dex_descriptor",
      "is_constructor",
      "name",
      "overload_index",
      "parameter_annotations",
      "reported_signature",
    ].sort(),
  );
});

it("reports empty lists, not unknown, for a method with no annotations", async () => {
  const result = androidResultSchemas.inspect_android_method.parse(
    await inspectMethod("close"),
  );
  expect(result.method.annotations).toEqual([]);
  expect(result.method.parameter_annotations).toEqual([]);
});

it("keeps annotation bounds visible on the selected method", async () => {
  const bounded = {
    ...endpoint,
    annotations: [
      {
        dex_type: "Lkotlin/Metadata;",
        visibility: "runtime",
        truncated: true,
        elements: [
          {
            name: "d1",
            value: {
              type: "array",
              item_count: 40,
              items: [
                {
                  type: "string",
                  value: "x".repeat(256),
                  truncated: true,
                  length: 900,
                },
              ],
            },
          },
          {
            name: "nested",
            value: {
              type: "annotation",
              dex_type: "Lfixture/Inner;",
              element_count: 2,
              elements_omitted: true,
            },
          },
          {
            name: "later",
            value: { type: "unsupported", jadx_type: "ENCODED_X" },
          },
        ],
      },
    ],
    annotations_omitted: 3,
  };
  const result = androidResultSchemas.inspect_android_method.parse(
    await inspectMethod("scan", classSummary({ methods: [plain, bounded] })),
  );
  expect(result.method.annotations?.[0]?.truncated).toBe(true);
  expect(result.method.annotations_omitted).toBe(3);
});

it("reports annotations in a class only when the caller asked for them", async () => {
  const calls: Record<string, unknown>[] = [];
  const asked = androidResultSchemas.inspect_android_class.parse(
    await analyzeJadxRequest(
      toolsReplying(
        classSummary({
          annotations: [
            { dex_type: "Lfixture/Marker;", visibility: "build", elements: [] },
          ],
          annotations_omitted: 1,
        }),
        calls,
      ),
      {
        operation: "inspect_android_class",
        input: {
          path: "/fixture.apk",
          class_name: "fixture.Api",
          annotations: true,
        },
      },
      { loaded: {} as never, engine },
    ),
  );
  expect(calls[0]).toMatchObject({ annotations: true });
  expect(asked.annotations).toEqual([
    { dex_type: "Lfixture/Marker;", visibility: "build", elements: [] },
  ]);
  expect(asked.annotations_omitted).toBe(1);
  // A member without annotations carries no list; only the annotated one does.
  expect(
    asked.methods.map((method) => method.annotations !== undefined),
  ).toEqual([false, true]);

  const defaultCalls: Record<string, unknown>[] = [];
  const plainResult = androidResultSchemas.inspect_android_class.parse(
    await analyzeJadxRequest(
      toolsReplying(
        classSummary({ methods: [plain, { ...plain, name: "open" }] }),
        defaultCalls,
      ),
      {
        operation: "inspect_android_class",
        input: { path: "/fixture.apk", class_name: "fixture.Api" },
      },
      { loaded: {} as never, engine },
    ),
  );
  expect(defaultCalls[0]).not.toHaveProperty("annotations");
  expect(plainResult).not.toHaveProperty("annotations");
  expect(plainResult).not.toHaveProperty("annotations_omitted");
});

it.each([
  ["an unknown value kind", { type: "regex", value: "x" }],
  [
    "a nested array",
    {
      type: "array",
      item_count: 1,
      items: [{ type: "array", item_count: 0, items: [] }],
    },
  ],
  ["an undeclared member", { type: "string", value: "x", extra: true }],
  ["a non-DEX type value", { type: "type", value: "java.lang.String" }],
])("refuses a malformed annotation value: %s", async (_label, value) => {
  const malformed = {
    ...endpoint,
    annotations: [
      {
        dex_type: "Lfixture/Marker;",
        visibility: "runtime",
        elements: [{ name: "value", value }],
      },
    ],
  };
  await expect(
    inspectMethod("scan", classSummary({ methods: [plain, malformed] })),
  ).rejects.toMatchObject({ _tag: "AnalysisOutputError" });
});

it("refuses an annotation that is not named by a DEX type or has an unknown retention", async () => {
  for (const annotation of [
    { dex_type: "retrofit2.http.POST", visibility: "runtime", elements: [] },
    { dex_type: "Lretrofit2/http/POST;", visibility: "source", elements: [] },
  ])
    await expect(
      inspectMethod(
        "scan",
        classSummary({
          methods: [plain, { ...endpoint, annotations: [annotation] }],
        }),
      ),
    ).rejects.toMatchObject({ _tag: "AnalysisOutputError" });
});

it("parses Evidence retained before annotations were read as unknown, not as none", () => {
  const old = androidResultSchemas.inspect_android_method.parse({
    engine,
    class_name: "fixture.Api",
    method: {
      name: "scan",
      reported_signature: "scan(): void",
      overload_index: 0,
      is_constructor: false,
      dex_descriptor: "()V",
    },
    overload_count: 1,
    representation: "java",
    body_status: "not_available",
    fell_back: false,
    markers: ["abstract_method"],
    source: { status: "complete", text: "", reported_total_bytes: null },
  });
  expect(old.method).not.toHaveProperty("annotations");
  expect(old.method).not.toHaveProperty("parameter_annotations");
});
