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

const fileFor = (source: string): JavaScriptArtifactFile => ({
  path: PATH,
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
): Promise<AnalyzedJavaScriptArtifactFile> => {
  const file = fileFor(source);
  const parsed = parseJavaScriptSource(source, PATH);
  if (parsed === null) throw new Error("expected a parsed source");
  const facts = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptStaticSourceSteps(source, parsed),
  );
  const ir = await completeJavaScriptAnalysisSteps(
    analyzeParsedJavaScriptSemanticsSteps(
      parsed,
      moduleResolutionModeForJavaScriptReference(PATH, "static-import"),
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
): Promise<{
  limitations: readonly string[];
  electronSemantics: string | undefined;
}> => {
  const entry = await analyzedEntry(source);
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
});
