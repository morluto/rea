import type { DecompileDirectoryFunctionRecord } from "../../contracts/decompileDirectory.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type { ExportIdentity } from "./exportTree.js";

export interface FunctionBodyFact {
  readonly available: false;
  readonly reason: string;
}

export interface FunctionBodyRanges {
  readonly available: true;
  readonly ranges: readonly { readonly start: string; readonly end: string }[];
  readonly non_contiguous: boolean;
}

export type FunctionBody = FunctionBodyFact | FunctionBodyRanges;

/**
 * Provider-reported pseudocode language, representation, and production source
 * when the observation retained them. Null means the fact was not established;
 * this owner does not invent a language from the target or file extension.
 */
export interface PseudocodeExportFacts {
  readonly language: string | null;
  readonly representation: string | null;
  readonly source: string | null;
}

/** Line-comment header plus the provider text. A block comment would close early inside pseudocode. */
export const functionFileText = (input: {
  readonly procedure: {
    readonly address: string;
    readonly name: string | null;
  };
  readonly body: FunctionBody;
  readonly identity: ExportIdentity;
  readonly limitations: readonly string[];
  readonly pseudocode: string;
  readonly facts?: PseudocodeExportFacts;
}): string => {
  const facts = input.facts ?? UNAVAILABLE_FACTS;
  const lines = [
    "// rea decompile_all",
    `// name: ${headerValue(input.procedure.name ?? "")}`,
    `// address: ${headerValue(input.procedure.address)}`,
    ...bodyLines(input.body),
    `// provider: ${headerValue(providerLine(input.identity))}`,
    `// analysis_profile: ${input.identity.analysisProfileDigest ?? "unavailable"}`,
    ...limitationLines(input.limitations),
    "// pseudocode: provider-specific; not original source",
    `// language: ${factHeader(facts.language)}`,
    `// representation: ${factHeader(facts.representation)}`,
    `// source: ${factHeader(facts.source)}`,
    "// path_extension: .c; export path spelling only — does not establish C syntax",
  ];
  return `${lines.join("\n")}\n\n${input.pseudocode}`;
};

export const bodyRecord = (
  body: FunctionBody,
): DecompileDirectoryFunctionRecord["body"] =>
  body.available
    ? {
        available: true,
        ranges: body.ranges.map((range) => ({
          start: range.start,
          end: range.end,
        })),
        non_contiguous: body.non_contiguous,
      }
    : { available: false, reason: body.reason };

/**
 * Read language, representation, and production-source facts the observation
 * already retained. Values must be non-empty strings; unknown shapes stay null.
 */
export const pseudocodeExportFacts = (input: {
  readonly rawResult: JsonValue | null;
}): PseudocodeExportFacts => {
  const raw = input.rawResult;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return UNAVAILABLE_FACTS;
  return {
    language: optionalFact(raw.language),
    representation: optionalFact(raw.representation),
    source: sourceFact(raw.source),
  };
};

/** Optional journal/index fields for established facts only. */
export const establishedPseudocodeFields = (
  facts: PseudocodeExportFacts,
): {
  readonly language?: string;
  readonly representation?: string;
  readonly source?: string;
} => ({
  ...(facts.language === null ? {} : { language: facts.language }),
  ...(facts.representation === null
    ? {}
    : { representation: facts.representation }),
  ...(facts.source === null ? {} : { source: facts.source }),
});

const UNAVAILABLE_FACTS: PseudocodeExportFacts = {
  language: null,
  representation: null,
  source: null,
};

const bodyLines = (body: FunctionBody): readonly string[] =>
  body.available
    ? [
        "// body: available",
        ...body.ranges.map(
          (range) =>
            `// range: ${headerValue(range.start)}-${headerValue(range.end)} inclusive`,
        ),
        `// non_contiguous: ${body.non_contiguous ? "true" : "false"}`,
      ]
    : ["// body: unavailable", `// body_reason: ${headerValue(body.reason)}`];

const limitationLines = (limitations: readonly string[]): readonly string[] => {
  const joined = limitations
    .map((limitation) => headerValue(limitation))
    .filter((limitation) => limitation.length > 0)
    .join("; ");
  if (joined.length <= 4_000)
    return [`// limitations: ${joined.length === 0 ? "none" : joined}`];
  return [
    `// limitations: ${joined.slice(0, 4_000)}`,
    "// limitations_truncated: true; decompile-index.json keeps the complete list",
  ];
};

const providerLine = (identity: ExportIdentity): string =>
  `${identity.provider.name} ${identity.provider.version ?? "unknown"} (${identity.provider.id})`;

const factHeader = (value: string | null): string =>
  value === null ? "unavailable" : headerValue(value);

const optionalFact = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const sourceFact = (value: unknown): string | null => {
  if (typeof value === "string") return optionalFact(value);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  return "kind" in value ? optionalFact(value.kind) : null;
};

/** Keep a provider string on one header line without control characters. */
const headerValue = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 2_000);
