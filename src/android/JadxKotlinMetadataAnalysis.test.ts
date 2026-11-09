import { expect, it } from "vitest";
import { analyzeJadxRequest, type JadxToolPort } from "./JadxAnalysis.js";
import { androidRequestSchema } from "../domain/android/androidAnalysis.js";
import type { AndroidKotlinMetadataFacts } from "../domain/android/androidKotlinMetadata.js";

const engine = {
  name: "jadx-headless-mcp",
  version: "0.7.1",
  artifact_sha256: "a".repeat(64),
  source_revision: null,
  worker_count: 1,
  heap_limit_mib: 8192,
} as const;
const noDecompiler: JadxToolPort = {
  json: async () => {
    throw new Error("Kotlin metadata must not call the decompiler");
  },
  text: async () => {
    throw new Error("Kotlin metadata must not request source");
  },
  listClasses: async () => {
    throw new Error("Kotlin metadata must not page display classes");
  },
};
const facts: AndroidKotlinMetadataFacts = {
  scope: "apk-root-dex-kotlin-metadata",
  coverage: {
    status: "complete",
    dex_entries: 1,
    examined_dex_entries: 1,
    examined_classes: 10,
    classes_with_metadata: 0,
    undecodable_classes: 0,
  },
  versions: [],
  kinds: [],
  matching_classes: 0,
  classes: [],
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
  unknowns: [],
};
const request = (input: Record<string, unknown>) =>
  androidRequestSchema.parse({
    operation: "inspect_android_kotlin_metadata",
    input: { path: "/tmp/Example.apk", ...input },
  });

it("answers from the raw reader without loading the decompiler", async () => {
  const selections: unknown[] = [];
  const result = await analyzeJadxRequest(
    noDecompiler,
    request({ package_prefix: "com.example", limit: 5 }),
    {
      loaded: undefined,
      engine,
      kotlinMetadata: async (selection) => {
        selections.push(selection);
        return facts;
      },
    },
  );
  expect(result).toEqual({ ...facts, engine });
  expect(selections).toHaveLength(1);
  expect(selections[0]).toMatchObject({
    package_prefix: "com.example",
    limit: 5,
  });
});

it("refuses an exact class combined with a package prefix before reading", async () => {
  await expect(
    analyzeJadxRequest(
      noDecompiler,
      request({ class_name: "com.example.Api", package_prefix: "com" }),
      {
        loaded: undefined,
        engine,
        kotlinMetadata: async () => {
          throw new Error("must not read");
        },
      },
    ),
  ).rejects.toMatchObject({ _tag: "AnalysisInputError" });
});

it("fails closed when the raw reader is not provided", async () => {
  await expect(
    analyzeJadxRequest(noDecompiler, request({}), {
      loaded: undefined,
      engine,
    }),
  ).rejects.toMatchObject({ _tag: "AnalysisOutputError" });
});

it("rejects unreviewed input fields and an out-of-range limit", () => {
  expect(() => request({ extra: true })).toThrow();
  expect(() => request({ limit: 0 })).toThrow();
  // Analysis may retain more than the inline limit; delivery enforces 500 for complete detail.
  expect(() => request({ limit: 100_000 })).not.toThrow();
  expect(() => request({ limit: 100_001 })).toThrow();
  expect(() => request({ class_name: "" })).toThrow();
});
