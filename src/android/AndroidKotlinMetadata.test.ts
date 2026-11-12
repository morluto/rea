import { expect, it } from "vitest";
import { readAndroidKotlinMetadata } from "./AndroidKotlinMetadata.js";
import type { JadxToolPort } from "./JadxAnalysis.js";
import type { JsonValue } from "../domain/jsonValue.js";

const SNAPSHOT = "/admitted/immutable target.apk";

const listed = {
  class_name: "fixture.model.User",
  dex_entry: "classes.dex",
  metadata_kind: 1,
  kind: "class",
  metadata_version: "2.1.0",
  extra_int: 48,
  data_strings: 1,
  has_d2: true,
  decode: "not_requested",
};
const facts = () => ({
  scope: "apk-root-dex-kotlin-metadata",
  coverage: {
    status: "complete",
    dex_entries: 1,
    examined_dex_entries: 1,
    examined_classes: 40,
    classes_with_metadata: 3,
    undecodable_classes: 0,
  },
  versions: [
    { version: "1.9.0", classes: 1 },
    { version: "2.1.0", classes: 2 },
  ],
  kinds: [
    { kind: "class", classes: 2 },
    { kind: "file_facade", classes: 1 },
  ],
  matching_classes: 1,
  classes: [{ ...listed } as Record<string, unknown>],
  markers: {
    basis: "candidate-static-markers",
    kotlin_module_entries: {
      count: 2,
      names: [
        "META-INF/app_release.kotlin_module",
        "META-INF/domain.kotlin_module",
      ],
      truncated: false,
    },
    class_prefixes: [
      { marker: "compose", prefix: "androidx.compose.", classes: 7 },
      {
        marker: "kotlinx_coroutines",
        prefix: "kotlinx.coroutines.",
        classes: 3,
      },
      { marker: "kotlin_coroutines", prefix: "kotlin.coroutines.", classes: 0 },
    ],
  },
  unknowns: [] as string[],
});
const tools = (
  value: unknown,
  expectedInput: Record<string, JsonValue>,
): JadxToolPort => ({
  json: async (name, input) => {
    expect(name).toBe("rea_kotlin_metadata");
    expect(input).toEqual({ path: SNAPSHOT, ...expectedInput });
    return value as JsonValue;
  },
  text: async () => {
    throw new Error("Kotlin metadata must not request source");
  },
  listClasses: async () => {
    throw new Error("Kotlin metadata must not page display classes");
  },
});

it("asks the bridge for the default row limit and keeps raw rows", async () => {
  const source = facts();
  const actual = await readAndroidKotlinMetadata(
    tools(source, { limit: 100 }),
    SNAPSHOT,
    {},
  );
  expect(actual).toEqual(source);
});

it("forwards the caller's selection exactly", async () => {
  const source = facts();
  source.classes = [];
  source.matching_classes = 0;
  await readAndroidKotlinMetadata(
    tools(source, { limit: 5, package_prefix: "fixture.model" }),
    SNAPSHOT,
    { package_prefix: "fixture.model", limit: 5 },
  );
});

it("keeps a decoded declaration for the exact selected class", async () => {
  const source = facts();
  source.classes = [
    {
      ...listed,
      decode: "decoded",
      declaration: {
        class_kind: "interface",
        modality: "abstract",
        visibility: "public",
        is_data: false,
        functions_total: 1,
        functions: [
          {
            name: "fetch",
            jvm_name: "fetch",
            dex_descriptor:
              "(Ljava/lang/String;Lkotlin/coroutines/Continuation;)Ljava/lang/Object;",
            is_suspend: true,
            is_inline: false,
            is_operator: false,
            return_type: {
              classifier: "class",
              name: "fixture/model/User",
              nullable: true,
            },
          },
        ],
        properties_total: 0,
        properties: [],
      },
    },
  ];
  const actual = await readAndroidKotlinMetadata(
    tools(source, { limit: 100, class_name: "fixture.model.User" }),
    SNAPSHOT,
    { class_name: "fixture.model.User" },
  );
  expect(actual.classes[0]?.declaration?.functions?.[0]).toMatchObject({
    is_suspend: true,
    return_type: { nullable: true },
  });
});

it("keeps a malformed annotation as an explicit undecodable row", async () => {
  const source = facts();
  source.coverage.undecodable_classes = 1;
  source.versions = [{ version: "2.1.0", classes: 2 }];
  source.kinds = [{ kind: "class", classes: 2 }];
  source.matching_classes = 1;
  source.classes = [
    {
      class_name: "fixture.Broken",
      dex_entry: "classes.dex",
      decode: "undecodable",
      decode_failure: "kotlin.Metadata element k is not an int",
    },
  ];
  const actual = await readAndroidKotlinMetadata(
    tools(source, { limit: 100 }),
    SNAPSHOT,
    {},
  );
  expect(actual.classes[0]).not.toHaveProperty("kind");
  expect(actual.coverage.undecodable_classes).toBe(1);
});

it("keeps usable facts and explicit incomplete DEX coverage", async () => {
  const source = facts();
  source.coverage.status = "partial";
  source.coverage.dex_entries = 2;
  source.unknowns.push("classes2.dex cannot be read");
  expect(
    await readAndroidKotlinMetadata(
      tools(source, { limit: 100 }),
      SNAPSHOT,
      {},
    ),
  ).toEqual(source);
});

it("keeps candidate markers exactly as the producer observed them", async () => {
  const source = facts();
  const actual = await readAndroidKotlinMetadata(
    tools(source, { limit: 100 }),
    SNAPSHOT,
    {},
  );
  expect(actual.markers).toEqual(source.markers);
  expect(actual.markers.basis).toBe("candidate-static-markers");
});

it.each([
  (source: ReturnType<typeof facts>) => {
    source.markers.class_prefixes[0]!.classes = 41;
  },
  (source: ReturnType<typeof facts>) => {
    source.markers.kotlin_module_entries.count = 1;
  },
  (source: ReturnType<typeof facts>) => {
    source.markers.kotlin_module_entries.truncated = true;
  },
  (source: ReturnType<typeof facts>) => {
    source.markers.class_prefixes.push(source.markers.class_prefixes[0]!);
  },
  (source: ReturnType<typeof facts>) => {
    source.markers.basis = "runtime-use";
  },
  (source: ReturnType<typeof facts>) => {
    source.markers.class_prefixes[0]!.marker = "jetpack";
  },
])("rejects inconsistent or over-claiming markers (%#)", async (mutate) => {
  const source = facts();
  mutate(source);
  await expect(
    readAndroidKotlinMetadata(tools(source, { limit: 100 }), SNAPSHOT, {}),
  ).rejects.toMatchObject({ _tag: "AnalysisOutputError" });
});

it.each([
  (source: ReturnType<typeof facts>) => {
    source.matching_classes = 3;
  },
  (source: ReturnType<typeof facts>) => {
    source.coverage.examined_dex_entries = 2;
  },
  (source: ReturnType<typeof facts>) => {
    source.coverage.dex_entries = 2;
  },
  (source: ReturnType<typeof facts>) => {
    source.coverage.classes_with_metadata = 99;
  },
  (source: ReturnType<typeof facts>) => {
    source.versions = [{ version: "2.1.0", classes: 1 }];
  },
  (source: ReturnType<typeof facts>) => {
    source.kinds = [{ kind: "class", classes: 1 }];
  },
  (source: ReturnType<typeof facts>) => {
    source.matching_classes = 0;
  },
  (source: ReturnType<typeof facts>) => {
    source.unknowns.push("hidden incomplete input");
  },
  (source: ReturnType<typeof facts>) => {
    source.classes[0] = { ...listed, kind: "data_class" };
  },
  (source: ReturnType<typeof facts>) => {
    source.classes[0] = { ...listed, decode: "decoded" };
  },
  (source: ReturnType<typeof facts>) => {
    source.classes[0] = { ...listed, decode_failure: "unexpected" };
  },
  (source: ReturnType<typeof facts>) => {
    source.classes[0] = { ...listed, unreviewed_field: true };
  },
])("rejects malformed or inconsistent producer facts (%#)", async (mutate) => {
  const source = facts();
  mutate(source);
  await expect(
    readAndroidKotlinMetadata(tools(source, { limit: 100 }), SNAPSHOT, {}),
  ).rejects.toMatchObject({ _tag: "AnalysisOutputError" });
});

it("rejects a row for a class the caller did not select", async () => {
  await expect(
    readAndroidKotlinMetadata(
      tools(facts(), { limit: 100, class_name: "fixture.Other" }),
      SNAPSHOT,
      { class_name: "fixture.Other" },
    ),
  ).rejects.toMatchObject({ _tag: "AnalysisOutputError" });
});

it("rejects more listed rows than the requested limit", async () => {
  const source = facts();
  source.matching_classes = 2;
  source.classes = [{ ...listed }, { ...listed, class_name: "fixture.Second" }];
  await expect(
    readAndroidKotlinMetadata(tools(source, { limit: 1 }), SNAPSHOT, {
      limit: 1,
    }),
  ).rejects.toMatchObject({ _tag: "AnalysisOutputError" });
});
