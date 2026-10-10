import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Architecture guards for the strict-identity / best-effort-inference split.
// - Evidence ordering must be locale-independent (ICU varies by host), so
//   src/domain orders with compareUnicodeCodePoints, never localeCompare.
// - Composite dedup keys must not NUL-join variable-length or free-form
//   MIDDLE fields: ["a\0b"] collapses with ["a", "b"] and drops a finding.
//   compositeKey (JSON tuple) is the single owner for composite keys.
// - Transparent wrappers unwrap in exactly one place
//   (javascriptAstValues.unwrapJavaScriptExpression); direct isTS* unwrapping
//   elsewhere drifts (the `satisfies` class of bug).
// - AST walks go through traverseJavaScriptAst/childNodes: bespoke
//   Object.values walkers diverge on loc/comment fields and overflow the
//   stack on deep generated chains.

const root = fileURLToPath(new URL("../../", import.meta.url));

const listFiles = async (dir) => {
  const output = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...(await listFiles(path)));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".fixture.ts")
    )
      output.push(path);
  }
  return output;
};

const stripComments = (content) =>
  content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "");

const sources = await listFiles(join(root, "src"));
const files = await Promise.all(
  sources.map(async (path) => ({
    path: relative(root, path).split(sep).join("/"),
    content: stripComments(await readFile(path, "utf8")),
  })),
);
const inDir = (dir) => files.filter((file) => file.path.startsWith(dir));

const failures = [];
const check = (label, selected, pattern, allow = []) => {
  const offenders = selected.filter(
    (file) => pattern.test(file.content) && !allow.includes(file.path),
  );
  if (offenders.length > 0)
    failures.push(
      `${label}:\n${offenders.map((file) => `  ${file.path}`).join("\n")}`,
    );
};

check(
  "src/domain uses localeCompare (use compareUnicodeCodePoints)",
  inDir("src/domain/"),
  /\.localeCompare\(/,
);

check(
  "NUL-joined list key (use compositeKey)",
  files,
  /\.join\(["']\\0["']\)/,
  [
    // Sorted pair of constrained trace IDs; documented in plan.
    "src/domain/process/processTraceSpecification.ts",
  ],
);

check(
  "direct transparent-wrapper unwrap outside javascriptAstValues (use unwrapJavaScriptExpression)",
  files,
  /isTSAsExpression|isTSSatisfiesExpression|isTSNonNullExpression|isTSTypeAssertion|isTSInstantiationExpression|isParenthesizedExpression/,
  ["src/domain/javascript/javascriptAstValues.ts"],
);

check(
  "bespoke AST child walker (use traverseJavaScriptAst/childNodes)",
  files,
  /VISITOR_KEYS/,
  ["src/domain/javascript/javascriptSemanticTraversal.ts"],
);

// Fixed-arity backtick keys audited 2026-10-10: every prefix field is NUL-free
// (hex digests, file paths, enums, numbers, or compositeKey JSON which escapes
// NUL), with free-form source strings only in final position. New backtick-\0
// keys must either meet that shape (and extend this list with justification)
// or use compositeKey.
check(
  "new backtick-NUL composite key (audit against the rule above)",
  files,
  /`[^`\n]*\\0/,
  [
    "src/application/javascript/ElectronBoundaryAnalysis.ts",
    "src/application/javascript/ElectronBoundaryGraphContext.ts",
    "src/application/javascript/JavaScriptArtifactGraphContext.ts",
    "src/browser/CdpCaptureCompleteness.ts",
    "src/browser/CdpCaptureEventHandlers.ts",
    "src/browser/CdpPageCapture.ts",
    "src/browser/WebSourceMapFetcher.ts",
    "src/domain/javascript/electronStaticAnalysisBrowser.ts",
    "src/domain/javascript/electronStaticAnalysisIpc.ts",
    "src/domain/javascript/javascriptApplicationChangeGraph.ts",
    "src/domain/javascript/javascriptApplicationVersionItems.ts",
    "src/domain/javascript/javascriptApplicationVersionKeys.ts",
    "src/domain/javascript/javascriptExportShapeSelection.ts",
    "src/domain/javascript/javascriptFeatureSeed.ts",
    "src/domain/javascript/javascriptFeatureTraversal.ts",
    "src/domain/javascript/javascriptNativeHandoff.ts",
    "src/domain/javascript/javascriptRuntimeReconciliationMatching.ts",
    "src/domain/javascript/javascriptRuntimeReconciliationSchemas.ts",
    "src/domain/javascript/javascriptSemanticQuery.ts",
    "src/domain/javascript/javascriptStaticAnalysisBundler.ts",
    "src/domain/javascript/javascriptStaticAnalysisCalls.ts",
    "src/domain/javascript/javascriptStaticAnalysisFindings.ts",
    "src/domain/localPath.ts",
    "src/domain/process/processTraceEvaluation.ts",
    "src/domain/process/processTraceSpecification.ts",
    "src/domain/unicodeCodePointOrder.ts",
    "src/domain/webBundleAnalyzerInspection.ts",
  ],
);

if (failures.length > 0) {
  console.error(`Architecture guards failed:\n\n${failures.join("\n\n")}\n`);
  process.exit(1);
}
console.log(`Architecture guards passed across ${files.length} source files.`);
