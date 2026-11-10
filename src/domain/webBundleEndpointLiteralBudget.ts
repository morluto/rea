/** Literal path/URL candidates retained per script when the setting is unset. */
export const WEB_BUNDLE_ENDPOINT_LITERAL_SETTING =
  "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES" as const;
/** Runtime id accepted by `update_analysis_settings`. The environment name seeds it. */
export const WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID =
  "web.bundle_endpoint_literal_candidates" as const;
export const DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES = 1024;
/** Zero retains nothing, so it is not a candidate budget. */
export const MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES = 1;
/**
 * Largest configurable inventory. 4096 is an REA policy ceiling so this
 * optional list cannot by itself fill the worker result budget. It does not
 * raise that budget.
 */
export const MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES = 4096;

export const WEB_BUNDLE_ENDPOINT_LITERAL_CODE =
  "web_bundle_endpoint_literal_candidates" as const;

/** Effective per-script ceiling and where that value came from. */
export interface WebBundleEndpointLiteralAdmission {
  readonly maximumCount: number;
  readonly source: "default" | "setting" | "runtime";
}

export const DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_ADMISSION: WebBundleEndpointLiteralAdmission =
  {
    maximumCount: DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
    source: "default",
  };

/** Structured omission when unique literal candidates exceed the effective ceiling. */
export interface WebBundleEndpointLiteralLimit {
  readonly coverage: "partial";
  readonly code: typeof WEB_BUNDLE_ENDPOINT_LITERAL_CODE;
  readonly setting: typeof WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID;
  readonly admitted_count: number;
  readonly omitted_count: number;
  readonly maximum_count: number;
  readonly source: "default" | "setting" | "runtime";
  readonly default_count: number;
  readonly floor_count: number;
  readonly maximum_setting_count: number;
  readonly rea_restart_required: false;
}

export const webBundleEndpointLiteralLimit = (
  admission: WebBundleEndpointLiteralAdmission,
  admittedCount: number,
  omittedCount: number,
): WebBundleEndpointLiteralLimit | undefined =>
  omittedCount === 0
    ? undefined
    : {
        coverage: "partial",
        code: WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
        setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
        admitted_count: admittedCount,
        omitted_count: omittedCount,
        maximum_count: admission.maximumCount,
        source: admission.source,
        default_count: DEFAULT_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        floor_count: MINIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        maximum_setting_count: MAXIMUM_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES,
        rea_restart_required: false,
      };

/** Name the effective ceiling, its source, the allowed range, and the runtime update. */
export const webBundleEndpointLiteralLimitMessage = (
  limit: WebBundleEndpointLiteralLimit,
): string =>
  [
    `The effective ${limit.setting} value is ${String(limit.maximum_count)} candidates (source ${limit.source}; default ${String(limit.default_count)}, floor ${String(limit.floor_count)}, maximum ${String(limit.maximum_setting_count)}).`,
    `Retained ${String(limit.admitted_count)} literal endpoint candidates and omitted ${String(limit.omitted_count)} further unique literals.`,
    `On MCP, call update_analysis_settings with setting ${limit.setting}, action set, and a value from ${String(limit.floor_count)} to ${String(limit.maximum_setting_count)}, then retry the original request. It applies to the next analysis without restarting REA. For CLI or future REA processes, set ${WEB_BUNDLE_ENDPOINT_LITERAL_SETTING} in the launch environment.`,
    "This setting does not raise the worker result budget.",
  ].join(" ");
