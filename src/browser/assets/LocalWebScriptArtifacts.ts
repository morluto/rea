import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { normalizeArtifactPath } from "../../artifacts/ArtifactPaths.js";
import type { WebScriptArtifactPort } from "../../application/WebScriptArtifactPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { err, ok } from "../../domain/result.js";
import type { SelectedWebScriptInput } from "../../domain/webScriptArtifacts.js";
import { webScriptExportManifestSchema } from "../../domain/webScriptExport.js";
import {
  decodeWebArtifact,
  readWebArtifactJson,
  webArtifactReadError,
  WebArtifactFormatFailure,
  type WebArtifactReadContext,
} from "./WebArtifactReads.js";

/** Read one digest-verified captured source under the manifest's current location. */
export class LocalWebScriptArtifacts implements WebScriptArtifactPort {
  constructor(readonly operation: WebArtifactReadContext["operation"]) {}

  /** Read the selected source; relocated exports retain their reported original root. */
  async load(input: SelectedWebScriptInput, options?: ExecutionOptions) {
    let field: readonly (string | number)[] = ["manifest_path"];
    let targetPath = input.manifest_path;
    try {
      const manifestBytes = await readWebArtifactJson(
        input.manifest_path,
        32 * 1024 * 1024,
        options?.signal,
      );
      const manifest = webScriptExportManifestSchema.parse(manifestBytes.value);
      field = ["script_index"];
      const selected = manifest.scripts[input.script_index];
      if (selected === undefined)
        throw new WebArtifactFormatFailure(
          `No script at index ${String(input.script_index)}; manifest contains ${String(manifest.scripts.length)} scripts.`,
        );
      if (selected.content.state !== "exported")
        return err(
          new AnalysisCapabilityUnavailableError(
            "web-module-artifacts",
            this.operation,
            "selected_source_unavailable",
            {
              userMessage: `Selected script ${String(input.script_index)} has unavailable source bytes (${selected.content.reason}): ${selected.content.message} Capture source bytes before tracing this script.`,
            },
          ),
        );
      const portable = normalizeArtifactPath(selected.content.relative_path);
      if (portable !== selected.content.relative_path)
        throw new ArtifactReaderFailure(
          "path",
          `Selected source path changes during normalization: ${selected.content.relative_path}`,
        );
      const root = dirname(input.manifest_path);
      const sourcePath = join(root, "files", portable);
      targetPath = sourcePath;
      await assertContained(root, sourcePath);
      const sourceBytes = await readStableArtifact(
        sourcePath,
        16 * 1024 * 1024,
        options?.signal,
      );
      await assertContained(root, sourcePath);
      if (
        sourceBytes.sha256 !== selected.content.sha256 ||
        sourceBytes.bytes.length !== selected.content.bytes
      )
        throw new ArtifactReaderFailure(
          "integrity",
          `Selected source identity mismatch: ${sourcePath}; expected sha256=${selected.content.sha256}, bytes=${String(selected.content.bytes)}; observed sha256=${sourceBytes.sha256}, bytes=${String(sourceBytes.bytes.length)}.`,
          undefined,
          {
            logicalPath: selected.content.relative_path,
            declaredSha256: selected.content.sha256,
            calculatedSha256: sourceBytes.sha256,
            unpacked: false,
          },
        );
      const source = decodeWebArtifact(sourceBytes.bytes);
      return ok({
        manifest,
        manifestFile: {
          path: input.manifest_path,
          sha256: manifestBytes.sha256,
          bytes: manifestBytes.bytes.length,
        },
        sourceFile: {
          path: sourcePath,
          sha256: sourceBytes.sha256,
          bytes: sourceBytes.bytes.length,
        },
        source,
      });
    } catch (cause: unknown) {
      return err(
        webArtifactReadError(
          cause,
          { operation: this.operation, field, targetPath },
          options?.signal,
        ),
      );
    }
  }
}

const assertContained = async (root: string, path: string): Promise<void> => {
  const canonicalRoot = await realpath(root);
  const canonicalFile = await realpath(path);
  const fromRoot = relative(canonicalRoot, canonicalFile);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw new ArtifactReaderFailure(
      "path",
      `Selected source escapes its manifest directory: ${path}`,
    );
  let directory = dirname(path);
  while (directory !== root) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ArtifactReaderFailure(
        "path",
        `Selected source directory is a symlink or not a directory: ${directory}`,
      );
    const parent = dirname(directory);
    if (parent === directory)
      throw new ArtifactReaderFailure(
        "path",
        "Selected source has no containing manifest directory.",
      );
    directory = parent;
  }
};
