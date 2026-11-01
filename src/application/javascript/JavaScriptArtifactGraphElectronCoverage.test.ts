import { describe, expect, it } from "vitest";

import type { ArtifactInventorySnapshot } from "../../domain/artifactInventorySnapshot.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { projectJavaScriptModuleSemantics } from "../../domain/javascript/javascriptModuleSemanticIr.js";
import { moduleResolutionModeForJavaScriptReference } from "../../domain/javascript/javascriptModuleResolutionMode.js";
import { analyzeParsedJavaScriptSemanticsSteps } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import { parseJavaScriptSource } from "../../domain/javascript/javascriptSourceParser.js";
import { analyzeParsedJavaScriptStaticSourceSteps } from "../../domain/javascript/javascriptStaticAnalysis.js";
import type {
  AnalyzedJavaScriptArtifactFile,
  JavaScriptArtifactAnalysis,
} from "./JavaScriptArtifactAnalysisTypes.js";
import { completeJavaScriptAnalysisSteps } from "./JavaScriptAnalysisControl.js";
import { buildImmutableJavaScriptArtifactGraphSteps as buildGraph } from "./JavaScriptArtifactGraphBuilder.js";
import { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";
import { electronModuleReferenced } from "./ElectronBoundaryAnalysis.js";

const SHA256 = "a".repeat(64);
const PATH = "main.js";

const EMPTY_COVERAGE =
  "Electron modules are referenced but no Electron boundary fact was recovered from inert syntax. Zero IPC operations and zero BrowserWindows here mean empty coverage, not evidence that the application has none.";

const fileFor = (
  source: string,
  path: string = PATH,
): JavaScriptArtifactFile => ({
  path,
  container_sha256: SHA256,
  sha256: SHA256,
  bytes: source.length,
  inventory_artifact_id: `art_${SHA256}`,
  kind: "javascript",
  unpacked: false,
  text: { included: true, value: source },
});

const analyzedEntry = async (
  source: string,
  path: string = PATH,
): Promise<AnalyzedJavaScriptArtifactFile> => {
  const file = fileFor(source, path);
  const parsed = parseJavaScriptSource(source, path);
  if (parsed === null) throw new Error("expected a parsed source");
  const facts = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptStaticSourceSteps(source, parsed),
  );
  const ir = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptSemanticsSteps(
      parsed,
      moduleResolutionModeForJavaScriptReference(path, "static-import"),
      100_000,
    ),
  );
  return {
    file,
    javascript: facts,
    semantic: { ir: projectJavaScriptModuleSemantics(ir) },
  };
};

const snapshot = {
  manifest: {
    root_artifact_id: `art_${SHA256}`,
    root_sha256: SHA256,
    root_format: "directory",
    manifest_id: `agm_${SHA256}`,
    graph_sha256: SHA256,
  },
  nodes: [{ artifact_id: `art_${SHA256}`, sha256: SHA256, size: 1 }],
  occurrences: [],
  limitations: [],
  integrity_contradictions: [],
  coverage: { scope: "root", status: "complete" },
} as unknown as ArtifactInventorySnapshot;

const graphFor = async (
  source: string,
  mutate?: (
    entry: AnalyzedJavaScriptArtifactFile,
  ) => AnalyzedJavaScriptArtifactFile,
  path: string = PATH,
): Promise<{
  limitations: readonly string[];
  electronSemantics: string | undefined;
}> => {
  const base = await analyzedEntry(source, path);
  const entry = mutate === undefined ? base : mutate(base);
  const analysis: JavaScriptArtifactAnalysis = {
    jsonDocuments: new JavaScriptJsonDocuments(),
    files: [entry],
    packages: [],
    json_modules: [],
    html_scripts: [],
    html_inline_scripts: [],
    source_maps: [],
    visited_ast_nodes: 0,
    findings: 0,
    modules: 0,
    parse_failures: 0,
    limitations: [],
  };
  const fileSet = {
    files: [entry.file],
    unavailable_relevant_files: [],
    containers: [],
    text_bytes_read: entry.file.bytes,
    invalid_utf8_files: 0,
  };
  const steps = buildGraph(snapshot, fileSet, analysis);
  let next = steps.next();
  while (next.done !== true) next = steps.next();
  return {
    limitations: next.value.graph.limitations,
    electronSemantics: next.value.electronSummary.electron_semantics,
  };
};

describe("Electron semantic coverage", () => {
  it("reports empty Electron coverage when the module is referenced but nothing is recovered", async () => {
    const { limitations, electronSemantics } = await graphFor(
      `const { app } = require("electron");\napp.whenReady();\n`,
    );
    expect(limitations).toContain(EMPTY_COVERAGE);
    expect(electronSemantics).toBe("empty");
  });

  it("reports idle-coverage limits, not empty coverage, once a boundary fact is recovered", async () => {
    const { limitations, electronSemantics } = await graphFor(
      `const { ipcMain } = require("electron");\nipcMain.handle("ping", () => 1);\n`,
    );
    expect(limitations).not.toContain(EMPTY_COVERAGE);
    expect(limitations).toContain(
      "Electron relationships are derived from inert syntax; runtime registration, reachability, defaults, and enforcement remain unproven.",
    );
    expect(electronSemantics).toBe("recovered");
  });

  it("omits the coverage field when the source never references Electron", async () => {
    const { limitations, electronSemantics } = await graphFor(
      `export const value = 1;\n`,
    );
    expect(limitations).not.toContain(EMPTY_COVERAGE);
    expect(electronSemantics).toBeUndefined();
  });

  it("does not count a type-only Electron import as boundary coverage", () => {
    // A `.js` fixture cannot carry `import type`, so the module predicate is
    // exercised directly here.
    const analysisWith = (
      kind: "require" | "type-import",
    ): JavaScriptArtifactAnalysis =>
      ({
        files: [
          {
            file: fileFor(""),
            javascript: null,
            semantic: {
              ir: { moduleLinks: [{ kind, specifier: "electron" }] },
            },
          },
        ],
      }) as unknown as JavaScriptArtifactAnalysis;
    expect(electronModuleReferenced(analysisWith("require"))).toBe(true);
    expect(electronModuleReferenced(analysisWith("type-import"))).toBe(false);
  });

  it("matches a supported Electron subpath and ignores an unrelated package", async () => {
    const subpath = await graphFor(
      `const { app } = require("electron/main");\napp.whenReady();\n`,
    );
    expect(subpath.electronSemantics).toBe("empty");
    const unrelated = await graphFor(
      `const helper = require("electron-helper");\nhelper.run();\n`,
    );
    expect(unrelated.electronSemantics).toBeUndefined();
  });

  it("keeps the coverage state when a rejected projection drops the file", async () => {
    // A file whose expanded relationships exceed the result budget is replaced
    // by a placeholder before the Electron summary runs, so the coverage state
    // must come from the retained analysis rather than the projected view.
    const { limitations, electronSemantics } = await graphFor(
      `const { app } = require("electron");\napp.whenReady();\n`,
      (entry) => ({
        ...entry,
        application_projection_failure: {
          reason: "result budget exhausted",
          error: { code: "result_budget_exhausted" },
          limits: null,
        },
      }),
    );
    expect(electronSemantics).toBe("empty");
    expect(limitations).toContain(EMPTY_COVERAGE);
  });

  it("counts a retained static reference when semantic analysis was skipped", async () => {
    // Semantic analysis can be skipped for a budget, which leaves the module
    // links absent while the static reference is still retained.
    const { electronSemantics } = await graphFor(
      `const { app } = require("electron");\napp.whenReady();\n`,
      (entry) => ({
        ...entry,
        semantic: null,
      }),
    );
    expect(electronSemantics).toBe("empty");
  });
});

it("counts a dynamic Electron import that module links do not retain", async () => {
  // The semantic collector keeps no module link for `import("electron")`, so
  // only the retained static reference names Electron here.
  const { limitations, electronSemantics } = await graphFor(
    `const electron = import("electron");\nelectron.then(() => {});\n`,
  );
  expect(electronSemantics).toBe("empty");
  expect(limitations).toContain(EMPTY_COVERAGE);
});

it("counts a retained runtime static import when semantics are skipped", async () => {
  // The static analyzer records a whole `import type` declaration as no
  // reference, so a retained `static-import` is a runtime load.
  const { electronSemantics } = await graphFor(
    `import { app } from "electron";\napp.whenReady();\n`,
    (entry) => ({ ...entry, semantic: null }),
  );
  expect(electronSemantics).toBe("empty");
});

it("does not count a whole type-only import when semantics are skipped", async () => {
  // `import type` needs a TypeScript source, and the static analyzer records no
  // reference for a whole type-only declaration.
  const { electronSemantics } = await graphFor(
    `import type { IpcMain } from "electron";\nexport const value = 1;\n`,
    (entry) => ({ ...entry, semantic: null }),
    "main.mts",
  );
  expect(electronSemantics).toBeUndefined();
});

it("does not treat a worker URL path as an Electron module", async () => {
  // `new Worker(new URL("electron", import.meta.url))` records a `worker`
  // reference whose specifier is a path relative to the importing source.
  const { electronSemantics } = await graphFor(
    `const worker = new Worker(new URL("electron", import.meta.url));\n`,
    (entry) => ({ ...entry, semantic: null }),
  );
  expect(electronSemantics).toBeUndefined();
});

it("reports the same Electron applicability as the retained static fact", async () => {
  // `analysis_coverage.applicability.electron` is the domain owner of the same
  // question, so a worker URL path must be unknown for both outputs.

  const entry = await analyzedEntry(
    `const worker = new Worker(new URL("electron", import.meta.url));\n`,
  );
  expect(entry.javascript?.analysis_coverage?.applicability.electron).toBe(
    "unknown",
  );
  const graph = await graphFor(
    `const worker = new Worker(new URL("electron", import.meta.url));\n`,
  );
  expect(graph.electronSemantics).toBeUndefined();
});

it("does not count a resolve-only Electron reference as coverage", async () => {
  // `require.resolve("electron")` locates the module without loading it, so no
  // boundary fact is expected and neither output may claim empty coverage.
  const { limitations, electronSemantics } = await graphFor(
    `const entry = require.resolve("electron");\n`,
  );
  expect(electronSemantics).toBeUndefined();
  expect(limitations).not.toContain(EMPTY_COVERAGE);
});
