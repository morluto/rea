import type { AnalysisControlLimit } from "../domain/analysisSettings.js";
import {
  DEFAULT_GHIDRA_C_PARENTHESIS_DEPTH,
  DEFAULT_GHIDRA_SIGNATURE_MAX_UTF16,
  DEFAULT_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16,
  MAXIMUM_GHIDRA_C_PARENTHESIS_DEPTH,
  MAXIMUM_GHIDRA_SIGNATURE_MAX_UTF16,
  MAXIMUM_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16,
  MINIMUM_GHIDRA_C_PARENTHESIS_DEPTH,
  MINIMUM_GHIDRA_C_TEXT_UTF16,
} from "../domain/analysisResourceLimits.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

/**
 * The launch controls that bound Ghidra's uncancellable C parser. The bridge
 * receives them in its session descriptor when it starts and keeps them for
 * its lifetime, so a changed value needs a new REA process.
 */
export const GHIDRA_C_PARSER_CONTROLS = {
  signatureMaxUtf16: {
    environment: "REA_GHIDRA_SIGNATURE_MAX_UTF16",
    defaultValue: DEFAULT_GHIDRA_SIGNATURE_MAX_UTF16,
    minimum: MINIMUM_GHIDRA_C_TEXT_UTF16,
    maximum: MAXIMUM_GHIDRA_SIGNATURE_MAX_UTF16,
  },
  declarationsMaxUtf16: {
    environment: "REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16",
    defaultValue: DEFAULT_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16,
    minimum: MINIMUM_GHIDRA_C_TEXT_UTF16,
    maximum: MAXIMUM_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16,
  },
  parenthesisDepth: {
    environment: "REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH",
    defaultValue: DEFAULT_GHIDRA_C_PARENTHESIS_DEPTH,
    minimum: MINIMUM_GHIDRA_C_PARENTHESIS_DEPTH,
    maximum: MAXIMUM_GHIDRA_C_PARENTHESIS_DEPTH,
  },
} as const;

/** One of the three C parser controls. */
export type GhidraCParserControl = keyof typeof GHIDRA_C_PARSER_CONTROLS;

const controlSchema = (control: GhidraCParserControl) => {
  const { minimum, maximum } = GHIDRA_C_PARSER_CONTROLS[control];
  return positiveDecimalIntegerSchema(
    minimum,
    maximum,
    `must be a decimal integer from ${String(minimum)} to ${String(maximum)}`,
  ).optional();
};

/** Environment schemas; an absent variable keeps the control's default. */
export const ghidraCParserEnvironmentSchemas = {
  REA_GHIDRA_SIGNATURE_MAX_UTF16: controlSchema("signatureMaxUtf16"),
  REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16: controlSchema("declarationsMaxUtf16"),
  REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH: controlSchema("parenthesisDepth"),
} as const;

/** An effective control value and whether the launch environment set it. */
export interface GhidraCParserLimit {
  readonly value: number;
  readonly source: "default" | "environment";
}

/** The effective values of the three controls for one REA process. */
export type GhidraCParserLimits = Readonly<
  Record<GhidraCParserControl, GhidraCParserLimit>
>;

const selected = (
  control: GhidraCParserControl,
  value: number | undefined,
): GhidraCParserLimit =>
  value === undefined
    ? {
        value: GHIDRA_C_PARSER_CONTROLS[control].defaultValue,
        source: "default",
      }
    : { value, source: "environment" };

/** Resolve the controls from parsed environment values. */
export const ghidraCParserLimitsFrom = (environment: {
  readonly REA_GHIDRA_SIGNATURE_MAX_UTF16?: number | undefined;
  readonly REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16?: number | undefined;
  readonly REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH?: number | undefined;
}): GhidraCParserLimits => ({
  signatureMaxUtf16: selected(
    "signatureMaxUtf16",
    environment.REA_GHIDRA_SIGNATURE_MAX_UTF16,
  ),
  declarationsMaxUtf16: selected(
    "declarationsMaxUtf16",
    environment.REA_GHIDRA_TYPE_DECLARATIONS_MAX_UTF16,
  ),
  parenthesisDepth: selected(
    "parenthesisDepth",
    environment.REA_GHIDRA_C_MAX_PARENTHESIS_DEPTH,
  ),
});

/** The limits of a process whose environment sets none of the controls. */
export const DEFAULT_GHIDRA_C_PARSER_LIMITS: GhidraCParserLimits =
  ghidraCParserLimitsFrom({});

/** The limit facts a refusal binds for one control. */
export const ghidraCParserControlLimit = (
  control: GhidraCParserControl,
  limit: GhidraCParserLimit,
): AnalysisControlLimit => {
  const definition = GHIDRA_C_PARSER_CONTROLS[control];
  return {
    control_kind: "environment",
    environment: definition.environment,
    effective_value: limit.value,
    unit: "count",
    minimum: definition.minimum,
    maximum: definition.maximum,
    default_value: definition.defaultValue,
    applies_at: "next_startup",
  };
};
