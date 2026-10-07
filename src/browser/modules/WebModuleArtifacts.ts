import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { normalizeArtifactPath } from "../../artifacts/ArtifactPaths.js";
import type {
  WebModuleArtifactPort,
  WebModuleArtifacts,
} from "../../application/WebModulePorts.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import { safeParseJson } from "../../domain/safeJson.js";
import { err, ok } from "../../domain/result.js";
import type { WebModuleTraceInput } from "../../domain/webModuleTrace.js";
import { webScriptExportManifestSchema } from "../../domain/webScriptExport.js";

/** Load verified exported source bytes relative to the current manifest location. */
export class LocalWebModuleArtifacts implements WebModuleArtifactPort {
  /** Verify exactly the selected manifest, source and optional local map. */
  async load(input: WebModuleTraceInput, options?: ExecutionOptions) {
    let field: readonly (string | number)[] = ["manifest_path"];
    let targetPath = input.manifest_path;
    try {
      const manifestBytes = await readStableArtifact(
        input.manifest_path,
        32 * 1024 * 1024,
        options?.signal,
      );
      const manifest = webScriptExportManifestSchema.parse(
        parseJson(manifestBytes.bytes),
      );
      field = ["script_index"];
      const selected = manifest.scripts[input.script_index];
      if (selected === undefined)
        throw new ModuleArtifactFormatFailure(
          `No script at index ${String(input.script_index)}; manifest contains ${String(manifest.scripts.length)} scripts.`,
        );
      if (selected.content.state !== "exported")
        return err(
          new AnalysisCapabilityUnavailableError(
            "web-module-artifacts",
            "trace_web_module_imports",
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
      const source = decode(sourceBytes.bytes);
      let importMap: WebModuleArtifacts["importMap"] = null;
      if (input.import_map !== undefined) {
        field = ["import_map", "path"];
        targetPath = input.import_map.path;
        const bytes = await readStableArtifact(
          input.import_map.path,
          4 * 1024 * 1024,
          options?.signal,
        );
        importMap = {
          file: {
            path: input.import_map.path,
            sha256: bytes.sha256,
            bytes: bytes.bytes.length,
          },
          baseUrl: input.import_map.base_url,
          value: jsonObjectSchema.parse(parseJson(bytes.bytes)),
        };
      }
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
        importMap,
      });
    } catch (cause: unknown) {
      if (options?.signal?.aborted === true)
        return err(new AnalysisCancelledError("trace_web_module_imports"));
      if (cause instanceof ArtifactReaderFailure)
        return err(
          new ArtifactOperationError(
            "trace_web_module_imports",
            cause.reason,
            cause.details,
            cause.message,
          ),
        );
      if (
        cause instanceof Error &&
        "code" in cause &&
        typeof cause.code === "string" &&
        "syscall" in cause &&
        typeof cause.syscall === "string"
      )
        return err(
          new ArtifactOperationError(
            "trace_web_module_imports",
            "io",
            undefined,
            `${field.join(".")}: ${cause.code}: ${cause.message}`,
          ),
        );
      if (
        cause instanceof ModuleArtifactFormatFailure ||
        cause instanceof z.ZodError
      )
        return err(
          new AnalysisInputError("trace_web_module_imports", { cause }, [
            {
              path: field,
              reason: "invalid_format",
              message: `${targetPath}: ${cause.message}`,
            },
          ]),
        );
      return err(
        new ProviderAdapterError(
          "web-module-artifacts",
          "trace_web_module_imports",
          {
            cause,
            diagnostics: {
              target_path: targetPath,
              field: field.join("."),
              error_message:
                cause instanceof Error ? cause.message : String(cause),
            },
          },
        ),
      );
    }
  }
}

class ModuleArtifactFormatFailure extends Error {}

const decode = (bytes: Buffer): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause: unknown) {
    throw new ModuleArtifactFormatFailure(
      "Selected artifact is not valid UTF-8.",
      { cause },
    );
  }
};
const parseJson = (bytes: Buffer): unknown => {
  const parsed = safeParseJson(decode(bytes));
  if (!parsed.ok) throw new ModuleArtifactFormatFailure(parsed.error);
  return parsed.value;
};
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
