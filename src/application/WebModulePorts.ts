import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Result } from "../domain/result.js";
import type {
  WebModuleFile,
  WebModuleResolution,
  WebModuleTraceInput,
} from "../domain/webModuleTrace.js";
import type { SelectedWebScriptArtifacts } from "../domain/webScriptArtifacts.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";

type JsonObject = Record<string, JsonValue>;

/** Verified selected source and capture metadata; provider protocols stay outside. */
export interface WebModuleArtifacts extends SelectedWebScriptArtifacts {
  readonly importMap: {
    readonly file: WebModuleFile;
    readonly baseUrl: string;
    readonly value: JsonObject;
  } | null;
}

/** Read selected local artifacts without refetching website assets. */
export interface WebModuleArtifactPort {
  load(
    input: WebModuleTraceInput,
    options?: ExecutionOptions,
  ): Promise<Result<WebModuleArtifacts, AnalysisError>>;
}

/** Resolve literal specifiers in a selected URL/map context without executing the selected application. */
export interface WebModuleResolutionBatch {
  readonly engine: { readonly id: string; readonly version: string };
  readonly resolutions: readonly WebModuleResolution[];
  readonly diagnostics: readonly string[];
  readonly rawResult: JsonObject;
}

/** Replaceable native resolution engine, with no provider protocol in callers. */
export interface WebModuleResolutionPort {
  resolve(
    input: {
      readonly importerUrl: string;
      readonly importMap: {
        readonly baseUrl: string;
        readonly value: JsonObject;
      } | null;
      readonly specifiers: readonly string[];
    },
    options?: ExecutionOptions,
  ): Promise<Result<WebModuleResolutionBatch, AnalysisError>>;
}
