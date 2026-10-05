import { resolve } from "node:path";
import { z } from "zod";

import {
  AnalysisInputError,
  AnalysisProtocolError,
  type AnalysisError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { reconcileJavaScriptRuntime } from "../domain/javascriptRuntimeReconciliation.js";
import { reconcileJavaScriptRuntimeInputSchema } from "../domain/javascriptRuntimeReconciliationSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import { createJavaScriptRuntimeReconciliationEvidence } from "./JavaScriptRuntimeReconciliationEvidence.js";

const OPERATION = "reconcile_javascript_runtime" as const;

/** Derive a combined JAG from verified static and passive-runtime Evidence. */
export const reconcileJavaScriptRuntimeEvidence = (
  rawInput: unknown,
): Result<Evidence, AnalysisError> => {
  const parsed = reconcileJavaScriptRuntimeInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(
        OPERATION,
        undefined,
        projectInputIssues(parsed.error.issues, rawInput),
      ),
    );
  return reconcileJavaScriptRuntimeEvidenceValidated(parsed.data);
};

/** Reconcile input already parsed by a trusted adapter boundary. */
export const reconcileJavaScriptRuntimeEvidenceValidated = (
  parsedInput: z.output<typeof reconcileJavaScriptRuntimeInputSchema>,
): Result<Evidence, AnalysisError> => {
  try {
    const input = reconcileJavaScriptRuntimeInputSchema.parse(
      normalizeRuntimeMappingRoots(parsedInput),
    );
    const result = reconcileJavaScriptRuntime(input);
    return ok(createJavaScriptRuntimeReconciliationEvidence(input, result));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(
        new AnalysisInputError(
          OPERATION,
          undefined,
          projectInputIssues(cause.issues, parsedInput),
        ),
      );
    if (
      cause instanceof TypeError &&
      SAFE_RECONCILIATION_INPUT_CONSTRAINTS.has(cause.message)
    )
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          { path: [], reason: "invalid_value", message: cause.message },
        ]),
      );
    return err(
      new AnalysisProtocolError(
        "JavaScript runtime reconciliation produced an invalid result",
        { cause },
      ),
    );
  }
};

const normalizeRuntimeMappingRoots = (
  input: z.output<typeof reconcileJavaScriptRuntimeInputSchema>,
): z.output<typeof reconcileJavaScriptRuntimeInputSchema> => ({
  ...input,
  static_layers: input.static_layers.map((layer) => ({
    ...layer,
    runtime_mappings: layer.runtime_mappings.map((mapping) =>
      mapping.kind === "file-root"
        ? {
            ...mapping,
            root: isPortableAbsolutePath(mapping.root)
              ? mapping.root
              : resolve(mapping.root),
          }
        : mapping,
    ),
  })),
});

const isPortableAbsolutePath = (path: string): boolean =>
  path.startsWith("/") ||
  /^[a-z]:[\\/]/iu.test(path) ||
  /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(path);

const SAFE_RECONCILIATION_INPUT_CONSTRAINTS = new Set([
  "Evidence semantic identifier does not match its record",
  "JavaScript application Evidence subject disagrees with its result",
  "Runtime reconciliation requires inspect_web_page, inspect_electron_page, observe_javascript_runtime, or capture_electron_scenario Evidence",
  "Runtime Evidence target or declared role disagrees with its result",
  "Runtime Evidence contains an invalid builtin location",
  "Runtime Evidence target disagrees with its captured result",
  "Browser Evidence target is outside its recorded origin scope",
  "Runtime Evidence contains source without source-capture selection",
  "Active Electron Evidence application path disagrees with its configured root",
  ...[
    "inspect_web_page",
    "inspect_electron_page",
    "observe_javascript_runtime",
    "capture_electron_scenario",
  ].map(
    (operation) =>
      `Evidence does not match the supported ${operation} contract`,
  ),
]);
