import { z } from "zod";

/** Supported managed-runtime bytecode families. */
export const bytecodeFamilySchema = z.enum(["jvm", "python"]);
export type BytecodeFamily = z.infer<typeof bytecodeFamilySchema>;

/** Classification of bytecode provenance. */
export const bytecodeProvenanceSchema = z.enum([
  "application",
  "generated",
  "vendored",
  "bundled",
  "standard_library",
]);
export type BytecodeProvenance = z.infer<typeof bytecodeProvenanceSchema>;

/** A bytecode symbol discovered through static analysis. */
export const bytecodeSymbolSchema = z.strictObject({
  /** Fully qualified name. */
  name: z.string().min(1),
  /** Raw bytecode location or offset. */
  raw_location: z.string().min(1),
  /** Normalized symbol type. */
  kind: z.enum([
    "class",
    "interface",
    "method",
    "field",
    "function",
    "module",
    "variable",
  ]),
  /** Bytecode version if known. */
  bytecode_version: z.number().int().nullable(),
  /** Provenance classification. */
  provenance: bytecodeProvenanceSchema,
  /** Whether the symbol is accessible (public). */
  is_public: z.boolean().default(false),
});
export type BytecodeSymbol = z.infer<typeof bytecodeSymbolSchema>;

/** A discovered bytecode artifact (class file, wheel, etc). */
export const bytecodeArtifactSchema = z.strictObject({
  /** Artifact path relative to the analysis root. */
  path: z.string().min(1),
  /** Bytecode family. */
  family: bytecodeFamilySchema,
  /** Artifact format. */
  format: z.enum(["class", "jar", "war", "ear", "pyc", "pyo", "whl", "zipapp"]),
  /** Size in bytes. */
  size: z.number().int().nonnegative(),
  /** SHA-256 digest. */
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  /** Discovered symbols. */
  symbols: z.array(bytecodeSymbolSchema).default([]),
  /** Whether this is a standard library artifact. */
  is_standard_library: z.boolean().default(false),
  /** Whether this is a generated artifact. */
  is_generated: z.boolean().default(false),
  /** Whether this is a vendored artifact. */
  is_vendored: z.boolean().default(false),
});
export type BytecodeArtifact = z.infer<typeof bytecodeArtifactSchema>;

/** Static bytecode analysis result. */
export const bytecodeAnalysisSchema = z.strictObject({
  /** Bytecode family. */
  family: bytecodeFamilySchema,
  /** All discovered artifacts. */
  artifacts: z.array(bytecodeArtifactSchema).min(0).max(10_000),
  /** Total symbols across all artifacts. */
  total_symbols: z.number().int().nonnegative(),
  /** Symbols classified as application code. */
  application_symbols: z.number().int().nonnegative(),
  /** Symbols classified as generated code. */
  generated_symbols: z.number().int().nonnegative(),
  /** Symbols classified as vendored code. */
  vendored_symbols: z.number().int().nonnegative(),
  /** Symbols classified as standard library. */
  standard_library_symbols: z.number().int().nonnegative(),
});
export type BytecodeAnalysis = z.infer<typeof bytecodeAnalysisSchema>;

/** Detect bytecode family from file extension. */
export function detectBytecodeFamily(path: string): BytecodeFamily | null {
  const lower = path.toLowerCase();
  if (
    lower.endsWith(".class") ||
    lower.endsWith(".jar") ||
    lower.endsWith(".war") ||
    lower.endsWith(".ear")
  ) {
    return "jvm";
  }
  if (
    lower.endsWith(".pyc") ||
    lower.endsWith(".pyo") ||
    lower.endsWith(".whl") ||
    lower.endsWith(".pyz") ||
    lower.endsWith(".zipapp")
  ) {
    return "python";
  }
  return null;
}

/** Detect artifact format from file path. */
export function detectArtifactFormat(
  path: string,
): `class` | `jar` | `war` | `ear` | `pyc` | `pyo` | `whl` | `zipapp` | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".class")) return "class";
  if (lower.endsWith(".jar")) return "jar";
  if (lower.endsWith(".war")) return "war";
  if (lower.endsWith(".ear")) return "ear";
  if (lower.endsWith(".pyc")) return "pyc";
  if (lower.endsWith(".pyo")) return "pyo";
  if (lower.endsWith(".whl")) return "whl";
  if (lower.endsWith(".pyz") || lower.endsWith(".zipapp")) return "zipapp";
  return null;
}

const STANDARD_LIBRARY_PATH_MARKERS = [
  "/stdlib/",
  "/site-packages/",
  "java/",
  "javax/",
  "sun/",
];
const STANDARD_LIBRARY_SYMBOL_MARKERS = ["java.", "javax.", "sun.", "__"];
const GENERATED_PATH_MARKERS = [
  "/generated/",
  "_generated",
  "/build/",
  "/target/",
  "/dist-packages/",
  "/__pycache__/",
];
const GENERATED_SYMBOL_MARKERS = ["Generated", "_generated"];
const VENDORED_PATH_MARKERS = [
  "/vendor/",
  "/vendored/",
  "/third_party/",
  "/3rdparty/",
  "/node_modules/",
];
const BUNDLED_PATH_MARKERS = ["/bundle/", "/bundled/", ".jar!", ".war!"];

const includesAny = (value: string, markers: readonly string[]): boolean =>
  markers.some((marker) => value.includes(marker));
const startsWithAny = (value: string, markers: readonly string[]): boolean =>
  markers.some((marker) => value.startsWith(marker));

/** Classify bytecode symbol provenance. */
export function classifyProvenance(
  path: string,
  symbolName: string,
): BytecodeProvenance {
  const lower = path.toLowerCase();
  if (
    includesAny(lower, STANDARD_LIBRARY_PATH_MARKERS) ||
    startsWithAny(symbolName, STANDARD_LIBRARY_SYMBOL_MARKERS)
  )
    return "standard_library";
  if (
    includesAny(lower, GENERATED_PATH_MARKERS) ||
    includesAny(symbolName, GENERATED_SYMBOL_MARKERS)
  )
    return "generated";
  if (includesAny(lower, VENDORED_PATH_MARKERS)) return "vendored";
  if (includesAny(lower, BUNDLED_PATH_MARKERS)) return "bundled";
  return "application";
}

/** Analyze a set of bytecode artifacts and produce a summary. */
export function analyzeBytecodeArtifacts(
  artifacts: readonly BytecodeArtifact[],
  family: BytecodeFamily,
): BytecodeAnalysis {
  const applicationSymbols = artifacts
    .flatMap((a) => a.symbols)
    .filter((s) => s.provenance === "application").length;
  const generatedSymbols = artifacts
    .flatMap((a) => a.symbols)
    .filter((s) => s.provenance === "generated").length;
  const vendoredSymbols = artifacts
    .flatMap((a) => a.symbols)
    .filter((s) => s.provenance === "vendored").length;
  const standardLibrarySymbols = artifacts
    .flatMap((a) => a.symbols)
    .filter((s) => s.provenance === "standard_library").length;

  return {
    family,
    artifacts: artifacts.slice(0, 10_000),
    total_symbols: artifacts.reduce((sum, a) => sum + a.symbols.length, 0),
    application_symbols: applicationSymbols,
    generated_symbols: generatedSymbols,
    vendored_symbols: vendoredSymbols,
    standard_library_symbols: standardLibrarySymbols,
  };
}
