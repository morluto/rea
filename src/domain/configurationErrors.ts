import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";

/** One rejected configuration setting and the constraint it failed. */
export interface ConfigurationSettingIssue {
  readonly setting: string;
  readonly constraint: string;
}

/** Rejected settings retained for diagnostics; their values are not. */
export interface ConfigurationErrorOptions extends AnalysisErrorOptions {
  readonly settings?: readonly ConfigurationSettingIssue[];
  /** Producer-owned recovery when this setting can be repaired in a running session. */
  readonly remediationAction?: string;
}

/** Runtime configuration could not be parsed safely. */
export class ConfigurationError extends AnalysisError {
  readonly _tag = "ConfigurationError";
  readonly settings: readonly ConfigurationSettingIssue[];
  readonly remediationAction: string | undefined;
  constructor(message: string, options?: ConfigurationErrorOptions) {
    super(message, options);
    this.remediationAction = options?.remediationAction;
    this.settings = (options?.settings ?? []).map(
      ({ setting, constraint }) => ({ setting, constraint }),
    );
  }
}

/** No app or binary session exists for an analysis request. */
export class NoBinaryOpenError extends AnalysisError {
  readonly _tag = "NoBinaryOpenError";
  constructor() {
    super(
      "No app is open. Ask the user which app to investigate, then call open_binary with its local path.",
    );
  }
}

/** Additional constraints identified while admitting a filesystem target. */
export interface BinaryTargetErrorOptions extends AnalysisErrorOptions {
  readonly constraint?:
    | "directory_requires_file"
    | "wasm_requires_static_inspection"
    | "file_format_rejected"
    | "load_selection_rejected";
}

/** A supplied target path could not be safely opened as a supported app or binary. */
export class BinaryTargetError extends AnalysisError {
  readonly _tag = "BinaryTargetError";
  readonly constraint: BinaryTargetErrorOptions["constraint"];
  /** The OS read-permission code of the cause, when the host denied access. */
  readonly systemCode: "EACCES" | "EPERM" | undefined;
  constructor(
    readonly path: string,
    readonly reason: string,
    options?: BinaryTargetErrorOptions,
  ) {
    super(`Cannot open artifact: ${reason}`, options);
    this.constraint = options?.constraint;
    this.systemCode = readPermissionCode(options?.cause);
  }
}

const readPermissionCode = (cause: unknown): "EACCES" | "EPERM" | undefined => {
  const code: unknown =
    cause instanceof Error ? Reflect.get(cause, "code") : undefined;
  return code === "EACCES" || code === "EPERM" ? code : undefined;
};
