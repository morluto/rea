import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  selectedWebScriptArtifactsSchema,
  webArtifactFileSchema,
} from "../domain/webScriptArtifacts.js";
import {
  WEB_SOURCE_MAP_LIMITS,
  webSourceLocationInputSchema,
  webSourceLocationResultSchema,
  webSourceMapReportSchema,
  type WebSourceLocationInput,
  type WebSourceMapReport,
} from "../domain/webSourceLocation.js";
import { webSourceOffset } from "../domain/webSourcePosition.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import {
  capturedWebManifestIdentity,
  validateSelectedWebScript,
} from "./ValidateSelectedWebScript.js";
import type {
  WebSourceLocationArtifactPort,
  WebSourceMapPort,
} from "./WebSourceLocationPorts.js";

const OPERATION = "trace_web_source_location";
const artifactsSchema = selectedWebScriptArtifactsSchema.extend({
  sourceMap: z.strictObject({
    file: webArtifactFileSchema,
    url: z.string().min(1),
    text: z.string(),
  }),
});
const LIMITATIONS = [
  "The source/map pairing and source-map URL context are caller-selected. Deployment authenticity and execution remain unknown.",
  "Capture metadata and its Evidence reference are historical context; this trace independently verifies only the selected manifest, script and map bytes.",
  "Source names and sourceRoot are reported declarations. Resolved URLs are derived by the pinned upstream codec; no original source is fetched or executed.",
  "Embedded source hashes identify the UTF-8 encoding of decoded sourcesContent text, not an independently retained original file. Missing or out-of-range original content positions remain explicit.",
  "Lookup returns all segments at the greatest generated position not greater than the selected point, including earlier lines and generated-only segments. A mapped point does not establish an executed range or UI causality.",
  "Regular maps and inline indexed sections are supported. External section URLs are unsupported; unknown extensions are retained in raw map text and are not interpreted.",
  "Complete evidence has a 4 MiB map, 32 MiB reply, 262144 decoded rows/segments and 64-level section budget. The owned codec has a 20-second deadline, 192 MiB old-generation heap and one V8 worker; cleanup may extend the deadline. V8 heap limits do not establish aggregate RSS limits.",
];

/** Join verified captured bytes with an explicitly selected source-map point. */
export class WebSourceLocationService {
  constructor(
    readonly artifacts: WebSourceLocationArtifactPort,
    readonly decoder: WebSourceMapPort,
  ) {}

  close(): Promise<void> {
    return this.decoder.close?.() ?? Promise.resolve();
  }

  /** Shared CLI/MCP workflow preserves raw declarations and every equal-position match. */
  async trace(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = webSourceLocationInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput, {
          cause: parsed.error,
        }),
      );
    const input = parsed.data;
    const admitted = admitContext(input);
    if (!admitted.ok) return admitted;
    const loaded = await this.artifacts.load(input, options);
    if (!loaded.ok) return loaded;
    const verified = artifactsSchema.safeParse(loaded.value);
    if (!verified.success)
      return invalidOutput(
        "Artifact port returned malformed source/map evidence.",
      );
    const data = verified.data;
    const bound = validateSelectedWebScript(input, data, OPERATION);
    if (!bound.ok) return bound;
    const map = data.sourceMap;
    const pairing = verifyPairing(input, data);
    if (!pairing.ok) return pairing;
    const generatedOffset = pairing.value;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const traced = await this.decoder.trace(
      {
        text: map.text,
        path: map.file.path,
        url: map.url,
        position: input.generated_position,
      },
      options,
    );
    if (!traced.ok) return traced;
    const report = verifyReport(input, map.file.sha256, traced.value);
    if (!report.ok) return report;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const normalized = webSourceLocationResultSchema.safeParse({
      ...report.value,
      manifest: capturedWebManifestIdentity(data),
      source: {
        ...data.sourceFile,
        script_index: input.script_index,
        script: bound.value,
      },
      source_map: { ...map.file, url: map.url, association: "caller-selected" },
      generated_offset: generatedOffset,
      source_authenticity: "unknown",
      execution: "unknown",
      limitations: LIMITATIONS,
    });
    if (!normalized.success) return invalidOutput(normalized.error.message);
    return ok(
      createEvidence(
        {
          path: data.sourceFile.path,
          sha256: data.sourceFile.sha256,
          format: "file",
        },
        {
          id: "rea-web-source-location",
          name: "REA captured source-map point trace",
          version: "1",
        },
        {
          operation: OPERATION,
          parameters: jsonObjectSchema.parse(input),
          result: normalized.data,
          rawResult: { source_map_text: map.text },
          confidence: "derived",
          authority: "historical-reference",
          limitations: LIMITATIONS,
          locations: [
            data.sourceFile.path,
            data.manifestFile.path,
            map.file.path,
          ].map((path) => ({ kind: "artifact-path", path })),
          evidenceLinks:
            data.manifest.source_evidence_id === null
              ? []
              : [data.manifest.source_evidence_id],
        },
      ),
    );
  }
}
const invalidOutput = (message: string): Result<never, AnalysisError> =>
  err(new AnalysisOutputError(OPERATION, message));
const invalid = (
  path: readonly string[],
  message: string,
): Result<never, AnalysisError> =>
  err(
    new AnalysisInputError(OPERATION, undefined, [
      { path, reason: "invalid_format", message },
    ]),
  );

const admitContext = (
  input: WebSourceLocationInput,
): Result<null, AnalysisError> => {
  for (const [path, value] of [
    ["manifest_path", input.manifest_path],
    ["source_map.path", input.source_map.path],
  ] as const)
    if (!isAbsolute(value))
      return invalid(
        path.split("."),
        "Expected an absolute filesystem path on this host.",
      );
  if (!URL.canParse(input.source_map.url))
    return invalid(
      ["source_map", "url"],
      "Expected an absolute source-map URL context. Select its deployment context explicitly; no URL is fetched.",
    );
  return ok(null);
};

const verifyPairing = (
  input: WebSourceLocationInput,
  data: z.output<typeof artifactsSchema>,
): Result<number, AnalysisError> => {
  const map = data.sourceMap;
  if (
    map.file.path !== input.source_map.path ||
    map.url !== input.source_map.url ||
    Buffer.byteLength(map.text) !== map.file.bytes ||
    createHash("sha256").update(map.text).digest("hex") !== map.file.sha256 ||
    map.file.bytes > WEB_SOURCE_MAP_LIMITS.mapBytes
  )
    return invalidOutput(
      "Artifact port changed the selected source-map byte identity or URL context.",
    );
  const generatedOffset = webSourceOffset(
    data.source,
    input.generated_position,
  );
  if (generatedOffset === undefined)
    return invalid(
      ["generated_position"],
      "Selected generated position is outside the retained script text (one-based lines; zero-based UTF-16 columns).",
    );
  return ok(generatedOffset);
};

const verifyReport = (
  input: WebSourceLocationInput,
  sha256: string,
  value: unknown,
): Result<WebSourceMapReport, AnalysisError> => {
  const report = webSourceMapReportSchema.safeParse(value);
  if (!report.success)
    return invalidOutput(
      "Codec port returned malformed source-map point evidence.",
    );
  if (
    report.data.source_map_sha256 !== sha256 ||
    report.data.url_context !== input.source_map.url ||
    report.data.lookup.requested.line !== input.generated_position.line ||
    report.data.lookup.requested.column !== input.generated_position.column
  )
    return invalidOutput(
      "Codec port changed the selected map, URL context or generated point.",
    );
  return ok(report.data);
};
