import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";

import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import {
  webScriptExportManifestSchema,
  webScriptExportResultSchema,
  type ExportWebScriptsInput,
  type WebScriptExportResult,
} from "../../domain/webScriptExport.js";
import { planWebScriptExport } from "../../domain/webScriptExportPlan.js";
import { WebScriptExportError } from "../../domain/webScriptExportError.js";
import type { SelectedScriptCapture } from "./ScriptCaptureAdapters.js";

const LIMITATIONS = [
  "Only script bytes retained in this capture are exported. Sources are not refetched or executed, and a response or Debugger source does not prove execution.",
  "Ordinary unambiguous URL paths preserve relative module layouts by origin. Query variants, collisions, inline sources, and unrepresentable paths are isolated; their browser module relationships remain unknown.",
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
    const records = planned.map(({ record }) => record);
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
    for (const { script, record } of planned) {
      signal?.throwIfAborted();
      if (
        script.content.state === "captured" &&
        record.content.state === "exported"
      )
        await tree.write(
          `files/${record.content.relative_path}`,
          Readable.from([script.content.bytes]),
          script.content.sha256,
          signal,
        );
    }
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

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "Unknown publication failure";
