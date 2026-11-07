/**
 * Top-level facts read from a compiled `AndroidManifest.xml`.
 *
 * `null` means the attribute was not declared. A declared attribute whose
 * value is not a supported literal (for example a resource reference) is
 * listed in `unresolved_attributes` and left `null`; it is never guessed.
 */
export interface AndroidManifestFacts {
  readonly package: string | null;
  /** `versionCode`: the low 32 bits of the effective version. */
  readonly version_code: number | null;
  /** `versionCodeMajor` (API 28+): the high 32 bits; `null` when not declared. */
  readonly version_code_major: number | null;
  readonly version_name: string | null;
  /** `split` on `<manifest>`: absent for a base or standalone APK. */
  readonly split: string | null;
  /** `configForSplit` on `<manifest>`: the split this one configures. */
  readonly config_for_split: string | null;
  readonly is_feature_split: boolean | null;
  readonly isolated_splits: boolean | null;
  readonly target_sandbox_version: number | null;
  /** `isSplitRequired` as declared on `<application>`. */
  readonly is_split_required: boolean | null;
  readonly min_sdk_version: number | null;
  readonly target_sdk_version: number | null;
  /**
   * Attributes that were declared but whose value is not a literal of the
   * expected type (a resource reference, or an integer where a string is
   * required), as `<element>@<attribute>`, for example `manifest@split`. The
   * matching field above is `null`; absence and uncertainty stay distinct.
   */
  readonly unresolved_attributes: readonly string[];
}
