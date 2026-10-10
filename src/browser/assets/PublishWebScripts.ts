import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";

import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { DESTINATION_CASE_COLLISION_PREFIX } from "../../artifacts/ArtifactPaths.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import {
  webScriptExportManifestSchema,
  webScriptExportResultSchema,
  type ExportWebScriptsInput,
  type ExportedWebScript,
  type WebScriptExportResult,
} from "../../domain/webScriptExport.js";
import {
  planWebScriptExport,
  type PlannedWebScript,
} from "../../domain/webScriptExportPlan.js";
import { WebScriptExportError } from "../../domain/webScriptExportError.js";
import type { SelectedScriptCapture } from "./ScriptCaptureAdapters.js";

const LIMITATIONS = [
  "Only script bytes retained in this capture are exported. Sources are not refetched or executed, and a response or Debugger source does not prove execution.",
  "Ordinary unambiguous URL paths preserve relative module layouts by origin, including case-distinct spellings. Query variants, exact path collisions, file/directory prefixes, inline sources, and unrepresentable paths are isolated. A case-distinct pair is isolated only when the destination filesystem cannot store both spellings; the record names that pair. Browser module relationships of isolated paths remain unknown.",
  "Local JavaScript analysis does not implement browser import maps, root-relative URL resolution, remote URL loading, or browser runtime behavior. It may strip import queries and fragments; isolated variants are not canonical targets.",
  "Source-map declarations are retained as metadata. No source maps or missing dependencies are fetched or reconstructed.",
  "Captured response bytes are browser-decoded bytes; Debugger sources are the exposed text encoded as UTF-8. Redacted bytes are exported exactly as retained, and may no longer parse as JavaScript.",
];

/** Exclusively publish verified bytes and a manifest, rolling back partial work. */
export const publishWebScripts = async (
  input: ExportWebScriptsInput,
  capture: SelectedScriptCapture & { readonly sourceEvidenceId: string | null },
  captureSha256: string,
  signal?: AbortSignal,
): Promise<WebScriptExportResult> => {
  const planned = planWebScriptExport(capture.scripts);
  const tree = await SafeOutputTree.create(input.output_directory);
  try {
    signal?.throwIfAborted();
    const records: ExportedWebScript[] = [];
    for (const [index, item] of planned.entries()) {
      signal?.throwIfAborted();
      records.push(await publishPlannedScript(tree, item, index, signal));
    }
    const manifest = webScriptExportManifestSchema.parse({
      capture_path: input.capture_path,
      capture_sha256: captureSha256,
      capture_kind: capture.kind,
      source_evidence_id: capture.sourceEvidenceId,
      capture_completeness: capture.completeness,
      output_directory: tree.outputRoot,
      analysis_input: records.some(
        ({ content }) => content.state === "exported",
      )
        ? { input_path: join(tree.outputRoot, "files"), format: "directory" }
        : null,
      scripts: records,
      limitations: [
        ...capture.limitations,
        ...LIMITATIONS,
        ...(records.some(({ content }) => content.state === "exported")
          ? []
          : [
              "No script bytes were exportable. Include script sources in inspect_web_page or select response_body in capture_browser_scenario, then capture again.",
            ]),
      ],
    });
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const result = webScriptExportResultSchema.parse({
      ...manifest,
      manifest: {
        path: join(tree.outputRoot, "manifest.json"),
        sha256: digest,
        bytes: bytes.length,
      },
    });
    await tree.write("manifest.json", Readable.from([bytes]), digest, signal);
    signal?.throwIfAborted();
    await tree.commit();
    return result;
  } catch (cause: unknown) {
    try {
      await tree.rollback();
    } catch (cleanupCause: unknown) {
      throw new WebScriptExportError(
        "io",
        tree.outputRoot,
        `Publication failed (${message(cause)}); rollback failed (${message(cleanupCause)}). Remove the residual output directory before retrying.`,
        [tree.outputRoot],
      );
    }
    throw cause;
  }
};

const publishPlannedScript = async (
  tree: SafeOutputTree,
  item: PlannedWebScript,
  index: number,
  signal: AbortSignal | undefined,
): Promise<ExportedWebScript> => {
  const { script, record } = item;
  const content = script.content;
  if (content.state !== "captured" || record.content.state !== "exported")
    return record;
  const write = (relativePath: string): Promise<unknown> =>
    tree.write(
      `files/${relativePath}`,
      Readable.from([content.bytes]),
      content.sha256,
      signal,
    );
  try {
    await write(record.content.relative_path);
    return record;
  } catch (cause: unknown) {
    const collision = destinationCollisionReason(cause);
    if (collision === undefined || record.content.layout !== "url-path")
      throw cause;
    const relativePath = isolatedScriptPath(script, index);
    await write(relativePath);
    return {
      ...record,
      content: {
        ...record.content,
        relative_path: relativePath,
        layout: "isolated",
        layout_reason: collision,
      },
    };
  }
};

const isolatedScriptPath = (
  script: PlannedWebScript["script"],
  index: number,
): string =>
  `isolated/source-${index + 1}-${createHash("sha256").update(JSON.stringify(script.source)).digest("hex")}.js`;

const destinationCollisionReason = (cause: unknown): string | undefined =>
  cause instanceof ArtifactReaderFailure &&
  cause.reason === "path" &&
  cause.message.startsWith(DESTINATION_CASE_COLLISION_PREFIX)
    ? cause.message
    : undefined;

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Unknown publication failure";
