import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { createJavaScriptArtifactReader as createReader } from "../../artifacts/javascript/JavaScriptArtifactReader.js";
import type { JavaScriptApplicationGraph } from "../../domain/javascript/javascriptApplicationGraph.js";
import type { JavaScriptSemanticGraph } from "../../domain/javascript/javascriptSemanticGraph.js";
import type { ElectronBoundarySummary } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import type { ArtifactInventorySnapshot } from "../../domain/artifactInventorySnapshot.js";
import { analyzeAndProjectJavaScriptArtifactFiles } from "./JavaScriptArtifactAnalysis.js";
import { readJavaScriptArtifactFiles } from "../../artifacts/javascript/JavaScriptArtifactFiles.js";
import { buildImmutableJavaScriptArtifactGraphSteps } from "./JavaScriptArtifactGraphBuilder.js";
import {
  javascriptArtifactReconstructionInputSchema,
  type JavaScriptArtifactReconstructionInput,
} from "./JavaScriptArtifactReconstructionInput.js";
import { scanCanonicalArtifactInventory } from "../../artifacts/inventory/scanCanonical.js";
import { summarizeElectronBoundaries } from "./ElectronBoundaryAnalysis.js";
import { createJavaScriptSemanticGraphProjection } from "./JavaScriptSemanticGraphBuilder.js";
import type { ProgressReporter } from "../ProgressReporter.js";
import {
  checkpointJavaScriptAnalysis,
  completeJavaScriptAnalysisSteps,
} from "./JavaScriptAnalysisControl.js";

/** Application-layer result retaining local diagnostics outside the canonical graph. */
export interface JavaScriptArtifactReconstructionResult {
  readonly input_path: string;
  readonly format: "asar" | "directory";
  readonly root_artifact_sha256: string;
  readonly inventory_manifest_id: string;
  readonly inventory_graph_sha256: string;
  readonly integrity_contradictions: ArtifactInventorySnapshot["integrity_contradictions"];
  readonly graph: JavaScriptApplicationGraph;
  readonly semantic_graph: JavaScriptSemanticGraph;
  readonly electron_summary: ElectronBoundarySummary;
  readonly statistics: {
    readonly relevant_files: number;
    readonly nested_asar_containers: number;
    readonly text_bytes_read: number;
    readonly invalid_utf8_files: number;
    readonly parsed_javascript_files: number;
    readonly visited_ast_nodes: number;
    readonly findings: number;
    readonly modules: number;
    readonly parse_failures: number;
  };
  readonly limitations: readonly string[];
}

/** Reconstruct one local ASAR or extracted directory without executing code. */
export const reconstructJavaScriptArtifact = async (
  rawInput: unknown,
  signal?: AbortSignal,
  progress?: ProgressReporter,
): Promise<JavaScriptArtifactReconstructionResult> => {
  const reportPhase = async (phase: string, message: string): Promise<void> => {
    await progress?.report({ phase, completed: 0, total: 1, message });
    await checkpointJavaScriptAnalysis(signal);
  };
  const input = javascriptArtifactReconstructionInputSchema.parse(rawInput);
  abortIfNeeded(signal);
  const path = await resolveSelectedInput(input.input_path);
  const format = await resolveFormat(path, input);
  const snapshot = await scanCanonicalArtifactInventory(path, {
    signal,
    integrity: { mode: input.integrity_policy },
  });
  if (snapshot.manifest.root_format !== format)
    throw new ArtifactReaderFailure(
      "format",
      `Artifact inventory classified ${path} as ${snapshot.manifest.root_format}, not ${format}`,
    );
  const reader = createReader(path, format);
  try {
    await reportPhase(
      "read_javascript_artifacts",
      "Reading inventoried JavaScript application sources",
    );
    const files = await readJavaScriptArtifactFiles(reader, snapshot, signal);
    await reportPhase(
      "parse_javascript_sources",
      `Parsing and projecting ${String(files.files.length)} application source files`,
    );
    const semanticProjection = createJavaScriptSemanticGraphProjection();
    const analysis = await analyzeAndProjectJavaScriptArtifactFiles(
      files,
      semanticProjection.projectFile,
      async (file, completed, total) => {
        abortIfNeeded(signal);
        await progress?.report({
          phase: "parse_javascript_source",
          completed: 0,
          total: 1,
          message: `Parsing and projecting ${file.path} (${String(completed + 1)}/${String(total)})`,
        });
        abortIfNeeded(signal);
      },
    );
    await checkpointJavaScriptAnalysis(signal);
    abortIfNeeded(signal);
    await reportPhase(
      "build_javascript_application_graph",
      "Constructing application and Electron boundary relationships",
    );
    const applicationGraphSteps = buildImmutableJavaScriptArtifactGraphSteps(
      snapshot,
      files,
      analysis,
    );
    await reportPhase(
      "seal_javascript_application_graph",
      "Sealing the validated application graph",
    );
    const graph = await completeJavaScriptAnalysisSteps(
      applicationGraphSteps,
      signal,
    );
    await reportPhase(
      "build_javascript_semantic_graph",
      "Binding and validating static semantic relationships",
    );
    const semanticGraphSteps = semanticProjection.finishImmutableSteps(
      snapshot.manifest.root_sha256,
      graph,
    );
    await reportPhase(
      "seal_javascript_semantic_graph",
      "Validating and sealing the semantic graph",
    );
    const semanticGraph = await completeJavaScriptAnalysisSteps(
      semanticGraphSteps,
      signal,
    );
    await checkpointJavaScriptAnalysis(signal);
    return {
      input_path: path,
      format,
      root_artifact_sha256: snapshot.manifest.root_sha256,
      inventory_manifest_id: snapshot.manifest.manifest_id,
      inventory_graph_sha256: snapshot.manifest.graph_sha256,
      integrity_contradictions: snapshot.integrity_contradictions,
      graph,
      semantic_graph: semanticGraph,
      electron_summary: summarizeElectronBoundaries(analysis),
      statistics: {
        relevant_files: files.files.length,
        nested_asar_containers: files.containers.length,
        text_bytes_read: files.text_bytes_read,
        invalid_utf8_files: files.invalid_utf8_files,
        parsed_javascript_files: analysis.files.filter(
          ({ javascript }) => javascript !== null,
        ).length,
        visited_ast_nodes: analysis.visited_ast_nodes,
        findings: analysis.findings,
        modules: analysis.modules,
        parse_failures: analysis.parse_failures,
      },
      limitations: analysis.limitations,
    };
  } finally {
    await reader.close();
  }
};

const OPERATION = "analyze_javascript_application";

/**
 * Resolve the caller-selected input. A missing or unreadable selection is a
 * caller or host-permission failure, not a damaged artifact.
 */
const resolveSelectedInput = async (inputPath: string): Promise<string> => {
  try {
    const path = await realpath(inputPath);
    await access(path, constants.R_OK);
    return path;
  } catch (cause: unknown) {
    const code =
      cause instanceof Error && "code" in cause ? String(cause.code) : "";
    if (code === "EACCES" || code === "EPERM")
      throw new AnalysisAccessDeniedError(OPERATION, inputPath, code, {
        cause,
      });
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["input_path"],
          reason: "invalid_value",
          message: `No file or directory exists at the selected input path (${code}): ${inputPath}`,
        },
      ]);
    throw cause;
  }
};

/** The selected input's kind, checked against the caller's requested format. */
const resolveFormat = async (
  path: string,
  input: JavaScriptArtifactReconstructionInput,
): Promise<"asar" | "directory"> => {
  const metadata = await lstat(path);
  const observed = metadata.isDirectory()
    ? "directory"
    : metadata.isFile() && path.toLowerCase().endsWith(".asar")
      ? "asar"
      : undefined;
  if (observed === undefined)
    throw new AnalysisUnsupportedTargetError(
      OPERATION,
      input.input_path,
      "JavaScript application analysis accepts only a directory or an .asar file",
      {
        remediationAction:
          "Select an extracted application directory, an app bundle, or an .asar file such as Contents/Resources/app.asar.",
      },
    );
  if (input.format !== "auto" && input.format !== observed)
    throw new AnalysisInputError(OPERATION, undefined, [
      {
        path: ["format"],
        reason: "invalid_value",
        message: `Requested ${input.format} input, but the selected input is ${observed === "asar" ? "an .asar file" : "a directory"}: ${input.input_path}`,
        expected: ["auto", observed],
      },
    ]);
  return observed;
};

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "JavaScript artifact reconstruction cancelled",
    );
};
