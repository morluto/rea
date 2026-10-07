import { isAbsolute } from "node:path";
import { z } from "zod";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  collectWebModuleImports,
  matchCapturedModules,
} from "../domain/webModuleImports.js";
import {
  webModuleTraceInputSchema,
  webModuleFileSchema,
  webModuleResolutionSchema,
  webModuleTraceResultSchema,
  type WebModuleResolution,
  type WebModuleTraceResult,
} from "../domain/webModuleTrace.js";
import { selectedWebScriptArtifactsSchema } from "../domain/webScriptArtifacts.js";
import { capturedWebManifestIdentity, validateSelectedWebScript } from "./ValidateSelectedWebScript.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type {
  WebModuleArtifactPort,
  WebModuleResolutionPort,
  WebModuleResolutionBatch,
} from "./WebModulePorts.js";

const OPERATION = "trace_web_module_imports";
const artifactsSchema = selectedWebScriptArtifactsSchema.extend({
  importMap: z
    .strictObject({
      file: webModuleFileSchema,
      baseUrl: z.string().min(1),
      value: jsonObjectSchema,
    })
    .nullable(),
});
const resolutionBatchSchema = z.strictObject({
  engine: z.strictObject({ id: z.string().min(1), version: z.string().min(1) }),
  resolutions: z.array(webModuleResolutionSchema),
  diagnostics: z.array(z.string()),
  rawResult: jsonObjectSchema,
});
const LIMITATIONS = [
  "Resolution is derived under the selected importer URL and optional import map; it does not establish that the map was installed in the captured page.",
  "Reported source URLs do not establish an inline script's document base. Select importer_url explicitly when that context differs or is unknown.",
  "Captured candidates retain reported capture metadata; their bytes are not reverified by this trace unless selected as the source.",
  "A resolved URL or captured source does not prove loading, execution, UI causality, or module namespace identity. Execution remains unknown.",
  "Only native ES module syntax is resolved. Bundler module IDs, computed imports, workers and non-HTTP(S) importer contexts are outside this trace.",
  "Source-map declarations do not establish retained map bytes or executed original-source coverage.",
  "Selected application code is parsed as data and never executed. The owned resolver executes only REA's trusted stub; its page requests are locally fulfilled or blocked.",
  "Manifest, source and import-map limits are 32 MiB, 16 MiB and 4 MiB. Native resolution has a 20-second deadline; cleanup may extend it. One renderer is requested; no aggregate host memory limit is claimed.",
];

/** Compose verified captures, inert syntax and a replaceable URL resolution engine. */
export class WebModuleTraceService {
  constructor(
    readonly artifacts: WebModuleArtifactPort,
    readonly resolver: WebModuleResolutionPort,
  ) {}

  async trace(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (isAborted(options?.signal))
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = webModuleTraceInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        new AnalysisInputError(
          OPERATION,
          { cause: parsed.error },
          projectInputIssues(parsed.error.issues, rawInput),
        ),
      );
    const input = parsed.data;
    for (const [path, value] of [
      ["manifest_path", input.manifest_path],
      ["import_map.path", input.import_map?.path],
    ] as const)
      if (value !== undefined && !isAbsolute(value))
        return invalid(
          path.split("."),
          "Expected an absolute filesystem path on this host.",
        );
    for (const [path, value] of [
      ["importer_url", input.importer_url],
      ["import_map.base_url", input.import_map?.base_url],
    ] as const)
      if (value !== undefined) {
        const admission = admitContext(value, path.split("."));
        if (!admission.ok) return admission;
      }
    const loaded = await this.artifacts.load(input, options);
    if (!loaded.ok) return loaded;
    const verified = artifactsSchema.safeParse(loaded.value);
    if (!verified.success)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Artifact port returned a malformed source/manifest report.",
        ),
      );
    const data = verified.data;
    if (
      (input.import_map?.path ?? null) !==
        (data.importMap?.file.path ?? null) ||
      (input.import_map?.base_url ?? null) !== (data.importMap?.baseUrl ?? null)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Artifact port changed the selected import-map identity/context.",
        ),
      );
    const bound = validateSelectedWebScript(input, data, OPERATION);
    if (!bound.ok) return bound;
    const selected = bound.value;
    const importerUrl = input.importer_url ?? selected.url;
    const importerAdmission = admitContext(importerUrl, ["importer_url"]);
    if (!importerAdmission.ok) return importerAdmission;
    const syntax = collectWebModuleImports(data.source);
    const literals = syntax.imports
      .filter((reference) => reference.specifier !== null)
      .map((reference) => reference.specifier ?? "");
    let resolution: WebModuleResolutionBatch | null = null;
    if (literals.length > 0) {
      const execution = await this.resolver.resolve(
        {
          importerUrl,
          importMap:
            data.importMap === null
              ? null
              : {
                  baseUrl: data.importMap.baseUrl,
                  value: data.importMap.value,
                },
          specifiers: literals,
        },
        options,
      );
      if (!execution.ok) return execution;
      const report = resolutionBatchSchema.safeParse(execution.value);
      if (!report.success)
        return err(
          new AnalysisOutputError(
            OPERATION,
            "Resolver returned malformed or incomplete native evidence.",
          ),
        );
      resolution = report.data;
      if (resolution.resolutions.length !== literals.length)
        return err(
          new AnalysisOutputError(
            OPERATION,
            "Resolver did not return every selected literal specifier.",
          ),
        );
    }
    if (isAborted(options?.signal))
      return err(new AnalysisCancelledError(OPERATION));
    let literalIndex = 0;
    const imports: WebModuleTraceResult["imports"] = [];
    for (const reference of syntax.imports) {
      let resolved:
        | WebModuleResolution
        | { state: "unknown"; reason: "computed-specifier" };
      if (reference.specifier === null)
        resolved = { state: "unknown", reason: "computed-specifier" };
      else {
        const reported = resolution?.resolutions[literalIndex++];
        if (reported === undefined)
          return err(
            new AnalysisOutputError(
              OPERATION,
              "Resolver omitted a selected literal specifier.",
            ),
          );
        resolved = reported;
      }
      imports.push({
        ...reference,
        resolution: resolved,
        captured_candidates:
          resolved.state === "resolved"
            ? matchCapturedModules(resolved.url, data.manifest.scripts)
            : [],
        execution: "unknown",
      });
    }
    const normalized = webModuleTraceResultSchema.safeParse({
      manifest: capturedWebManifestIdentity(data),
      source: {
        ...data.sourceFile,
        script_index: input.script_index,
        script: selected,
      },
      importer: {
        url: importerUrl,
        basis:
          input.importer_url === undefined
            ? "reported-source-url"
            : "caller-selected",
      },
      import_map:
        data.importMap === null
          ? null
          : { ...data.importMap.file, base_url: data.importMap.baseUrl },
      parser: {
        state: syntax.state,
        diagnostics: syntax.diagnostics,
        location_units: "UTF-16 offsets and columns; one-based lines",
      },
      engine: resolution?.engine ?? null,
      imports,
      diagnostics: resolution?.diagnostics ?? [],
      limitations: LIMITATIONS,
    });
    if (!normalized.success)
      return err(new AnalysisOutputError(OPERATION, normalized.error.message));
    return ok(
      createEvidence(
        {
          path: data.sourceFile.path,
          sha256: data.sourceFile.sha256,
          format: "file",
        },
        {
          id: "rea-web-module-trace",
          name: "REA captured module relationship trace",
          version: "1",
        },
        {
          operation: OPERATION,
          parameters: jsonObjectSchema.parse(input),
          result: normalized.data,
          rawResult: resolution?.rawResult ?? null,
          confidence: "derived",
          authority: "historical-reference",
          limitations: LIMITATIONS,
          locations: [
            { kind: "artifact-path", path: data.sourceFile.path },
            { kind: "artifact-path", path: input.manifest_path },
          ],
          evidenceLinks:
            data.manifest.source_evidence_id === null
              ? []
              : [data.manifest.source_evidence_id],
        },
      ),
    );
  }
}

const admitContext = (
  value: string,
  path: readonly string[],
): Result<null, AnalysisError> => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause: unknown) {
    void cause;
    return invalid(
      path,
      "Expected an absolute context URL. Select importer_url explicitly when the reported source URL is unknown.",
    );
  }
  if (url.username !== "" || url.password !== "")
    return invalid(
      path,
      "Module context URLs must not contain username/password userinfo.",
    );
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return err(
      new AnalysisCapabilityUnavailableError(
        "web-module-resolution",
        OPERATION,
        "unsupported_context_scheme",
        {
          userMessage: `${path.join(".")} ${value} uses unsupported ${url.protocol} context. This trace currently supports HTTP(S) importer/map contexts; select a supported context explicitly when appropriate.`,
        },
      ),
    );
  return ok(null);
};
const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true;
const invalid = (path: readonly string[], message: string) =>
  err(
    new AnalysisInputError(OPERATION, undefined, [
      { path, reason: "invalid_format", message },
    ]),
  );
