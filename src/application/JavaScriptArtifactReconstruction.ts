import { lstat, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { AsarArtifactReader } from "../artifacts/AsarArtifactReader.js";
import {
  ArtifactReaderFailure,
  type ArtifactReader,
} from "../artifacts/ArtifactReader.js";
import { DirectoryArtifactReader } from "../artifacts/DirectoryArtifactReader.js";
import type { JavaScriptApplicationGraph } from "../domain/javascriptApplicationGraph.js";
import { analyzeJavaScriptArtifactFiles } from "./JavaScriptArtifactAnalysis.js";
import { readJavaScriptArtifactFiles } from "./JavaScriptArtifactFiles.js";
import { buildJavaScriptArtifactGraph } from "./JavaScriptArtifactGraphBuilder.js";
import {
  artifactLimitsForReconstruction,
  javascriptArtifactReconstructionInputSchema,
  type JavaScriptArtifactReconstructionInput,
} from "./JavaScriptArtifactReconstructionInput.js";
import { scanCanonicalArtifactInventory } from "./ArtifactInventory.js";

/** Application-layer result retaining local diagnostics outside the canonical graph. */
export interface JavaScriptArtifactReconstructionResult {
  readonly input_path: string;
  readonly format: "asar" | "directory";
  readonly inventory_manifest_id: string;
  readonly inventory_graph_sha256: string;
  readonly graph: JavaScriptApplicationGraph;
  readonly statistics: {
    readonly relevant_files: number;
    readonly nested_asar_containers: number;
    readonly text_files_selected: number;
    readonly text_bytes_read: number;
    readonly omitted_text_files: number;
    readonly limit_omitted_text_files: number;
    readonly policy_filtered_text_files: number;
    readonly invalid_utf8_files: number;
    readonly parsed_javascript_files: number;
    readonly visited_ast_nodes: number;
    readonly findings: number;
    readonly modules: number;
    readonly parse_failures: number;
    readonly truncated_scopes: number;
  };
  readonly limitations: readonly string[];
}

/** Reconstruct one local ASAR or extracted directory without executing code. */
export const reconstructJavaScriptArtifact = async (
  rawInput: unknown,
  signal?: AbortSignal,
): Promise<JavaScriptArtifactReconstructionResult> => {
  const input = javascriptArtifactReconstructionInputSchema.parse(rawInput);
  abortIfNeeded(signal);
  const path = await realpath(input.input_path);
  const format = await resolveFormat(path, input);
  const snapshot = await scanCanonicalArtifactInventory(
    path,
    artifactLimitsForReconstruction(input),
    signal,
  );
  if (snapshot.manifest.root_format !== format)
    throw new ArtifactReaderFailure(
      "format",
      `Artifact inventory classified ${path} as ${snapshot.manifest.root_format}, not ${format}`,
    );
  const reader = createReader(path, format);
  try {
    const files = await readJavaScriptArtifactFiles(
      reader,
      snapshot,
      input,
      signal,
    );
    const analysis = analyzeJavaScriptArtifactFiles(files, input, () =>
      performance.now(),
    );
    abortIfNeeded(signal);
    const graph = buildJavaScriptArtifactGraph(
      snapshot,
      files,
      analysis,
      input,
    );
    return {
      input_path: path,
      format,
      inventory_manifest_id: snapshot.manifest.manifest_id,
      inventory_graph_sha256: snapshot.manifest.graph_sha256,
      graph,
      statistics: {
        relevant_files: files.files.length,
        nested_asar_containers: files.containers.length,
        text_files_selected: files.text_files_selected,
        text_bytes_read: files.text_bytes_read,
        omitted_text_files: files.omitted_text_files,
        limit_omitted_text_files: files.limit_omitted_text_files,
        policy_filtered_text_files: files.policy_filtered_text_files,
        invalid_utf8_files: files.invalid_utf8_files,
        parsed_javascript_files: analysis.files.filter(
          ({ javascript }) => javascript !== null,
        ).length,
        visited_ast_nodes: analysis.visited_ast_nodes,
        findings: analysis.findings,
        modules: analysis.modules,
        parse_failures: analysis.parse_failures,
        truncated_scopes: analysis.truncated_scopes,
      },
      limitations: analysis.limitations,
    };
  } finally {
    await reader.close();
  }
};

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
    throw new ArtifactReaderFailure(
      "format",
      `JavaScript artifact reconstruction accepts only a directory or .asar file: ${path}`,
    );
  if (input.format !== "auto" && input.format !== observed)
    throw new ArtifactReaderFailure(
      "format",
      `Requested ${input.format} input but observed ${observed}: ${path}`,
    );
  return observed;
};

const createReader = (
  path: string,
  format: "asar" | "directory",
): ArtifactReader =>
  format === "asar"
    ? new AsarArtifactReader(path)
    : new DirectoryArtifactReader(path);

const abortIfNeeded = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new ArtifactReaderFailure(
      "cancelled",
      "JavaScript artifact reconstruction cancelled",
    );
};
