import { expect, it } from "vitest";

import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import { createEvidence } from "../../../src/domain/evidence.js";

const unknown =
  "Selected library coverage is incomplete; additional static candidates may exist. Matched means observed candidate presence, not complete uniqueness.";

/**
 * A report with `count` native declarations and `libraries` libraries. With
 * `shared`, one static registration candidate names every declaration and
 * every binding matches it, as same-signature natives do.
 */
const report = (count: number, libraries: number, shared = false) => {
  const declarations = Array.from({ length: count }, (_, index) => ({
    declaration_id: `jni_method_${String(index).padStart(64, "0")}`,
    source_index: index,
    class_name: `org.example.media.NativeBridge${String(index)}`,
    method_name: `nativeOperation${String(index)}`,
    descriptor: "(Lorg/example/media/interfaces/IMediaPlayer;JZ)V",
    dex_entry: "classes.dex",
    dex_entry_index: 1,
    class_index: index,
    method_index: index,
  }));
  return androidResultSchemas.inspect_android_jni_bindings.parse({
    engine: {
      name: "fixture",
      version: "1",
      artifact_sha256: "b".repeat(64),
      source_revision: null,
      worker_count: 1,
      heap_limit_mib: null,
    },
    apk: { path: "/artifacts/app.apk", sha256: "a".repeat(64) },
    selection: {},
    native_inventory: {
      scope: "apk-root-dex-declarations",
      coverage: {
        status: "complete",
        dex_entries: 1,
        examined_dex_entries: 1,
        examined_classes: count,
        examined_methods: count,
      },
      unknowns: [],
    },
    library_inventory: {
      status: "complete",
      examined_entries: libraries,
      selected_libraries: libraries,
      unknowns: [],
    },
    declarations,
    selected_declaration_ids: declarations.map((row) => row.declaration_id),
    libraries: Array.from({ length: libraries }, (_, index) => ({
      library_id: `jni_library_${String(index).padStart(64, "0")}`,
      source_index: index,
      source_key: `zip-entry:${String(index)}`,
      path: `lib/arm64-v8a/libmodule${String(index)}.so`,
      source_path: `lib/arm64-v8a/libmodule${String(index)}.so`,
      abi: "arm64-v8a",
      sha256: "c".repeat(64),
      size: 4096,
      declared_size: 4096,
      compressed_size: 2048,
      abi_compatibility: "unknown",
      byte_order: null,
      architecture: null,
      bits: null,
      jni_on_load: null,
      coverage: null,
      export_count: 0,
      table_count: 0,
      table_entry_count: 0,
      unknowns: [
        "Runtime-built tables and obfuscated strings are not recovered; no loading, registration or invocation is established",
      ],
      failure: { kind: "unsupported", message: "Not an ELF shared object." },
    })),
    candidates: shared
      ? [
          {
            candidate_id: `jni_candidate_${"e".repeat(64)}`,
            library_id: `jni_library_${String(0).padStart(64, "0")}`,
            basis: "static-registration-table",
            name: "nativeOperation",
            descriptor: "(Lorg/example/media/interfaces/IMediaPlayer;JZ)V",
            address: "0x13a80",
            file_offset: 80512,
            declaration_ids: declarations.map((row) => row.declaration_id),
            class_attribution: "ambiguous-native-pair",
            export_source_index: null,
            table: null,
          },
        ]
      : [],
    bindings: declarations.map((row) => ({
      declaration_id: row.declaration_id,
      abi: "arm64-v8a",
      status: shared ? "ambiguous" : "unknown",
      coverage: "partial",
      candidate_ids: shared ? [`jni_candidate_${"e".repeat(64)}`] : [],
      unknowns: [unknown],
    })),
    unknowns: [],
  });
};

it("previews a large JNI report within the default agent result budget", async () => {
  const parent = createEvidence(
    { path: "/artifacts/app.apk", sha256: "a".repeat(64), format: "apk" },
    { id: "jadx", name: "JADX", version: "0.8.0" },
    {
      operation: "inspect_android_jni_bindings",
      parameters: { path: "/artifacts/app.apk" },
      result: report(600, 40),
    },
  );
  const viewed = await inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: { kind: "summary" },
  });
  if (!viewed.ok) throw viewed.error;
  expect(JSON.stringify(viewed.value).length).toBeLessThan(32 * 1024);
  expect(viewed.value.normalized_result).toMatchObject({
    coverage: { total: 600, next_offset: 16 },
    summary: {
      counts: { declarations: 600, bindings: 600, libraries: 40, unknown: 600 },
      library_coverage: { total: 40, exhausted: false },
      declaration_coverage: { examined: 16, total: 600, next_offset: 16 },
    },
  });
  const summary = (
    viewed.value.normalized_result as unknown as {
      readonly summary: Record<string, readonly unknown[]>;
    }
  ).summary;
  expect(summary.bindings).toHaveLength(16);
  // Libraries fit their byte allowance before the 16-row cap.
  const libraries = (
    viewed.value.normalized_result as unknown as {
      readonly summary: {
        readonly library_coverage: { readonly examined: number };
      };
    }
  ).summary.library_coverage.examined;
  expect(libraries).toBeGreaterThan(0);
  expect(libraries).toBeLessThanOrEqual(16);
  expect(summary.libraries).toHaveLength(libraries);
  expect(summary.declarations).toHaveLength(16);
});

it("previews no binding whose shared candidate would carry every declaration", async () => {
  const parent = createEvidence(
    { path: "/artifacts/app.apk", sha256: "a".repeat(64), format: "apk" },
    { id: "jadx", name: "JADX", version: "0.8.0" },
    {
      operation: "inspect_android_jni_bindings",
      parameters: { path: "/artifacts/app.apk" },
      result: report(600, 1, true),
    },
  );
  const viewed = await inspectAnalysisView({
    source: { kind: "inline", evidence: parent },
    view: { kind: "summary" },
  });
  if (!viewed.ok) throw viewed.error;
  // The first binding's closure alone exceeds the relation allowance; the
  // counts still describe all 600 and pages read them.
  expect(JSON.stringify(viewed.value).length).toBeLessThan(32 * 1024);
  expect(viewed.value.normalized_result).toMatchObject({
    coverage: { examined: 0, total: 600, next_offset: 0 },
    summary: {
      counts: { bindings: 600, candidates: 1, ambiguous: 600 },
      bindings: [],
      candidates: [],
    },
  });
});
